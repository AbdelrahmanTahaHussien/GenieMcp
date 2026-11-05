/**
 * react-analyzer.ts
 *
 * Per-file analyzer for JavaScript, TypeScript, JSX and TSX. Detects React
 * components (functions/arrows that return JSX), plain functions (hooks,
 * utils, reducers, handlers), and classes, plus their import graph.
 *
 * Plain JS/TS projects (projectKind "node") get extra handling, since their
 * wiring is mostly references rather than calls/JSX: identifier references
 * count as edges (`router.get('/', getUsers)`), module-level instances become
 * units (`const app = express(); app.use(router)`), and CommonJS
 * `require` / `module.exports` are understood.
 */

import { parseSync } from "oxc-parser";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname, resolve, relative } from "node:path";
import { getLeadingComment } from "./extract-doc.js";
import { memoizedResolve } from "./file-cache.js";
import type {
  FileInfo,
  UnitInfo,
  UnitKind,
  ImportRecord,
  ProjectKind,
  ApiMember,
  UnitApi,
} from "./types.js";
import { matchAliasPattern, type PathAliases } from "./tsconfig-paths.js";

const isPascal = (s: string) => /^[A-Z]/.test(s);

// ─── path resolution ───────────────────────────────────────────────────────

const EXTS = [".jsx", ".tsx", ".js", ".ts", ".mjs", ".cjs", ".mts", ".cts"];

/** True if a file is JS/TS source this analyzer can parse. */
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
/** NodeNext / ESM-style TS imports name the emitted file: `./x.js` → `./x.ts`. */
const JS_TO_TS: Record<string, string[]> = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx"],
  ".mjs": [".mts"],
  ".cjs": [".cts"],
};

function resolveFsLike(base: string): string | null {
  return memoizedResolve(base, () => {
    const ext = extname(base);
    if (ext && existsSync(base)) return base;
    for (const ts of JS_TO_TS[ext] ?? []) {
      const swapped = base.slice(0, -ext.length) + ts;
      if (existsSync(swapped)) return swapped;
    }
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
function scanBody(bodyNode: unknown, selfName: string, refs = false): BodyScan {
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

  if (refs) collectRefs(bodyNode, callsUsed, selfName);

  return { hasJsx, jsxUsed, callsUsed, dynamicSpecs };
}

/**
 * Collect every identifier *reference* in a subtree — plain-JS wiring passes
 * units around instead of calling them (`router.get('/', getUsers)`,
 * `app.use(authMiddleware)`, `constructor(private svc: UserService)`).
 * Property names (`obj.foo`, `{ foo: 1 }`, class members) are not references
 * and are skipped. Names that don't resolve to a first-party unit are dropped
 * later during resolution, so locals/params are harmless.
 */
function collectRefs(node: unknown, out: Set<string>, selfName: string): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) collectRefs(x, out, selfName);
    return;
  }
  const n = node as Record<string, unknown>;
  if (n.type === "Identifier" || n.type === "IdentifierReference") {
    const name = n.name as string;
    if (name && name !== selfName) out.add(name);
    return;
  }
  const skipKey =
    !n.computed &&
    (n.type === "MemberExpression"
      ? "property"
      : n.type === "Property" ||
          n.type === "MethodDefinition" ||
          n.type === "PropertyDefinition" ||
          n.type === "AccessorProperty" ||
          n.type === "TSPropertySignature" ||
          n.type === "TSMethodSignature"
        ? n.shorthand
          ? null // `{ foo }` — key and value are the same reference
          : "key"
        : null);
  for (const k of Object.keys(n)) {
    if (k === skipKey) continue;
    const v = n[k];
    if (v && typeof v === "object") collectRefs(v, out, selfName);
  }
}

/** `require('<spec>')` → spec, else null. */
function requireSpec(node: unknown): string | null {
  const n = node as Record<string, unknown> | null;
  if (n?.type !== "CallExpression") return null;
  const callee = n.callee as Record<string, unknown>;
  if (callee?.type !== "Identifier" || callee.name !== "require") return null;
  const a = (n.arguments as Record<string, unknown>[])?.[0];
  return a &&
    (a.type === "Literal" || a.type === "StringLiteral") &&
    typeof a.value === "string"
    ? a.value
    : null;
}

/**
 * Root identifier of a call/member chain: `app.use(x)` → "app",
 * `router.route('/').get(h)` → "router", `await db.connect()` → "db".
 */
function chainRoot(node: unknown): string | null {
  let n = node as Record<string, unknown> | null;
  while (n) {
    if (n.type === "Identifier") return n.name as string;
    if (n.type === "AwaitExpression") n = n.argument as Record<string, unknown>;
    else if (n.type === "CallExpression")
      n = n.callee as Record<string, unknown>;
    else if (n.type === "MemberExpression")
      n = n.object as Record<string, unknown>;
    else if (n.type === "ChainExpression")
      n = n.expression as Record<string, unknown>;
    else return null;
  }
  return null;
}

/** `module.exports` / `exports` / `module.exports.foo` / `exports.foo` target. */
function cjsExportTarget(
  left: unknown,
): { kind: "default" } | { kind: "named"; name: string } | null {
  const l = left as Record<string, unknown> | null;
  if (l?.type !== "MemberExpression" || l.computed) return null;
  const obj = l.object as Record<string, unknown>;
  const prop = (l.property as Record<string, unknown>)?.name as string;
  // module.exports = …
  if (obj?.type === "Identifier" && obj.name === "module" && prop === "exports")
    return { kind: "default" };
  // exports.foo = …
  if (obj?.type === "Identifier" && obj.name === "exports")
    return { kind: "named", name: prop };
  // module.exports.foo = …
  if (
    obj?.type === "MemberExpression" &&
    (obj.object as Record<string, unknown>)?.name === "module" &&
    (obj.property as Record<string, unknown>)?.name === "exports"
  )
    return { kind: "named", name: prop };
  return null;
}

// ─── API shape (Api.md for plain JS/TS projects) ──────────────────────────

type AstNode = Record<string, unknown>;

/** Source text of a type annotation (`: Promise<X>` → `Promise<X>`). */
function typeText(ann: unknown, source: string): string | undefined {
  let a = ann as AstNode | null;
  if (!a) return undefined;
  if (a.type === "TSTypeAnnotation") a = a.typeAnnotation as AstNode;
  if (typeof a?.start !== "number" || typeof a?.end !== "number")
    return undefined;
  return source.slice(a.start, a.end).replace(/\s+/g, " ").trim();
}

/** `"x"` → string, `1` → number, `true` → boolean (unannotated fields). */
function literalType(v: unknown): string | undefined {
  const n = v as AstNode | null;
  if (n?.type === "TemplateLiteral") return "string";
  if (n?.type !== "Literal" && n?.type !== "StringLiteral") return undefined;
  const t = typeof n.value;
  return t === "string" || t === "number" || t === "boolean" ? t : undefined;
}

function keyName(key: unknown): string | null {
  const k = key as AstNode | null;
  if (!k) return null;
  if (k.type === "Identifier") return k.name as string;
  if (k.type === "PrivateIdentifier") return `#${k.name as string}`;
  if (
    (k.type === "Literal" || k.type === "StringLiteral") &&
    typeof k.value === "string"
  )
    return k.value;
  return null;
}

/** `user: TestUser`, `...args`, `opts = {}` → `opts?`, `{ a, b }` → `{…}`. */
function paramText(p: unknown, source: string): string {
  const n = p as AstNode;
  switch (n?.type) {
    case "TSParameterProperty":
      return paramText(n.parameter, source);
    case "Identifier": {
      const t = typeText(n.typeAnnotation, source);
      return `${n.name as string}${n.optional ? "?" : ""}${t ? `: ${t}` : ""}`;
    }
    case "AssignmentPattern": {
      const inner = paramText(n.left, source);
      const [name, ...rest] = inner.split(":");
      return `${name}?${rest.length ? ":" + rest.join(":") : ""}`;
    }
    case "RestElement": {
      // The annotation sits on the RestElement, not on its argument.
      const t = typeText(n.typeAnnotation, source);
      const inner = paramText(n.argument, source);
      return `...${inner}${t && !inner.includes(":") ? `: ${t}` : ""}`;
    }
    case "ObjectPattern":
    case "ArrayPattern": {
      const t = typeText(n.typeAnnotation, source);
      return `${n.type === "ObjectPattern" ? "{…}" : "[…]"}${t ? `: ${t}` : ""}`;
    }
    default:
      return "…";
  }
}

const visibilityOf = (n: AstNode): ApiMember["visibility"] =>
  n.accessibility === "private" ||
  (n.key as AstNode | undefined)?.type === "PrivateIdentifier"
    ? "private"
    : n.accessibility === "protected"
      ? "protected"
      : "public";

function fnMember(
  name: string,
  fn: AstNode,
  source: string,
  extra: Partial<ApiMember> = {},
): ApiMember {
  return {
    name,
    kind: "method",
    params: ((fn.params as unknown[]) ?? []).map((p) => paramText(p, source)),
    type: typeText(fn.returnType, source),
    visibility: "public",
    ...extra,
  };
}

/** Public shape of a class / function / object literal, for Api.md. */
function extractApi(decl: unknown, source: string): UnitApi | undefined {
  const d = decl as AstNode | null;
  if (!d) return undefined;

  if (d.type === "ClassDeclaration" || d.type === "ClassExpression") {
    const members: ApiMember[] = [];
    for (const m of ((d.body as AstNode)?.body as AstNode[]) ?? []) {
      const name = keyName(m.key);
      const isAbstract =
        String(m.type).startsWith("TSAbstract") || !!m.abstract;
      const value = m.value as AstNode | null;
      if (
        (m.type === "MethodDefinition" ||
          m.type === "TSAbstractMethodDefinition") &&
        name
      ) {
        if (m.kind === "constructor") {
          // `constructor(private readonly page: Page)` declares fields.
          for (const p of (value?.params as AstNode[]) ?? []) {
            if (p.type !== "TSParameterProperty") continue;
            const param = p.parameter as AstNode;
            const id = (
              param.type === "AssignmentPattern" ? param.left : param
            ) as AstNode;
            // `private users = new UserRepository()` → type from the default.
            const dflt =
              param.type === "AssignmentPattern"
                ? (param.right as AstNode)
                : undefined;
            const ctor =
              dflt?.type === "NewExpression" &&
              (dflt.callee as AstNode)?.type === "Identifier"
                ? ((dflt.callee as AstNode).name as string)
                : undefined;
            members.push({
              name: id.name as string,
              kind: "field",
              type:
                typeText(id.typeAnnotation, source) ??
                ctor ??
                literalType(dflt),
              visibility: visibilityOf(p),
            });
          }
          continue;
        }
        if (m.kind === "get" || m.kind === "set") {
          if (members.some((x) => x.name === name)) continue;
          members.push({
            name,
            kind: "field",
            type: typeText(value?.returnType, source),
            visibility: visibilityOf(m),
            static: !!m.static,
          });
          continue;
        }
        members.push(
          fnMember(name, value ?? {}, source, {
            visibility: visibilityOf(m),
            static: !!m.static,
            abstract: isAbstract,
          }),
        );
      } else if (
        (m.type === "PropertyDefinition" ||
          m.type === "TSAbstractPropertyDefinition" ||
          m.type === "AccessorProperty") &&
        name
      ) {
        const isFn =
          value?.type === "ArrowFunctionExpression" ||
          value?.type === "FunctionExpression";
        if (isFn) {
          members.push(
            fnMember(name, value!, source, {
              visibility: visibilityOf(m),
              static: !!m.static,
            }),
          );
          continue;
        }
        // `form = new Form(…)` → type Form when not annotated.
        const ctor =
          value?.type === "NewExpression" &&
          (value.callee as AstNode)?.type === "Identifier"
            ? ((value.callee as AstNode).name as string)
            : undefined;
        members.push({
          name,
          kind: "field",
          type:
            typeText(m.typeAnnotation, source) ?? ctor ?? literalType(value),
          visibility: visibilityOf(m),
          static: !!m.static,
          abstract: isAbstract,
        });
      }
    }
    const sup = d.superClass as AstNode | null;
    const impl = ((d.implements as AstNode[]) ?? [])
      .map((i) => keyName(i.expression))
      .filter((n): n is string => !!n);
    return {
      shape: "class",
      members,
      ...(sup?.type === "Identifier" ? { extends: sup.name as string } : {}),
      ...(impl.length ? { implements: impl } : {}),
      ...(d.abstract ? { abstract: true } : {}),
    };
  }

  if (
    d.type === "FunctionDeclaration" ||
    d.type === "FunctionExpression" ||
    d.type === "ArrowFunctionExpression"
  ) {
    return { shape: "function", members: [fnMember("", d, source)] };
  }

  if (d.type === "ObjectExpression") {
    const members: ApiMember[] = [];
    for (const p of (d.properties as AstNode[]) ?? []) {
      if (p.type !== "Property") continue;
      const name = keyName(p.key);
      const v = p.value as AstNode;
      if (!name) continue;
      if (
        p.method ||
        v?.type === "FunctionExpression" ||
        v?.type === "ArrowFunctionExpression"
      )
        members.push(fnMember(name, v, source));
      else members.push({ name, kind: "field", visibility: "public" });
    }
    return { shape: "object", members };
  }
  return undefined;
}

/** Initializers that make a module-level `const` an architectural unit (node mode). */
const INSTANCE_INITS = new Set([
  "CallExpression",
  "NewExpression",
  "ObjectExpression",
  "ClassExpression",
  "AwaitExpression",
]);

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
  /**
   * "node" enables plain-JS/TS handling (identifier references as edges,
   * module-level instances as units, CommonJS). Default "react".
   */
  projectKind?: ProjectKind;
};

export async function analyzeReactFile(
  file: string,
  srcRoot: string,
  aliases?: PathAliases,
  opts: AnalyzeOptions = {},
): Promise<FileInfo> {
  const includeStyled = opts.styledComponents === true;
  const node = opts.projectKind === "node";
  const emptyResult: FileInfo = {
    imports: new Map(),
    units: new Map(),
    defaultExport: null,
    language: "js",
    reExports: new Map(),
    wildcardReExports: [],
    pendingLazy: [],
    moduleUsed: new Set(),
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
  const moduleUsed = new Set<string>();
  /**
   * Node mode: private module-level instances that are NOT units
   * (`const service = new UserService()`) → names their initializer uses.
   * Units referencing them inherit those names, so `getUsers → service.list()`
   * still yields the `getUsers → UserService` edge.
   */
  const privateInits = new Map<string, Set<string>>();
  /** API shape of those private instances, kept in case they get promoted. */
  const privateApis = new Map<string, UnitApi>();
  /** Module-level statements outside any unit, attributed after the loop. */
  const topLevel: unknown[] = [];
  let defaultExport: string | null = null;

  // Node mode: names whose methods are called at module level (`app.use(…)`,
  // `router.get(…)`) — such instances are wiring hubs and become units.
  const memberCalled = new Set<string>();
  if (node) {
    for (const stmt of program.body as unknown as Record<string, unknown>[]) {
      if (stmt.type !== "ExpressionStatement") continue;
      const e = stmt.expression as Record<string, unknown>;
      const callee = (e.type === "AwaitExpression" ? e.argument : e) as Record<
        string,
        unknown
      >;
      if (
        callee?.type === "CallExpression" &&
        (callee.callee as Record<string, unknown>)?.type !== "Identifier"
      ) {
        const root = chainRoot(callee);
        if (root) memberCalled.add(root);
      }
    }
  }

  // Determine if file has any JSX — guides kind classification
  let fileHasJsx = false;
  walk(program, (n) => {
    if (n.type === "JSXElement" || n.type === "JSXFragment") fileHasJsx = true;
  });

  // Node mode scans the whole class node, so `extends BasePage` /
  // `implements Repo` / decorators count as edges; React mode keeps the body
  // only (`extends Component` is never first-party anyway).
  const classScope = (cls: Record<string, unknown>): unknown =>
    node ? cls : cls.body;

  const collectUnit = (
    name: string,
    bodyNode: unknown,
    stmtStart: number,
    isClass = false,
    /** Declaring node (function / class) — node mode extracts its API shape. */
    decl?: unknown,
  ) => {
    // Class React components render JSX too (`class App extends Component`),
    // so scan their bodies for JSX as well — otherwise a class root reports
    // zero edges. `kind` stays "class" regardless.
    const scan = scanBody(bodyNode, name, node);
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
    const api = node ? extractApi(decl, source) : undefined;
    units.set(name, { used, description, kind, ...(api ? { api } : {}) });
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

  const tryCollectDecl = (
    decl: unknown,
    stmtStart: number,
    exported = false,
  ): string | null => {
    if (!decl || typeof decl !== "object") return null;
    const d = decl as Record<string, unknown>;

    if (d.type === "FunctionDeclaration" && d.id) {
      const name = (d.id as Record<string, unknown>).name as string;
      collectUnit(name, d.body, stmtStart, false, d);
      return name;
    }

    if (d.type === "ClassDeclaration" && d.id) {
      const name = (d.id as Record<string, unknown>).name as string;
      collectUnit(name, classScope(d), stmtStart, true, d);
      return name;
    }

    if (d.type === "VariableDeclaration") {
      let last: string | null = null;
      for (const v of d.declarations as Record<string, unknown>[]) {
        const init = v.init as Record<string, unknown> | null;
        const id = v.id as Record<string, unknown>;

        // CommonJS imports: `const x = require('./x')`,
        // `const { a, b: c } = require('./x')`, `const a = require('./x').a`.
        if (node && init) {
          const isMember =
            init.type === "MemberExpression" &&
            !init.computed &&
            requireSpec(init.object);
          const spec = isMember ? requireSpec(init.object) : requireSpec(init);
          if (spec) {
            const target = resolveImport(file, spec, aliases);
            if (target) {
              if (id?.type === "Identifier") {
                imports.set(id.name as string, {
                  file: target,
                  importedName: isMember
                    ? ((init.property as Record<string, unknown>)
                        .name as string)
                    : "default",
                });
              } else if (id?.type === "ObjectPattern") {
                for (const p of id.properties as Record<string, unknown>[]) {
                  const key = p.key as Record<string, unknown>;
                  const val = p.value as Record<string, unknown>;
                  if (key?.type === "Identifier" && val?.type === "Identifier")
                    imports.set(val.name as string, {
                      file: target,
                      importedName: key.name as string,
                    });
                }
              }
            }
            continue;
          }
        }

        if (id?.type !== "Identifier") continue;
        const name = id.name as string;

        const isFn =
          init?.type === "ArrowFunctionExpression" ||
          init?.type === "FunctionExpression";
        if (isFn) {
          collectUnit(
            name,
            (init as Record<string, unknown>).body,
            stmtStart,
            false,
            init,
          );
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

        // Node mode: module-level instances that are exported or wired up at
        // module level (`export const userService = new UserService()`,
        // `const app = express(); app.use(…)`) are units of their own.
        if (
          node &&
          init &&
          INSTANCE_INITS.has(init.type as string) &&
          (exported || memberCalled.has(name))
        ) {
          const used = new Set<string>();
          collectRefs(init, used, name);
          units.set(name, {
            used,
            description: getLeadingComment(comments ?? [], source, stmtStart),
            kind: init.type === "ClassExpression" ? "class" : "other",
            ...(extractApi(init, source)
              ? { api: extractApi(init, source) }
              : {}),
          });
          last = name;
        } else if (node && init && INSTANCE_INITS.has(init.type as string)) {
          const used = new Set<string>();
          collectRefs(init, used, name);
          privateInits.set(name, used);
          const api = extractApi(init, source);
          if (api) privateApis.set(name, api);
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
        tryCollectDecl(stmt.declaration, stmt.start as number, true);
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
          d.type === "ClassDeclaration" ? classScope(d) : d.body,
          stmt.start as number,
          d.type === "ClassDeclaration",
          d,
        );
        defaultExport = name;
      } else if (d.type === "Identifier") {
        defaultExport = d.name as string;
      } else if (node && d.type === "ClassDeclaration") {
        // `export default class { … }` (anonymous)
        const synth = fileToUnitName(file, srcRoot);
        collectUnit(synth, classScope(d), stmt.start as number, true, d);
        defaultExport = synth;
      } else if (
        d.type === "ArrowFunctionExpression" ||
        d.type === "FunctionExpression"
      ) {
        const synth = fileToUnitName(file, srcRoot);
        collectUnit(synth, d.body, stmt.start as number, false, d);
        defaultExport = synth;
      }
      continue;
    }

    // CommonJS exports: `module.exports = X | function … | { a, b }`,
    // `exports.foo = …`, `module.exports.foo = …`.
    if (node && stmt.type === "ExpressionStatement") {
      const e = stmt.expression as Record<string, unknown>;
      const target =
        e.type === "AssignmentExpression" ? cjsExportTarget(e.left) : null;
      if (target) {
        const right = e.right as Record<string, unknown>;
        const isFn =
          right.type === "FunctionExpression" ||
          right.type === "ArrowFunctionExpression" ||
          right.type === "ClassExpression";
        const start = stmt.start as number;
        if (target.kind === "named") {
          if (isFn) {
            collectUnit(
              target.name,
              right.type === "ClassExpression" ? classScope(right) : right.body,
              start,
              right.type === "ClassExpression",
              right,
            );
          } else if (right.type === "Identifier") {
            reExports.set(target.name, {
              file,
              importedName: right.name as string,
            });
            continue;
          } else {
            const req = requireSpec(right);
            const reFile = req ? resolveImport(file, req, aliases) : null;
            if (reFile)
              reExports.set(target.name, {
                file: reFile,
                importedName: "default",
              });
            else topLevel.push(right);
            continue;
          }
          reExports.set(target.name, { file, importedName: target.name });
          continue;
        }
        // module.exports = …
        if (right.type === "Identifier") {
          defaultExport = right.name as string;
        } else if (isFn) {
          const id = right.id as Record<string, unknown> | null;
          const name = (id?.name as string) ?? fileToUnitName(file, srcRoot);
          collectUnit(
            name,
            right.type === "ClassExpression" ? classScope(right) : right.body,
            start,
            right.type === "ClassExpression",
            right,
          );
          defaultExport = name;
        } else if (right.type === "ObjectExpression") {
          // `module.exports = { a, b: c, d: require('./d') }` — named exports.
          for (const p of right.properties as Record<string, unknown>[]) {
            const key = p.key as Record<string, unknown>;
            const val = p.value as Record<string, unknown>;
            const exportedName = (key?.name ?? key?.value) as string;
            if (!exportedName || !val) continue;
            const req = requireSpec(val);
            const reFile = req ? resolveImport(file, req, aliases) : null;
            if (val.type === "Identifier")
              reExports.set(exportedName, {
                file,
                importedName: val.name as string,
              });
            else if (reFile)
              reExports.set(exportedName, {
                file: reFile,
                importedName: "default",
              });
            else if (
              val.type === "FunctionExpression" ||
              val.type === "ArrowFunctionExpression"
            ) {
              collectUnit(exportedName, val.body, start, false, val);
              reExports.set(exportedName, { file, importedName: exportedName });
            }
          }
        } else {
          const req = requireSpec(right);
          const reFile = req ? resolveImport(file, req, aliases) : null;
          if (reFile)
            reExports.set("default", { file: reFile, importedName: "default" });
          else topLevel.push(right);
        }
        continue;
      }
    }

    tryCollectPropsDecl(stmt);
    const declared = tryCollectDecl(stmt, stmt.start as number);
    // Module-level statements that define no unit (`bootstrap()`,
    // `app.listen(3000)`, `createRoot(…).render(<App />)`).
    if (!declared && !/Declaration$/.test(stmt.type as string))
      topLevel.push(stmt);
  }

  // Attribute module-level statements: in node mode, `x.method(…)` on a
  // module-level unit `x` extends that unit's edges (router.get(…, handler));
  // everything else feeds moduleUsed (used by a synthetic entry root unit).
  for (const stmt of topLevel) {
    const scan = scanBody(stmt, "", node);
    const used = new Set([...scan.jsxUsed, ...scan.callsUsed]);
    const s = stmt as Record<string, unknown>;
    const root = node
      ? chainRoot(s.type === "ExpressionStatement" ? s.expression : s)
      : null;
    // Only method calls on an instance (`app.use(…)`) extend that unit; a plain
    // `bootstrap()` call is module-level usage, not part of bootstrap itself.
    const owner = root && memberCalled.has(root) ? units.get(root) : undefined;
    for (const n of used) {
      if (owner && n !== root) owner.used.add(n);
      else if (!owner) moduleUsed.add(n);
    }
  }

  // Instances exported after the fact (`module.exports = { logger }`,
  // `export { db }`, `export default app`) aren't private — promote them to
  // units so importers resolve them.
  const exportedLocals = [
    ...[...reExports.values()]
      .filter((r) => r.file === file)
      .map((r) => r.importedName),
    ...(defaultExport ? [defaultExport] : []),
  ];
  for (const name of exportedLocals) {
    const used = privateInits.get(name);
    if (!used || units.has(name)) continue;
    const api = privateApis.get(name);
    units.set(name, {
      used,
      description: null,
      kind: "other",
      ...(api ? { api } : {}),
    });
    privateInits.delete(name);
  }

  // Inline private instances (transitively — `const a = new A(); const b = make(a)`).
  if (privateInits.size) {
    for (const [selfName, u] of [
      ...units.entries(),
      ["", { used: moduleUsed }] as const,
    ]) {
      const queue = [...u.used].filter((n) => privateInits.has(n));
      const seen = new Set<string>();
      while (queue.length) {
        const n = queue.pop()!;
        if (seen.has(n)) continue;
        seen.add(n);
        for (const dep of privateInits.get(n)!) {
          if (dep === selfName) continue;
          if (privateInits.has(dep)) queue.push(dep);
          else u.used.add(dep);
        }
      }
    }
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
    moduleUsed,
  };
}
