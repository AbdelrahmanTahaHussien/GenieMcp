/**
 * detect-project.ts — project detector.
 *
 * 1. Find the package.json root
 * 2. Identify the project kind + framework: React (Next.js / Remix / Vite / CRA),
 *    otherwise a plain JS/TS project (Node.js, Express, NestJS, Fastify, …)
 * 3. Find the source root (src/, client/src, app/, lib/, …)
 * 4. Find the entry file (React: App / main / index; plain: package.json
 *    main/bin/exports mapped back to source, else index / main / server / app)
 * 5. Derive the root unit name from the entry filename
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import type { ProjectInfo, ProjectKind } from "./types.js";

// ─── manifest detection ────────────────────────────────────────────────────

type Manifest = {
  kind: ProjectKind;
  language: string;
  framework: string;
  srcDirs: string[];
  entryNames: string[];
  extensions: string[];
};

function readJson(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

function depsOf(pkg: Record<string, unknown>): Record<string, unknown> {
  return {
    ...((pkg.dependencies as object) ?? {}),
    ...((pkg.devDependencies as object) ?? {}),
  };
}

function detectReact(pkg: Record<string, unknown>): Manifest | null {
  const deps = depsOf(pkg);
  if (!("react" in deps) && !("react-dom" in deps)) return null;

  const isNext = "next" in deps;
  const isRemix = "@remix-run/react" in deps;
  const isVite = "vite" in deps;
  const framework = isNext
    ? "Next.js"
    : isRemix
      ? "Remix"
      : isVite
        ? "React (Vite)"
        : "React (CRA)";

  return {
    kind: "react",
    language: "ts",
    framework,
    srcDirs: isNext ? ["src", "app", "pages"] : ["src", "client/src", "app"],
    entryNames: isNext
      ? [
          "app/page",
          "app/layout",
          "pages/_app",
          "pages/index",
          "src/app/page",
          "src/app/layout",
        ]
      : ["App", "main", "index"],
    extensions: [".tsx", ".jsx", ".ts", ".js"],
  };
}

/** Server/CLI frameworks worth naming; first match wins. */
const NODE_FRAMEWORKS: Array<[dep: string, name: string]> = [
  ["@nestjs/core", "NestJS"],
  ["express", "Express"],
  ["fastify", "Fastify"],
  ["koa", "Koa"],
  ["@hapi/hapi", "hapi"],
  ["hono", "Hono"],
  ["commander", "Node.js CLI"],
  ["yargs", "Node.js CLI"],
];

/** Plain JS/TS project — anything that is not a React app. */
function detectPlain(repoRoot: string, pkg: Record<string, unknown>): Manifest {
  const deps = depsOf(pkg);
  const isTs =
    "typescript" in deps || existsSync(join(repoRoot, "tsconfig.json"));
  const named = NODE_FRAMEWORKS.find(([dep]) => dep in deps)?.[1];
  const framework =
    named ?? (isTs ? "Node.js (TypeScript)" : "Node.js (JavaScript)");
  return {
    kind: "node",
    language: isTs ? "ts" : "js",
    framework,
    srcDirs: ["src", "lib", "app", "server"],
    entryNames: ["index", "main", "server", "app", "cli"],
    extensions: isTs
      ? [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs"]
      : [".js", ".mjs", ".cjs", ".ts", ".jsx"],
  };
}

/**
 * Entry candidates declared in package.json (`exports["."]`, `module`, `main`,
 * `bin`). These usually point at build output (dist/index.js), so each is also
 * mapped back to its likely source (src/index.ts). Returned as repo-relative
 * paths WITHOUT extension, in priority order.
 */
function packageEntryCandidates(pkg: Record<string, unknown>): string[] {
  const raw: string[] = [];
  const pick = (v: unknown): void => {
    if (typeof v === "string") raw.push(v);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // Conditional exports: prefer source-ish conditions, then the rest.
      for (const k of ["source", "types", "import", "require", "default"])
        if (k in o) pick(o[k]);
    }
  };
  const exp = pkg.exports;
  if (exp && typeof exp === "object" && "." in (exp as object))
    pick((exp as Record<string, unknown>)["."]);
  else pick(exp);
  pick(pkg.source);
  pick(pkg.module);
  pick(pkg.main);
  if (typeof pkg.bin === "string") pick(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === "object")
    for (const v of Object.values(pkg.bin as object)) pick(v);

  const out: string[] = [];
  for (const r of raw) {
    const rel = r.replace(/^\.\//, "").replace(/\.d\.[cm]?ts$/, "");
    const noExt = rel.replace(/\.[cm]?[jt]sx?$/, "");
    // dist/index → src/index, build/cli/main → src/cli/main, … — tried first,
    // so a TS project compiling to lib/ still resolves to its src/ source.
    const mapped = noExt.replace(/^(dist|build|out|lib|esm|cjs)\//, "src/");
    if (mapped !== noExt) out.push(mapped);
    // Pure build-output dirs are never source; lib/ often is (plain JS libs).
    if (!/^(dist|build|out)\//.test(noExt)) out.push(noExt);
  }
  return [...new Set(out)];
}

// ─── discovery chain ───────────────────────────────────────────────────────

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function findSrcRoot(repoRoot: string, srcDirs: string[]): string {
  for (const candidate of srcDirs) {
    const full = join(repoRoot, candidate);
    if (existsSync(full)) return full;
  }
  // No conventional source dir — fall back to the repo root, but say so: in a
  // monorepo the real source usually lives under packages/*/src or apps/*/src.
  console.warn(
    `[graphdoc] no conventional source dir (${srcDirs.join(", ")}) under ${repoRoot} — ` +
      `using the repo root. For a monorepo, pass workDir pointing at the package (e.g. packages/web).`,
  );
  return repoRoot;
}

/** True if package.json declares workspaces or a monorepo manager is present. */
function isMonorepo(repoRoot: string, pkg: Record<string, unknown>): boolean {
  if (
    Array.isArray(pkg.workspaces) ||
    (pkg.workspaces && typeof pkg.workspaces === "object")
  )
    return true;
  return ["pnpm-workspace.yaml", "lerna.json", "rush.json", "turbo.json"].some(
    (f) => existsSync(join(repoRoot, f)),
  );
}

function findEntryFile(
  srcRoot: string,
  repoRoot: string,
  entryNames: string[],
  extensions: string[],
): { file: string; name: string } | null {
  // Search in srcRoot
  for (const candidate of entryNames) {
    for (const base of [srcRoot, repoRoot]) {
      for (const ext of extensions) {
        const full = join(base, candidate + ext);
        if (existsSync(full)) {
          const raw = basename(candidate);
          const name = raw.replace(/^_/, "");
          return {
            file: full,
            name: name.charAt(0).toUpperCase() + name.slice(1),
          };
        }
      }
    }
  }

  // Fallback: first file in srcRoot
  try {
    const entries = readdirSync(srcRoot);
    for (const e of entries.sort()) {
      if (extensions.some((x) => e.endsWith(x))) {
        const name = basename(e, extname(e));
        return {
          file: join(srcRoot, e),
          name: name.charAt(0).toUpperCase() + name.slice(1),
        };
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

// ─── public API ────────────────────────────────────────────────────────────

/** Human-readable reason detection found no entry file. */
export function noEntryMessage(info: ProjectInfo): string {
  return (
    `Could not find an entry file in "${info.srcRoot}". Pass rootFile=<entry>, ` +
    `or roots=["src/pages"] to document a folder of independent roots ` +
    `(no single entry point).`
  );
}

export function detectProject(workDir: string): ProjectInfo {
  const repoRoot = findPackageRoot(workDir);
  const pkg = readJson(join(repoRoot, "package.json"));
  const manifest = detectReact(pkg) ?? detectPlain(repoRoot, pkg);
  // Plain projects: package.json's declared entry beats naming conventions.
  if (manifest.kind === "node")
    manifest.entryNames = [
      ...packageEntryCandidates(pkg),
      ...manifest.entryNames,
    ];

  if (isMonorepo(repoRoot, pkg)) {
    console.warn(
      `[graphdoc] ${repoRoot} looks like a monorepo. Detection runs against this root; ` +
        `for a single package pass workDir pointing at it (e.g. packages/web).`,
    );
  }

  const srcRoot = findSrcRoot(repoRoot, manifest.srcDirs);
  const entry = findEntryFile(
    srcRoot,
    repoRoot,
    manifest.entryNames,
    manifest.extensions,
  );

  // No entry is not fatal: a project may be a folder of independent roots
  // (pages/*, scripts/*) documented via `roots`. Callers that need a single
  // entry check `rootFile` (see requireEntry in index.ts).
  return {
    repoRoot,
    srcRoot,
    rootFile: entry?.file ?? "",
    rootName: entry?.name ?? "",
    docsDir: join(repoRoot, "docs"),
    language: manifest.language,
    framework: manifest.framework,
    kind: manifest.kind,
  };
}
