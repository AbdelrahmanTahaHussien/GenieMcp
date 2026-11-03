/**
 * react-analyzer.ts
 *
 * Per-file analyzer for a React app's source: JavaScript, TypeScript, JSX and
 * TSX. Detects React components (functions/arrows that return JSX), plain
 * functions (hooks, utils, reducers), and classes, plus their import graph.
 */

import { parseSync } from "oxc-parser";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname, resolve, relative } from "node:path";
import { getLeadingComment } from "./extract-doc.js";
import { memoizedResolve } from "./file-cache.js";
import type { FileInfo, UnitInfo, UnitKind, ImportRecord } from "./types.js";
import { matchAliasPattern, type PathAliases } from "./tsconfig-paths.js";

const isPascal = (s: string) => /^[A-Z]/.test(s);

// ─── path resolution ───────────────────────────────────────────────────────

const EXTS = [".jsx", ".tsx", ".js", ".ts", ".mjs", ".cjs"];

/** True if a file is React-app source this analyzer can parse. */
export function isReactSourceFile(filePath: string): boolean {
  return EXTS.includes(extname(filePath).toLowerCase());
}

/**
 * Resolve a candidate base path (no extension) to a real source file, if any.
 * Probes up to 12 `existsSync` candidates — memoized per process because the
 * same specifiers repeat across hundreds of files and syscalls dominate on
 * slow filesystems. The memo is invalidated by file-cache when any source file
 * changes/disappears.
 */
function resolveFsLike(base: string): string | null {
  return memoizedResolve(base, () => {
    if (extname(base) && existsSync(base)) return base;
    for (const ext of EXTS) if (existsSync(base + ext)) return base + ext;
    for (const ext of EXTS) {
      const idx = join(base, "index" + ext);
      if (existsSync(idx)) return idx;
    }
    return null;
  });
}

export function resolveImport(
  fromFile: string,
  spec: string,
  aliases?: PathAliases,
): string | null {
  // Relative / absolute imports resolve against the importing file.
  if (spec.startsWith(".") || spec.startsWith("/")) {
    return resolveFsLike(resolve(dirname(fromFile), spec));
  }

  // tsconfig path aliases — pattern match against compilerOptions.paths.
  if (aliases) {
    for (const [pattern, templates] of aliases.paths) {
      const captured = matchAliasPattern(pattern, spec);
      if (captured === null) continue;
      for (const template of templates) {
        const candidate = template.includes("*")
          ? template.replace("*", captured)
          : template;
        // Skip aliases that point into node_modules — the analyzer is only
        // meant to walk first-party source, not vendored packages.
        if (
          candidate.includes(`${join("", "node_modules")}`) ||
          candidate.includes("/node_modules/") ||
          candidate.includes("\\node_modules\\")
        )
          continue;
        const resolved = resolveFsLike(candidate);
        if (resolved) return resolved;
      }
    }

    // baseUrl-only fallback: bare imports may resolve directly under baseUrl.
    if (aliases.baseUrl) {
      const resolved = resolveFsLike(join(aliases.baseUrl, spec));
      if (resolved) return resolved;
    }
  }

  return null;
}

export function fileToUnitName(file: string, srcRoot: string): string {
  const base = relative(srcRoot, file).replace(/\.[^.]+$/, "");
  const segs = base.split(/[/\\]/);
  let name = segs[segs.length - 1];
  if (name === "index") name = segs[segs.length - 2] ?? "Default";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

// ─── AST walking ──────────────────────────────────────────────────────────

function walk(node: unknown, fn: (n: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string") fn(n);
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) for (const x of v) walk(x, fn);
    else if (v && typeof v === "object") walk(v, fn);
  }
}

/** Result of a single combined pass over a unit body. */
type BodyScan = {
  hasJsx: boolean;
  jsxUsed: Set<string>;
  callsUsed: Set<string>;
  dynamicSpecs: string[];
};

/**
 * One walk over a unit body that collects everything we need at once:
 *  - whether it renders JSX (→ component),
 *  - JSX tag names used (PascalCase custom components),
 *  - callee names (`foo()`, `obj.method()`, `new Foo()`) — hooks/utils included;
 *    resolution later drops names that don't point at a first-party unit,
 *  - dynamic `import()` specifiers (lazy edges).
 *
 * Replaces what used to be four separate full-tree walks per unit.
 */
function scanBody(bodyNode: unknown, selfName: string): BodyScan {
  const jsxUsed = new Set<string>();
  const callsUsed = new Set<string>();
  const dynamicSpecs: string[] = [];
  let hasJsx = false;

  const pushDynamic = (arg: unknown): void => {
    const a = arg as Record<string, unknown> | undefined;
    if (
      a &&
      (a.type === "Literal" || a.type === "StringLiteral") &&
      typeof a.value === "string"
    ) {
      dynamicSpecs.push(a.value);
    }
  };

  walk(bodyNode, (n) => {
    switch (n.type) {
      case "JSXElement":
      case "JSXFragment":
        hasJsx = true;
        return;
      case "JSXOpeningElement": {
        const en = n.name as Record<string, unknown>;
        let tag = "";
        if (en.type === "JSXIdentifier") tag = en.name as string;
        else if (en.type === "JSXMemberExpression") {
          let obj = en.object as Record<string, unknown>;
          while (obj?.type === "JSXMemberExpression")
            obj = obj.object as Record<string, unknown>;
          if (obj?.type === "JSXIdentifier") tag = obj.name as string;
        }
        if (tag && isPascal(tag) && tag !== selfName) jsxUsed.add(tag);
        return;
      }
      case "CallExpression": {
        const callee = n.callee as Record<string, unknown>;
        if (callee?.type === "Import") {
          pushDynamic((n.arguments as unknown[])?.[0]);
          return;
        }
        const name =
          callee?.type === "Identifier"
            ? (callee.name as string)
            : callee?.type === "MemberExpression"
              ? ((callee.object as Record<string, unknown>)?.name as string)
              : "";
        if (name && name !== selfName) callsUsed.add(name);
        return;
      }
      case "NewExpression": {
        const callee = n.callee as Record<string, unknown>;
        const name =
          callee?.type === "Identifier" ? (callee.name as string) : "";
        if (name && name !== selfName) callsUsed.add(name);
        return;
      }
      case "ImportExpression":
        pushDynamic(
          (n as Record<string, unknown>).source ??
            (n as Record<string, unknown>).expression,
        );
        return;
    }
  });

  return { hasJsx, jsxUsed, callsUsed, dynamicSpecs };
}

/**
 * Collect the string specifiers of dynamic `import()` calls anywhere inside a
 * body, e.g. `() => import('./RechargeManagerV2')`. Handles both AST shapes
 * (`ImportExpression.source` and a `CallExpression` whose callee is `Import`).
 */
function collectDynamicImportSpecs(bodyNode: unknown): string[] {
  const specs: string[] = [];
  const pushFrom = (arg: unknown): void => {
    const a = arg as Record<string, unknown> | undefined;
    if (
      a &&
      (a.type === "Literal" || a.type === "StringLiteral") &&
      typeof a.value === "string"
    ) {
      specs.push(a.value);
    }
  };
  walk(bodyNode, (n) => {
    if (n.type === "ImportExpression") {
      pushFrom(
        (n as Record<string, unknown>).source ??
          (n as Record<string, unknown>).expression,
      );
    } else if (n.type === "CallExpression") {
      const callee = n.callee as Record<string, unknown>;
      if (callee?.type === "Import") {
        pushFrom((n.arguments as unknown[])?.[0]);
      }
    }
  });
  return specs;
}

/**
 * Inspect a variable initializer to see if it defines a styled-component.
 *
 * Returns `null` for non-styled initializers. Otherwise reports whether the
 * component is built straight from a native host tag (`styled.View`,
 * `styled.Text` — member syntax) or wraps another component
 * (`styled(Foo)` — call syntax), plus that wrapped component's name.
 *
 * Chained modifiers (`.attrs(...)`, `.withConfig(...)`) are peeled away first,
 * so `styled(Foo).attrs(() => ({}))` is still recognised as wrapping `Foo`.
 */
function analyzeStyled(
  init: Record<string, unknown> | null,
): { native: boolean; base: string | null } | null {
  if (!init) return null;
  // styled-components are tagged templates: styled(Foo)`…` / styled.View`…`
  let node: Record<string, unknown> | undefined =
    init.type === "TaggedTemplateExpression"
      ? (init.tag as Record<string, unknown>)
      : init.type === "CallExpression" || init.type === "MemberExpression"
        ? init
        : undefined;

  // Walk the callee/object chain inwards until we reach the core `styled` usage.
  while (node) {
    if (node.type === "CallExpression") {
      const callee = node.callee as Record<string, unknown>;
      if (callee.type === "Identifier" && callee.name === "styled") {
        // styled(Base)`…`  → wraps another component (keep it)
        const arg = (node.arguments as Record<string, unknown>[])?.[0];
        const base = arg?.type === "Identifier" ? (arg.name as string) : null;
        return { native: false, base };
      }
      node = callee;
      continue;
    }
    if (node.type === "MemberExpression") {
      const obj = node.object as Record<string, unknown>;
      if (obj.type === "Identifier" && obj.name === "styled") {
        // styled.View`…`  → native host element (skip it)
        return { native: true, base: null };
      }
      node = obj;
      continue;
    }
    break;
  }
  return null;
}

// ─── per-file analysis ────────────────────────────────────────────────────

/** Optional knobs for the per-file analyzer. */
export type AnalyzeOptions = {
  /**
   * Register styled-components as their own units (e.g. `const Title =
   * styled(Typography)``). Native host tags (`styled.View`) are always skipped.
   * Off by default — only meaningful for projects that use styled-components.
   */
  styledComponents?: boolean;
};

export async function analyzeReactFile(
  file: string,
  srcRoot: string,
  aliases?: PathAliases,
  opts: AnalyzeOptions = {},
): Promise<FileInfo> {
  const includeStyled = opts.styledComponents === true;
  const emptyResult: FileInfo = {
    imports: new Map(),
    units: new Map(),
    defaultExport: null,
    language: "js",
    reExports: new Map(),
    wildcardReExports: [],
    pendingLazy: [],
  };

  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch (e) {
    // A read failure is worth surfacing — it's not the same as an empty file.
    console.warn(
      `[graphdoc] could not read ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return emptyResult;
  }

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(file, source);
  } catch (e) {
    // A parse failure means this file's units/edges are silently missing —
    // log it so it doesn't masquerade as an empty module.
    console.warn(
      `[graphdoc] could not parse ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return emptyResult;
  }

  const { program, comments } = parsed;
  const imports = new Map<string, ImportRecord>();
  const units = new Map<string, UnitInfo>();
  const reExports = new Map<string, ImportRecord>();
  const wildcardReExports: string[] = [];
  const pendingLazy: Array<{ unit: string; file: string }> = [];
  let defaultExport: string | null = null;

  // Determine if file has any JSX — guides kind classification
  let fileHasJsx = false;
  walk(program, (n) => {
    if (n.type === "JSXElement" || n.type === "JSXFragment") fileHasJsx = true;
  });

  const collectUnit = (
    name: string,
    bodyNode: unknown,
    stmtStart: number,
    isClass = false,
  ) => {
    // Class React components render JSX too (`class App extends Component`),
    // so scan their bodies for JSX as well — otherwise a class root reports
    // zero edges. `kind` stays "class" regardless.
    const scan = scanBody(bodyNode, name);
    const kind: UnitKind = isClass
      ? "class"
      : scan.hasJsx || (fileHasJsx && isPascal(name))
        ? "component"
        : "function";

    // Components: JSX children AND first-party hook/util calls in the body.
    // Non-components: just the calls.
    const used = scan.hasJsx
      ? new Set<string>([...scan.jsxUsed, ...scan.callsUsed])
      : scan.callsUsed;

    // Dynamic import() targets in this unit's body become lazy edges. Resolve
    // the specifier to a file now; the unit name behind it is resolved after
    // the whole cache is built (see resolveLazyEdges).
    for (const spec of scan.dynamicSpecs) {
      const resolved = resolveImport(file, spec, aliases);
      if (resolved) pendingLazy.push({ unit: name, file: resolved });
    }

    const description = getLeadingComment(comments ?? [], source, stmtStart);
    units.set(name, { used, description, kind });
  };

  // `<Name>Props` / bare `Props` declarations seen in this file. Collected in
  // the same statement loop (no extra AST walk) and attached to units after the
  // loop — replaces the separate re-parse extract-props.ts used to need.
  const propsDecls = new Map<string, string[]>();

  const tryCollectPropsDecl = (decl: unknown): void => {
    if (!decl || typeof decl !== "object") return;
    const d = decl as Record<string, unknown>;
    let name = "";
    let members: Record<string, unknown>[] | null = null;

    if (d.type === "TSInterfaceDeclaration") {
      name = ((d.id as Record<string, unknown>)?.name as string) ?? "";
      members =
        ((d.body as Record<string, unknown>)?.body as Record<
          string,
          unknown
        >[]) ?? [];
    } else if (d.type === "TSTypeAliasDeclaration") {
      name = ((d.id as Record<string, unknown>)?.name as string) ?? "";
      const ann = d.typeAnnotation as Record<string, unknown>;
      if (ann?.type === "TSTypeLiteral") {
        members = (ann.members as Record<string, unknown>[]) ?? [];
      }
    }

    if (!name || !members || !name.endsWith("Props")) return;
    const props: string[] = [];
    for (const m of members) {
      if (m.type === "TSPropertySignature") {
        const key = m.key as Record<string, unknown>;
        if (key?.type === "Identifier") props.push(key.name as string);
      }
    }
    propsDecls.set(name, props);
  };

  const tryCollectDecl = (decl: unknown, stmtStart: number): string | null => {
    if (!decl || typeof decl !== "object") return null;
    const d = decl as Record<string, unknown>;

    if (d.type === "FunctionDeclaration" && d.id) {
      const name = (d.id as Record<string, unknown>).name as string;
      collectUnit(name, d.body, stmtStart);
      return name;
    }

    if (d.type === "ClassDeclaration" && d.id) {
      const name = (d.id as Record<string, unknown>).name as string;
      collectUnit(name, d.body, stmtStart, true);
      return name;
    }

    if (d.type === "VariableDeclaration") {
      let last: string | null = null;
      for (const v of d.declarations as Record<string, unknown>[]) {
        const init = v.init as Record<string, unknown> | null;
        const id = v.id as Record<string, unknown>;
        if (id?.type !== "Identifier") continue;
        const name = id.name as string;

        const isFn =
          init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression";
        if (isFn) {
          collectUnit(name, (init as Record<string, unknown>).body, stmtStart);
          last = name;
          continue;
        }

        // styled-components count as components too — but skip those built
        // straight from a native host tag (styled.View / styled.Text / …),
        // which are styling leaves, not architectural units.
        //
        // A styled() that WRAPS A CUSTOM COMPONENT (`styled(Link)`,
        // `styled(Typography)`) is a real architectural edge, so it is ALWAYS
        // captured. Other non-native styled (e.g. `styled(someLowercaseBase)`)
        // are only included when AnalyzeOptions.styledComponents is set.
        const styled = analyzeStyled(init);
        if (styled && !styled.native) {
          const baseIsCustom = !!styled.base && isPascal(styled.base);
          if (baseIsCustom || includeStyled) {
            const used = new Set<string>();
            if (baseIsCustom) used.add(styled.base as string);
            const description = getLeadingComment(
              comments ?? [],
              source,
              stmtStart,
            );
            units.set(name, { used, description, kind: "component" });
            last = name;
            continue;
          }
        }
      }
      return last;
    }
    return null;
  };

  for (const stmt of program.body as unknown as Record<string, unknown>[]) {
    if (stmt.type === "ImportDeclaration") {
      const resolved = resolveImport(
        file,
        (stmt.source as Record<string, unknown>).value as string,
        aliases,
      );
      if (!resolved) continue;
      for (const spec of (stmt.specifiers as Record<string, unknown>[]) ?? []) {
        if (spec.type === "ImportDefaultSpecifier") {
          imports.set((spec.local as Record<string, unknown>).name as string, {
            file: resolved,
            importedName: "default",
          });
        } else if (spec.type === "ImportSpecifier") {
          const named = ((spec.imported as Record<string, unknown>).name ??
            (spec.imported as Record<string, unknown>).value) as string;
          imports.set((spec.local as Record<string, unknown>).name as string, {
            file: resolved,
            importedName: named,
          });
        } else if (spec.type === "ImportNamespaceSpecifier") {
          // `import * as NS from './m'` — register the binding so member usage
          // (`NS.Foo`) isn't lost; resolved lazily via the file's exports.
          imports.set((spec.local as Record<string, unknown>).name as string, {
            file: resolved,
            importedName: "*",
          });
        }
      }
      continue;
    }

    if (stmt.type === "ExportNamedDeclaration") {
      // Re-export from another module (barrel): `export { default as X } from './m'`
      if (stmt.source) {
        const reSpec = (stmt.source as Record<string, unknown>).value as string;
        const reFile = resolveImport(file, reSpec, aliases);
        if (reFile) {
          for (const spec of (stmt.specifiers as Record<string, unknown>[]) ??
            []) {
            if (spec.type !== "ExportSpecifier") continue;
            const localName = ((spec.local as Record<string, unknown>).name ??
              (spec.local as Record<string, unknown>).value) as string;
            const exportedName = ((spec.exported as Record<string, unknown>)
              .name ??
              (spec.exported as Record<string, unknown>).value) as string;
            reExports.set(exportedName, {
              file: reFile,
              importedName: localName,
            });
          }
        }
        continue;
      }

      if (stmt.declaration) {
        tryCollectPropsDecl(stmt.declaration);
        tryCollectDecl(stmt.declaration, stmt.start as number);
        continue;
      }

      // `export { a, b as default }` WITHOUT a source — the two-step barrel:
      //   import X from './X';  export { X as default };
      // Forward each exported name to the local binding's origin so default/named
      // imports through this file resolve to the real unit.
      for (const spec of (stmt.specifiers as Record<string, unknown>[]) ?? []) {
        if (spec.type !== "ExportSpecifier") continue;
        const localName = ((spec.local as Record<string, unknown>).name ??
          (spec.local as Record<string, unknown>).value) as string;
        const exportedName = ((spec.exported as Record<string, unknown>).name ??
          (spec.exported as Record<string, unknown>).value) as string;
        const imp = imports.get(localName);
        if (imp) {
          // re-export of an imported binding → forward to its source file
          reExports.set(exportedName, imp);
        } else if (units.has(localName)) {
          // export of a locally-defined unit (possibly aliased / as default)
          reExports.set(exportedName, { file, importedName: localName });
          if (exportedName === "default") defaultExport = localName;
        }
      }
      continue;
    }

    if (stmt.type === "ExportAllDeclaration") {
      if (stmt.source) {
        const reSpec = (stmt.source as Record<string, unknown>).value as string;
        const reFile = resolveImport(file, reSpec, aliases);
        if (reFile) {
          const exported = stmt.exported as Record<string, unknown> | null;
          if (exported) {
            // `export * as NS from './m'` — namespaced re-export. Record under
            // the namespace name so it isn't treated as a flat wildcard barrel.
            const ns = (exported.name ?? exported.value) as string;
            reExports.set(ns, { file: reFile, importedName: "*" });
          } else {
            // `export * from './m'` — flat wildcard barrel.
            wildcardReExports.push(reFile);
          }
        }
      }
      continue;
    }

    if (stmt.type === "ExportDefaultDeclaration") {
      const d = stmt.declaration as Record<string, unknown>;
      if (
        (d.type === "FunctionDeclaration" || d.type === "ClassDeclaration") &&
        d.id
      ) {
        const name = (d.id as Record<string, unknown>).name as string;
        collectUnit(
          name,
          d.body,
          stmt.start as number,
          d.type === "ClassDeclaration",
        );
        defaultExport = name;
      } else if (d.type === "Identifier") {
        defaultExport = d.name as string;
      } else if (
        d.type === "ArrowFunctionExpression" ||
        d.type === "FunctionExpression"
      ) {
        const synth = fileToUnitName(file, srcRoot);
        collectUnit(synth, d.body, stmt.start as number);
        defaultExport = synth;
      }
      continue;
    }

    tryCollectPropsDecl(stmt);
    tryCollectDecl(stmt, stmt.start as number);
  }

  // File-level dynamic imports not captured inside a unit body — e.g. a
  // module-top `const X = ControlledLazy({ loader: () => import('./Y') })` or
  // `const X = lazy(() => import('./Y'))`. Attribute to the file's primary unit
  // (default export, else first component, else first unit). Deduped by target.
  {
    const already = new Set(pendingLazy.map((p) => p.file));
    const attributed =
      (defaultExport && units.has(defaultExport) && defaultExport) ||
      [...units.entries()].find(([, u]) => u.kind === "component")?.[0] ||
      [...units.keys()][0];
    if (attributed) {
      for (const spec of collectDynamicImportSpecs(program)) {
        const resolved = resolveImport(file, spec, aliases);
        if (resolved && !already.has(resolved)) {
          pendingLazy.push({ unit: attributed, file: resolved });
          already.add(resolved);
        }
      }
    }
  }

  // Attach captured props: `<Name>Props` binds to its unit; a bare `Props`
  // declaration binds to the file's primary unit (default export → first
  // component → first unit), mirroring extract-props' lookup rules.
  for (const [name, unit] of units) {
    const own = propsDecls.get(`${name}Props`);
    if (own && own.length) unit.props = own;
  }
  const bare = propsDecls.get("Props");
  if (bare && bare.length) {
    const primary =
      (defaultExport && units.has(defaultExport) && defaultExport) ||
      [...units.entries()].find(([, u]) => u.kind === "component")?.[0] ||
      [...units.keys()][0];
    const u = primary ? units.get(primary) : undefined;
    if (u && !u.props) u.props = bare;
  }

  const ext = extname(file);
  const language = ext === ".ts" || ext === ".tsx" ? "ts" : "js";

  return {
    imports,
    units,
    defaultExport,
    language,
    reExports,
    wildcardReExports,
    pendingLazy,
  };
}
