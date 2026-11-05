/**
 * tsconfig-paths.ts
 *
 * Load `compilerOptions.baseUrl` + `compilerOptions.paths` from tsconfig.json
 * (with `extends` chains) so the analyzer can resolve TS path aliases like
 * `~/foo`, `@components/Bar`, `@structure/X` to real files on disk.
 *
 * tsconfig.json files routinely contain `//` and `/* *​/` comments and trailing
 * commas, so we strip them before parsing rather than pulling in a JSON5 dep.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export type PathAliases = {
  /** Absolute path that `baseUrl` resolves to (or null when not set). */
  baseUrl: string | null;
  /** Pattern → list of absolute path templates (with `*` placeholder). */
  paths: Map<string, string[]>;
};

const EMPTY: PathAliases = { baseUrl: null, paths: new Map() };

function stripJsonComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/,(\s*[}\]])/g, "$1");
}

function readTsconfig(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(stripJsonComments(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

/** Walk the `extends` chain bottom-up and merge baseUrl + paths. */
function resolveExtends(
  tsconfigPath: string,
  visited: Set<string>,
): { baseUrl?: string; paths?: Record<string, string[]> } {
  if (visited.has(tsconfigPath)) return {};
  visited.add(tsconfigPath);

  const cfg = readTsconfig(tsconfigPath);
  if (!cfg) return {};

  let baseUrl: string | undefined;
  let paths: Record<string, string[]> | undefined;

  if (typeof cfg.extends === "string") {
    let ext = cfg.extends;
    const tryPaths = [
      isAbsolute(ext) ? ext : resolve(dirname(tsconfigPath), ext),
      isAbsolute(ext)
        ? ext + ".json"
        : resolve(dirname(tsconfigPath), ext) + ".json",
    ];
    const found = tryPaths.find(existsSync);
    if (found) {
      const parent = resolveExtends(found, visited);
      baseUrl = parent.baseUrl;
      paths = parent.paths;
    } else {
      // A broken `extends` silently drops the parent's baseUrl/paths, which can
      // make every aliased import (@components/…) fail to resolve. Surface it.
      console.warn(
        `[graphdoc] ${tsconfigPath} extends "${ext}" but it was not found ` +
          `(looked at: ${tryPaths.join(", ")}) — path aliases from the parent are ignored.`,
      );
    }
  }

  const opts = (cfg.compilerOptions ?? {}) as Record<string, unknown>;
  if (typeof opts.baseUrl === "string") {
    baseUrl = resolve(dirname(tsconfigPath), opts.baseUrl);
  }
  if (opts.paths && typeof opts.paths === "object") {
    paths = { ...(paths ?? {}), ...(opts.paths as Record<string, string[]>) };
  }
  return { baseUrl, paths };
}

/**
 * Load aliases for a repo root. Looks for tsconfig.json (then jsconfig.json).
 * Returns an empty PathAliases if none are configured.
 */
export function loadPathAliases(repoRoot: string): PathAliases {
  const candidates = [
    join(repoRoot, "tsconfig.json"),
    join(repoRoot, "jsconfig.json"),
  ].filter(existsSync);
  if (candidates.length === 0) return EMPTY;

  const { baseUrl, paths } = resolveExtends(candidates[0], new Set());
  if (!baseUrl && (!paths || Object.keys(paths).length === 0)) return EMPTY;

  const aliasPaths = new Map<string, string[]>();
  if (paths && baseUrl) {
    for (const [pattern, templates] of Object.entries(paths)) {
      if (!Array.isArray(templates)) continue;
      aliasPaths.set(
        pattern,
        templates.map((t) => (isAbsolute(t) ? t : resolve(baseUrl, t))),
      );
    }
  }
  return { baseUrl: baseUrl ?? null, paths: aliasPaths };
}

/**
 * If `spec` matches `pattern`, return the substring captured by `*` (or "" for
 * exact-match patterns). Returns null on no match.
 */
export function matchAliasPattern(
  pattern: string,
  spec: string,
): string | null {
  if (pattern.endsWith("/*") || pattern.endsWith("*")) {
    const prefix = pattern.endsWith("/*")
      ? pattern.slice(0, -1)
      : pattern.slice(0, -1);
    return spec.startsWith(prefix) ? spec.slice(prefix.length) : null;
  }
  return spec === pattern ? "" : null;
}
