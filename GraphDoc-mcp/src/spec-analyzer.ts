/**
 * spec-analyzer.ts — spec / test file discovery for testers (`includeSpecs`).
 *
 * Spec files are never part of the dependency graph (nothing imports them, and
 * their imports would pollute "used by" lists). Instead each spec is parsed on
 * its own to answer the questions a tester asks:
 *
 *   • which units does this spec exercise?   (its first-party imports)
 *   • which test cases does it contain?      (describe / it / test titles)
 *   • which units have no spec at all?       (graph units minus covered ones)
 *
 * The result feeds the "Tested by" section of each unit page and Tests.md.
 */

import { parseSync } from "oxc-parser";
import { readFile } from "node:fs/promises";
import { readdirSync, statSync, type Dirent } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { resolveImport, isReactSourceFile } from "./react-analyzer.js";
import { resolveExported } from "./graph-core.js";
import type { PathAliases } from "./tsconfig-paths.js";
import type { FileInfo, SpecFile } from "./types.js";

/** `foo.spec.ts`, `foo.test.jsx`, `foo.e2e-spec.ts`, `foo.cy.ts`, … */
const SPEC_NAME_RE = /\.(spec|test|e2e|e2e-spec|cy)\.[cm]?[jt]sx?$/i;
const SPEC_DIRS = new Set(["__tests__", "__specs__"]);

/** True if `file` is a spec/test file by naming convention or location. */
export function isSpecFile(file: string): boolean {
  if (SPEC_NAME_RE.test(file)) return true;
  return (
    isReactSourceFile(file) &&
    file.split(/[/\\]/).some((seg) => SPEC_DIRS.has(seg))
  );
}

/** Directories never worth descending into when looking for source or specs. */
export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  "env",
  "target",
  "vendor",
  ".gradle",
  ".idea",
  ".vscode",
  "coverage",
  ".cache",
]);

/** Walk `root` (skipping IGNORE_DIRS and `skip` dirs) and return files matching `keep`. */
export function crawlFiles(
  root: string,
  keep: (file: string) => boolean,
  skip: Set<string> = new Set(),
): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    if (skip.has(dir)) return;
    // withFileTypes avoids a statSync per entry (halves syscalls on big trees).
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && keep(full)) results.push(full);
      else if (e.isSymbolicLink()) {
        try {
          const st = statSync(full);
          if (st.isDirectory()) walk(full);
          else if (st.isFile() && keep(full)) results.push(full);
        } catch {
          /* ignore unreadable */
        }
      }
    }
  };
  walk(root);
  return results;
}

// ─── test-title extraction ──────────────────────────────────────────────────

const SUITE_FNS = new Set([
  "describe",
  "suite",
  "context",
  "fdescribe",
  "xdescribe",
]);
const CASE_FNS = new Set(["it", "test", "specify", "fit", "xit", "xtest"]);

/** Members that change what a call is (`test.describe` is a suite, `test.step` isn't a case). */
const KIND_MEMBERS = new Set([
  ...SUITE_FNS,
  "step",
  "beforeEach",
  "afterEach",
  "beforeAll",
  "afterAll",
  "use",
  "extend",
  "fixme",
  "info",
]);

/**
 * What kind of call a callee is: `describe.only` → describe, `test.each(t)` →
 * test, and Playwright's `test.describe(…)` / `test.describe.serial(…)` →
 * describe (not a test case), `test.step(…)` → step.
 */
function calleeRoot(node: unknown): string | null {
  let n = node as Record<string, unknown> | null;
  while (n) {
    if (n.type === "Identifier") return n.name as string;
    if (n.type === "MemberExpression") {
      const prop = (n.property as Record<string, unknown>)?.name as string;
      if (!n.computed && KIND_MEMBERS.has(prop)) return prop;
      n = n.object as Record<string, unknown>;
    } else if (n.type === "CallExpression")
      n = n.callee as Record<string, unknown>;
    else if (n.type === "TaggedTemplateExpression")
      n = n.tag as Record<string, unknown>;
    else return null;
  }
  return null;
}

/** Static string value of a title argument (string or expression-free template). */
function titleOf(node: unknown): string | null {
  const n = node as Record<string, unknown> | null;
  if (!n) return null;
  if (
    (n.type === "Literal" || n.type === "StringLiteral") &&
    typeof n.value === "string"
  )
    return n.value;
  if (n.type === "TemplateLiteral") {
    const quasis = n.quasis as Array<Record<string, unknown>>;
    // Keep `${…}` placeholders visible rather than dropping parameterized titles.
    return quasis
      .map(
        (q) => ((q.value as Record<string, unknown>)?.cooked as string) ?? "",
      )
      .join("${…}");
  }
  // describe(UserService, …) — a class/function used as the suite name.
  if (n.type === "Identifier") return n.name as string;
  return null;
}

/** Collect "Suite › Nested › case" titles from a spec program. */
function collectTestTitles(program: unknown): string[] {
  const tests: string[] = [];
  const visit = (node: unknown, prefix: string[]): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const x of node) visit(x, prefix);
      return;
    }
    const n = node as Record<string, unknown>;
    if (n.type === "CallExpression") {
      const root = calleeRoot(n.callee);
      const args = (n.arguments as unknown[]) ?? [];
      const title = root ? titleOf(args[0]) : null;
      if (root && title !== null && SUITE_FNS.has(root)) {
        for (const a of args.slice(1)) visit(a, [...prefix, title]);
        return;
      }
      if (root && title !== null && CASE_FNS.has(root)) {
        tests.push([...prefix, title].join(" › "));
        return;
      }
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (v && typeof v === "object") visit(v, prefix);
    }
  };
  visit(program, []);
  return tests;
}

// ─── public API ─────────────────────────────────────────────────────────────

/**
 * Find every spec file in the repo (outside docs/ and build/vendor dirs), parse
 * it, and resolve its first-party imports against the analyzed graph `cache`.
 */
export async function collectSpecs(opts: {
  repoRoot: string;
  docsDir: string;
  cache: Map<string, FileInfo>;
  aliases?: PathAliases;
}): Promise<SpecFile[]> {
  const { repoRoot, docsDir, cache, aliases } = opts;
  const files = crawlFiles(
    repoRoot,
    isSpecFile,
    new Set([resolve(docsDir)]),
  ).sort();
  const out: SpecFile[] = [];

  for (const file of files) {
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue;
    }
    let program: Record<string, unknown>;
    try {
      program = parseSync(file, source).program as unknown as Record<
        string,
        unknown
      >;
    } catch (e) {
      console.warn(
        `[graphdoc] could not parse spec ${file}: ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    // (resolved file, imported name) pairs from ESM imports + top-level require.
    const imported: Array<{ file: string; name: string }> = [];
    const add = (spec: string, name: string): void => {
      const target = resolveImport(file, spec, aliases);
      if (target && !isSpecFile(target)) imported.push({ file: target, name });
    };
    for (const stmt of program.body as Record<string, unknown>[]) {
      if (stmt.type === "ImportDeclaration") {
        if (stmt.importKind === "type") continue;
        const spec = (stmt.source as Record<string, unknown>).value as string;
        const specifiers = (stmt.specifiers as Record<string, unknown>[]) ?? [];
        for (const s of specifiers) {
          if (s.type === "ImportDefaultSpecifier") add(spec, "default");
          else if (s.type === "ImportNamespaceSpecifier") add(spec, "*");
          else if (s.type === "ImportSpecifier") {
            const im = s.imported as Record<string, unknown>;
            add(spec, (im.name ?? im.value) as string);
          }
        }
      } else if (stmt.type === "VariableDeclaration") {
        for (const d of stmt.declarations as Record<string, unknown>[]) {
          const init = d.init as Record<string, unknown> | null;
          const callee = init?.callee as Record<string, unknown> | undefined;
          const arg = (init?.arguments as Record<string, unknown>[])?.[0];
          if (
            init?.type !== "CallExpression" ||
            callee?.name !== "require" ||
            typeof arg?.value !== "string"
          )
            continue;
          const id = d.id as Record<string, unknown>;
          if (id.type === "ObjectPattern") {
            for (const p of id.properties as Record<string, unknown>[]) {
              const key = p.key as Record<string, unknown>;
              if (key?.type === "Identifier")
                add(arg.value, key.name as string);
            }
          } else add(arg.value, "default");
        }
      }
    }

    const targets = new Map<string, { file: string; name: string }>();
    const outsideGraph = new Set<string>();
    for (const imp of imported) {
      const info = cache.get(imp.file);
      if (!info) {
        // First-party source the graph never reached (test helpers, fixtures,
        // or code not reachable from the root).
        if (imp.file.startsWith(repoRoot + sep)) outsideGraph.add(imp.file);
        continue;
      }
      const resolved =
        imp.name === "*"
          ? [...info.units.keys()].map((name) => ({ file: imp.file, name }))
          : [resolveExported(imp.file, imp.name, cache)].filter(
              (r): r is { file: string; name: string } => !!r,
            );
      for (const r of resolved) targets.set(`${r.file}::${r.name}`, r);
    }

    out.push({
      file,
      tests: collectTestTitles(program),
      targets: [...targets.values()],
      outsideGraph: [...outsideGraph].sort(),
    });
  }
  return out;
}

// ─── naming (shared by every emitter that shows specs) ─────────────────────

/** Docs folder (under docsDir) holding one generated page per spec file. */
export const SPECS_DIRNAME = "specs";

export type SpecName = {
  /** Display name — `BookService.spec`, path-qualified only on collision. */
  name: string;
  /** Obsidian wiki-link to the spec's page. */
  link: string;
  /** Page path relative to docsDir (`specs/tests/services/BookService.spec.md`). */
  page: string;
};

/**
 * Name + page + wiki-link per spec file. Names are the file basename without
 * extension; two specs sharing a basename fall back to their repo-relative path
 * (and a path-qualified link) so they never merge into one node.
 */
export function specNames(
  specs: SpecFile[],
  repoRoot: string,
): Map<string, SpecName> {
  const rel = (f: string) =>
    relative(repoRoot, f)
      .replace(/\\/g, "/")
      .replace(/\.[^./]+$/, "");
  const base = (f: string) => rel(f).split("/").pop()!;
  const count = new Map<string, number>();
  for (const s of specs)
    count.set(base(s.file), (count.get(base(s.file)) ?? 0) + 1);

  const out = new Map<string, SpecName>();
  for (const s of specs) {
    const page = `${SPECS_DIRNAME}/${rel(s.file)}.md`;
    const unique = count.get(base(s.file)) === 1;
    const name = unique ? base(s.file) : rel(s.file);
    out.set(s.file, {
      name,
      link: unique
        ? `[[${name}]]`
        : `[[${SPECS_DIRNAME}/${rel(s.file)}\\|${name}]]`,
      page,
    });
  }
  return out;
}

/** unit key (`file::name`) → specs importing it. */
export function specsByUnit(specs: SpecFile[]): Map<string, SpecFile[]> {
  const map = new Map<string, SpecFile[]>();
  for (const spec of specs)
    for (const t of spec.targets) {
      const k = `${t.file}::${t.name}`;
      map.set(k, [...(map.get(k) ?? []), spec]);
    }
  return map;
}
