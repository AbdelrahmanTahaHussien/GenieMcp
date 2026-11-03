/**
 * detect-project.ts — React project detector.
 *
 * 1. Find the package.json root
 * 2. Confirm it's a React project and identify the framework (Next.js / Remix / Vite / CRA)
 * 3. Find the source root (src/, client/src, app/)
 * 4. Find the entry file (App / main / index)
 * 5. Derive the root unit name from the entry filename
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename, extname, dirname } from "node:path";
import type { ProjectInfo } from "./types.js";

// ─── manifest detection ────────────────────────────────────────────────────

type Manifest = {
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

function detectReact(repoRoot: string): Manifest | null {
  const pkgPath = join(repoRoot, "package.json");
  if (!existsSync(pkgPath)) return null;
  const pkg = readJson(pkgPath);
  const deps = {
    ...((pkg.dependencies as object) ?? {}),
    ...((pkg.devDependencies as object) ?? {}),
  };

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

export function detectProject(workDir: string): ProjectInfo {
  const repoRoot = findPackageRoot(workDir);

  const manifest = detectReact(repoRoot);

  if (!manifest) {
    throw new Error(
      `graphdoc-mcp supports React projects only — no "react" dependency found in ` +
        `package.json at "${repoRoot}".`,
    );
  }

  const pkg = readJson(join(repoRoot, "package.json"));
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

  if (!entry) {
    throw new Error(
      `Could not find a React entry file in "${srcRoot}". ` +
        `Tried: ${manifest.entryNames.map((n) => n + manifest.extensions[0]).join(", ")}`,
    );
  }

  return {
    repoRoot,
    srcRoot,
    rootFile: entry.file,
    rootName: entry.name,
    docsDir: join(repoRoot, "docs"),
    language: manifest.language,
    framework: manifest.framework,
  };
}
