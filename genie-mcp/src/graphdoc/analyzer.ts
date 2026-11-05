/**
 * analyzer.ts — project core (React apps and plain JS/TS projects).
 *
 * Works by:
 * 1. Following imports from the entry file (or walking the source tree) for
 *    .jsx/.tsx/.js/.ts files — spec/test files are never part of the graph
 * 2. Parsing each file with the per-file analyzer
 * 3. Building the dependency graph and tree using the shared types
 *
 * The emitters (emit-*.ts) consume a `components` field, so `analyze()`
 * bridges the `units` field to it.
 */

import { existsSync, statSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, basename, dirname, isAbsolute } from "node:path";
import {
  analyzeReactFile,
  fileToUnitName,
  isReactSourceFile,
  type AnalyzeOptions,
} from "./react-analyzer.js";
import { loadPathAliases, type PathAliases } from "./tsconfig-paths.js";
import {
  collectSpecs,
  crawlFiles,
  isSpecFile,
  specNames,
} from "./spec-analyzer.js";
import { getCachedFileInfo, storeFileInfo } from "./file-cache.js";
import type {
  FileInfo,
  Tree,
  GraphNode,
  GraphEdge,
  AnalyzeResult,
  OnboardingContext,
  ProjectKind,
  SpecFile,
  SpecSummary,
  UnitKind,
} from "./types.js";
import {
  resolveUnit,
  buildGraphData,
  computeDisplayNames,
  wikiLinkFor,
} from "./graph-core.js";
import {
  readState,
  manualTreeFromState,
  nameIndexFromState,
} from "./state-store.js";
import { emitFolderDocs } from "./emit-folder-docs.js";
import { emitMermaid } from "./emit-mermaid.js";
import { emitGraph } from "./emit-graph.js";
import { emitApi } from "./emit-api.js";
import { graphdocRm as rm } from "./write-guard.js";
import { emitMatrix } from "./emit-matrix.js";
import { emitTests, emitSpecPages, TESTS_FILENAME } from "./emit-tests.js";
import { SPECS_DIRNAME } from "./spec-analyzer.js";

export type { FileInfo, Tree, GraphNode, GraphEdge };
// Re-exported so existing importers (index.ts) keep working after consolidation.
export { resolveUnit, buildGraphData, categoryFor } from "./graph-core.js";

// ─── file crawling ─────────────────────────────────────────────────────────

/** Walk srcRoot and return all analyzable (non-spec) source files. */
function crawlSourceFiles(srcRoot: string): string[] {
  return crawlFiles(srcRoot, (f) => isReactSourceFile(f) && !isSpecFile(f));
}

// ─── cache building ────────────────────────────────────────────────────────

/**
 * Analyze all source files in srcRoot.
 * If rootFile is given, start from there and follow imports (depth-first).
 * Otherwise, crawl the entire srcRoot.
 */
/** Analyze one file into `cache`, then recurse into everything it references. */
async function processFileInto(
  cache: Map<string, FileInfo>,
  file: string,
  srcRoot: string,
  aliases?: PathAliases,
  analyzeOpts?: AnalyzeOptions,
): Promise<void> {
  if (cache.has(file)) return;
  if (!isReactSourceFile(file) || isSpecFile(file)) return;

  // Session cache: reuse the parse from a previous tool call when the file is
  // unchanged on disk (mtime+size). Only changed files pay read+parse again.
  let info = getCachedFileInfo(file, analyzeOpts);
  if (!info) {
    info = await analyzeReactFile(file, srcRoot, aliases, analyzeOpts);
    storeFileInfo(file, analyzeOpts, info);
  }
  cache.set(file, info);

  // Follow static imports, barrel re-exports and dynamic import() targets so
  // the whole reachable graph (incl. lazily-loaded subtrees) is analyzed.
  const follow: string[] = [
    ...[...info.imports.values()].map((i) => i.file),
    ...[...info.reExports.values()].map((r) => r.file),
    ...info.wildcardReExports,
    ...info.pendingLazy.map((p) => p.file),
  ];
  for (const target of follow) {
    if (!cache.has(target) && existsSync(target)) {
      await processFileInto(cache, target, srcRoot, aliases, analyzeOpts);
    }
  }
}

export async function buildCache(
  srcRoot: string,
  rootFile?: string,
  aliases?: PathAliases,
  analyzeOpts?: AnalyzeOptions,
): Promise<Map<string, FileInfo>> {
  const cache = new Map<string, FileInfo>();

  if (rootFile && existsSync(rootFile)) {
    // Import-following mode: only analyze what's reachable from rootFile
    await processFileInto(cache, rootFile, srcRoot, aliases, analyzeOpts);
  } else {
    // Full crawl mode: analyze everything in srcRoot
    const files = crawlSourceFiles(srcRoot);
    for (const f of files)
      await processFileInto(cache, f, srcRoot, aliases, analyzeOpts);
  }

  // Now that every file is analyzed, turn dynamic import() targets into edges.
  resolveLazyEdges(cache);

  return cache;
}

/**
 * Add more entry files (and their dependencies) into an existing cache — used to
 * pull in manual-link targets that aren't statically reachable from the root, so
 * the tree can expand their subtrees.
 */
export async function extendCache(
  cache: Map<string, FileInfo>,
  files: string[],
  srcRoot: string,
  aliases?: PathAliases,
  analyzeOpts?: AnalyzeOptions,
): Promise<void> {
  let added = false;
  for (const f of files) {
    if (f && !cache.has(f) && existsSync(f)) {
      await processFileInto(cache, f, srcRoot, aliases, analyzeOpts);
      added = true;
    }
  }
  if (added) resolveLazyEdges(cache);
}

/**
 * The subset of `cache` reachable from `entryFile` by following imports,
 * re-exports, wildcard barrels and dynamic-import targets — pure in-memory
 * BFS, no re-parse. Lets module-scoped doc generation reuse an already-built
 * cache instead of re-crawling the source tree.
 */
export function subsetReachableFrom(
  cache: Map<string, FileInfo>,
  entryFile: string,
): Map<string, FileInfo> {
  const out = new Map<string, FileInfo>();
  const queue = [entryFile];
  while (queue.length) {
    const f = queue.pop()!;
    if (out.has(f)) continue;
    const info = cache.get(f);
    if (!info) continue;
    out.set(f, info);
    for (const target of [
      ...[...info.imports.values()].map((i) => i.file),
      ...[...info.reExports.values()].map((r) => r.file),
      ...info.wildcardReExports,
      ...info.pendingLazy.map((p) => p.file),
    ]) {
      if (!out.has(target)) queue.push(target);
    }
  }
  return out;
}

/**
 * Convert each unit's pending dynamic-import targets into real edges: add the
 * target's name to `used` (+ `lazyUsed` for tagging) and register a synthetic
 * import so downstream resolution treats it like any other dependency.
 */
function resolveLazyEdges(cache: Map<string, FileInfo>): void {
  for (const [, info] of cache) {
    for (const { unit, file: targetFile } of info.pendingLazy) {
      const u = info.units.get(unit);
      if (!u) continue;
      const target = resolveUnit(targetFile, "default", cache);
      if (!target) continue;

      // Local handle for this lazy target. Normally the target's own name, but if
      // that name is already bound in this file to a DIFFERENT file — e.g. two
      // lazy managers that both export `RechargeManager`, or a static import
      // colliding with a lazy one — synthesize a unique alias keyed by the target
      // file. Without this the `used` Set and the `imports` map collapse the two
      // distinct targets into a single edge. The alias is internal only: every
      // edge consumer (buildGraphData, buildTree, emit-folder-docs) resolves it
      // back through `imports` to the real (file, name) and applies the
      // path-qualified display name, so the alias itself never surfaces.
      let local = target.name;
      const existing = info.imports.get(local);
      if (existing && existing.file !== target.file) {
        local = `${target.name}@@${target.file}`;
      }
      u.used.add(local);
      (u.lazyUsed ??= new Set<string>()).add(local);
      if (!info.imports.has(local)) {
        info.imports.set(local, {
          file: target.file,
          importedName: target.name,
        });
      }
    }
  }
}

/**
 * Make sure the root unit exists. A plain JS/TS entry (`index.ts` that calls
 * `app.listen()`, `main.ts` that calls `bootstrap()`, a library barrel that
 * only re-exports) usually defines no unit named after the file, which would
 * leave the tree empty. In that case a synthetic module-level unit is added
 * whose edges are: module-level statements' usages + every unit the file
 * exports (own units, named re-exports, `export *` barrels).
 *
 * The root file's FileInfo is replaced with a copy in THIS cache only — the
 * shared session file-cache entry is never mutated.
 */
export function ensureRootUnit(
  cache: Map<string, FileInfo>,
  rootFile: string,
  rootName: string,
): void {
  const info = cache.get(rootFile);
  if (!info || info.units.has(rootName)) return;

  const imports = new Map(info.imports);
  const used = new Set<string>(info.moduleUsed ?? []);
  for (const name of info.units.keys()) used.add(name);
  for (const [name, re] of info.reExports) {
    if (re.file === rootFile) used.add(re.importedName);
    else if (!imports.has(name)) {
      imports.set(name, re);
      used.add(name);
    }
  }
  for (const wf of info.wildcardReExports) {
    const target = cache.get(wf);
    if (!target) continue;
    for (const name of [...target.units.keys(), ...target.reExports.keys()]) {
      if (name === "default" || imports.has(name) || info.units.has(name))
        continue;
      imports.set(name, { file: wf, importedName: name });
      used.add(name);
    }
  }
  used.delete(rootName);
  if (!used.size) return;

  cache.set(rootFile, {
    ...info,
    imports,
    units: new Map(info.units).set(rootName, {
      used,
      description: null,
      kind: "function",
    }),
  });
}

// ─── multi-root mode ───────────────────────────────────────────────────────
//
// For projects with no single entry point — a folder of pages, page objects,
// scripts or lambdas. Every file DIRECTLY inside a roots folder (or listed
// explicitly) is always a root — `pages/*` means every page, even when one page
// navigates to another. Files in SUBfolders are roots only if no other
// candidate imports them, so a page's private fragments stay nested under it.

/** One root of a multi-root project. */
export type RootUnit = { file: string; name: string };

/** Expand `roots` (repo-relative or absolute folders/files) into source files. */
export function expandRoots(roots: string[], repoRoot: string): string[] {
  const files = new Set<string>();
  for (const r of roots) {
    const abs = isAbsolute(r) ? r : join(repoRoot, r);
    let isDir: boolean;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      throw new Error(`Root "${r}" does not exist (resolved to ${abs}).`);
    }
    if (isDir) for (const f of crawlSourceFiles(abs)) files.add(f);
    else if (isReactSourceFile(abs) && !isSpecFile(abs)) files.add(abs);
  }
  return [...files].sort();
}

/** Files that are always roots: directly inside a roots folder, or listed explicitly. */
export function pinnedRootFiles(
  roots: string[],
  repoRoot: string,
  files: string[],
): Set<string> {
  const abs = roots.map((r) =>
    (isAbsolute(r) ? r : join(repoRoot, r)).replace(/[/\\]+$/, ""),
  );
  const set = new Set(abs);
  return new Set(files.filter((f) => set.has(f) || set.has(dirname(f))));
}

/** Tree root label for a set of roots: `pages`, or `pages + jobs`. */
export function rootsLabel(roots: string[]): string {
  return roots.map((r) => basename(r.replace(/[/\\]+$/, "")) || r).join(" + ");
}

/**
 * Pick the root units among `files` (already analyzed into `cache`): `pinned`
 * files plus files not imported by another candidate; per file its default
 * export, else every unit nothing else in the file uses. A file with no units at all (a script that
 * just runs code) gets a synthetic module root, like a single entry would.
 */
export function pickRootUnits(
  cache: Map<string, FileInfo>,
  files: string[],
  srcRoot: string,
  pinned: Set<string> = new Set(),
): RootUnit[] {
  const candidates = files.filter((f) => cache.has(f));
  const reached = new Set<string>();
  for (const f of candidates)
    for (const g of subsetReachableFrom(cache, f).keys())
      if (g !== f) reached.add(g);
  let rootFiles = candidates.filter((f) => pinned.has(f) || !reached.has(f));
  if (!rootFiles.length) rootFiles = candidates; // everything in one cycle

  const out: RootUnit[] = [];
  for (const file of rootFiles) {
    const info = cache.get(file)!;
    if (info.defaultExport && info.units.has(info.defaultExport)) {
      out.push({ file, name: info.defaultExport });
      continue;
    }
    const usedLocally = new Set(
      [...info.units.values()].flatMap((u) => [...u.used]),
    );
    const top = [...info.units.keys()].filter((n) => !usedLocally.has(n));
    if (top.length) {
      for (const name of top) out.push({ file, name });
      continue;
    }
    const name = fileToUnitName(file, srcRoot);
    ensureRootUnit(cache, file, name);
    if (cache.get(file)!.units.has(name)) out.push({ file, name });
  }
  return out;
}

/** Analyze every file under the roots (and everything they import). */
export async function buildRootsCache(
  files: string[],
  srcRoot: string,
  aliases?: PathAliases,
  analyzeOpts?: AnalyzeOptions,
): Promise<Map<string, FileInfo>> {
  const cache = new Map<string, FileInfo>();
  await extendCache(cache, files, srcRoot, aliases, analyzeOpts);
  return cache;
}

/** Children of the label root: one independent subtree per root unit. */
export async function buildMultiTree(
  roots: RootUnit[],
  cache: Map<string, FileInfo>,
  manual?: ManualTreeCtx,
  displayNames?: Map<string, string>,
): Promise<Tree> {
  const out: Tree = {};
  for (const r of roots) {
    const label = displayNames?.get(`${r.file}::${r.name}`) ?? r.name;
    out[label] = await buildTree(
      r.file,
      r.name,
      new Set(),
      cache,
      manual,
      displayNames,
    );
  }
  return out;
}

// ─── tree building ─────────────────────────────────────────────────────────

/** Optional manual-link context so the tree includes link_units() edges. */
export type ManualTreeCtx = {
  /** from-unit name → list of manually-linked target names. */
  edges: Map<string, string[]>;
  /** unit name → defining file (for recursing into manual targets). */
  nameToFile: Map<string, string>;
};

export async function buildTree(
  file: string,
  name: string,
  visited: Set<string>,
  cache: Map<string, FileInfo>,
  manual?: ManualTreeCtx,
  /** (file::name) → display name, so colliding units show as e.g. `ui/Button`. */
  displayNames?: Map<string, string>,
): Promise<Tree> {
  const key = `${file}::${name}`;
  if (visited.has(key)) return {};
  visited.add(key);

  const out: Tree = {};
  const info = cache.get(file);
  if (!info) {
    visited.delete(key);
    return out;
  }

  const unit = info.units.get(name);
  const used = unit?.used ?? new Set<string>();

  for (const local of used) {
    const imp = info.imports.get(local);
    const resolved = imp
      ? resolveUnit(imp.file, imp.importedName, cache)
      : info.units.has(local)
        ? { file, name: local }
        : null;

    if (!resolved) continue;
    const label =
      displayNames?.get(`${resolved.file}::${resolved.name}`) ?? resolved.name;
    out[label] = await buildTree(
      resolved.file,
      resolved.name,
      visited,
      cache,
      manual,
      displayNames,
    );
  }

  // Manual links (from link_units) become branches too, so the tree reflects
  // edges static analysis can't see (dynamic mounts, AEM MapTo pages, …).
  for (const target of manual?.edges.get(name) ?? []) {
    if (target in out) continue;
    const tFile = manual?.nameToFile.get(target);
    out[target] = tFile
      ? await buildTree(tFile, target, visited, cache, manual, displayNames)
      : {}; // target not in the analyzed graph → leaf
  }

  visited.delete(key);
  return out;
}

/**
 * Build a unit-name → defining-file index from a cache. Files are visited in
 * sorted order so the canonical file picked for a duplicated name is stable
 * across runs (otherwise manual-link targets / docs could shift between runs).
 */
export function buildNameIndex(
  cache: Map<string, FileInfo>,
): Map<string, string> {
  const idx = new Map<string, string>();
  const entries = [...cache.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [file, info] of entries) {
    for (const n of info.units.keys()) if (!idx.has(n)) idx.set(n, file);
  }
  return idx;
}

/** Read persisted manual links (manualUses frontmatter) from docs/src. */
export async function readManualTree(
  docsDir: string,
): Promise<Map<string, string[]>> {
  const docsSrcDir = join(docsDir, "src");
  const map = new Map<string, string[]>();

  const walk = async (dir: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
    return out;
  };

  const parseList = (content: string, field: string): string[] => {
    if (!content.startsWith("---")) return [];
    const end = content.indexOf("\n---", 3);
    if (end === -1) return [];
    const out: string[] = [];
    let inField = false;
    for (const line of content.slice(3, end).split("\n")) {
      const head = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
      if (head) {
        inField = head[1] === field;
        if (inField) {
          const rest = head[2].trim();
          if (rest.startsWith("[")) {
            for (const x of rest
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean))
              out.push(x);
            inField = false;
          } else if (rest && rest !== "[]") {
            out.push(rest);
            inField = false;
          }
        }
        continue;
      }
      const item = line.match(/^\s*-\s*(.+?)\s*$/);
      if (item && inField) out.push(item[1]);
    }
    return out;
  };

  for (const f of await walk(docsSrcDir)) {
    const content = await readFile(f, "utf8").catch(() => null);
    if (!content) continue;
    const targets = parseList(content, "manualUses");
    if (targets.length) map.set(basename(f, ".md"), targets);
  }
  // Overlay the committed graphdoc.json (source of truth, survives without docs/src).
  for (const [name, targets] of manualTreeFromState(await readState(docsDir)))
    map.set(name, targets);
  return map;
}

/**
 * Index unit name → absolute source file, read from every doc page's `source:`
 * frontmatter. Lets us locate a manual-link target's source even when it isn't
 * reachable from the current root (so its subtree can be seeded into the cache).
 */
export async function readDocsNameIndex(
  docsDir: string,
  repoRoot: string,
): Promise<Map<string, string>> {
  const docsSrcDir = join(docsDir, "src");
  const map = new Map<string, string>();

  const walk = async (dir: string): Promise<string[]> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
    }
    return out;
  };

  for (const f of await walk(docsSrcDir)) {
    const content = await readFile(f, "utf8").catch(() => null);
    if (!content || !content.startsWith("---")) continue;
    const end = content.indexOf("\n---", 3);
    if (end === -1) continue;
    const m = content.slice(3, end).match(/^source:\s*(.+)$/m);
    if (m) map.set(basename(f, ".md"), join(repoRoot, m[1].trim()));
  }
  // Overlay source paths from the committed graphdoc.json so manual-link targets
  // resolve even when docs/src is gitignored / absent.
  for (const [name, abs] of nameIndexFromState(
    await readState(docsDir),
    repoRoot,
  ))
    map.set(name, abs);
  return map;
}

/**
 * Hang a `🧪 <spec>` leaf under every tested unit in a tree (wherever it
 * appears), so specs show up connected to the units they import. Mutates and
 * returns `tree`; tree keys are display names.
 */
export function attachSpecsToTree(
  tree: Tree,
  cache: Map<string, FileInfo>,
  srcRoot: string,
  repoRoot: string,
  specs: SpecFile[],
): Tree {
  if (!specs.length) return tree;
  const displayNames = computeDisplayNames(cache, srcRoot);
  const names = specNames(specs, repoRoot);
  const byLabel = new Map<string, string[]>();
  for (const s of specs) {
    for (const t of s.targets) {
      const label = displayNames.get(`${t.file}::${t.name}`) ?? t.name;
      const leaf = `🧪 ${names.get(s.file)!.name}`;
      const arr = byLabel.get(label) ?? [];
      if (!arr.includes(leaf)) arr.push(leaf);
      byLabel.set(label, arr);
    }
  }
  const visit = (node: Tree): void => {
    for (const [label, children] of Object.entries(node)) {
      visit(children);
      for (const leaf of byLabel.get(label) ?? []) children[leaf] = {};
    }
  };
  visit(tree);
  return tree;
}

export function printIndented(
  name: string,
  children: Tree,
  prefix = "",
  depth = 0,
  isLast = true,
): string {
  const connector = depth === 0 ? "" : isLast ? "└── " : "├── ";
  const lines = [prefix + connector + name];
  const entries = Object.entries(children);
  const nextPrefix = depth === 0 ? "" : prefix + (isLast ? "    " : "│   ");
  entries.forEach(([child, grand], i) => {
    lines.push(
      printIndented(
        child,
        grand,
        nextPrefix,
        depth + 1,
        i === entries.length - 1,
      ),
    );
  });
  return lines.join("\n");
}

// ─── graph data ────────────────────────────────────────────────────────────
// `buildGraphData`, `categoryFor` and `resolveUnit` now live in graph-core.ts
// (the single source of truth) and are re-exported at the top of this file.

// ─── onboarding context ────────────────────────────────────────────────────

export function buildOnboardingContext(
  cache: Map<string, FileInfo>,
  srcRoot: string,
  projectInfo: OnboardingContext["projectInfo"],
  treeData: Tree,
  specs?: SpecSummary,
): OnboardingContext {
  const { nodes, edges } = buildGraphData(cache, srcRoot);
  const displayNames = computeDisplayNames(cache, srcRoot);
  const byDisplay = new Map(nodes.map((n) => [n.displayName, n]));
  // Precomputed wiki-link per display name (path-qualified for colliding units).
  const wikiLinks = new Map(
    nodes.map((n) => [n.displayName, wikiLinkFor(n, srcRoot)]),
  );

  // Top-level children of root (tree keys are already display names; 🧪 spec
  // leaves are not units).
  const topLevel = Object.keys(treeData).filter((k) => !k.startsWith("🧪 "));

  // Hotspots: units used by the most parents (keyed by display name).
  const usedByCount = new Map<string, number>();
  for (const e of edges) {
    usedByCount.set(e.child, (usedByCount.get(e.child) ?? 0) + 1);
  }
  const hotspots = [...usedByCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([displayName, usedBy]) => {
      const node = byDisplay.get(displayName);
      return {
        name: node?.name ?? displayName,
        displayName,
        usedBy,
        kind: (node?.kind ?? "other") as UnitKind,
      };
    });

  // Documented units (carry display name so colliding ones link unambiguously).
  const documented: Array<{ displayName: string; description: string }> = [];
  for (const [file, fi] of cache) {
    for (const [name, unit] of fi.units) {
      if (unit.description) {
        documented.push({
          displayName: displayNames.get(`${file}::${name}`) ?? name,
          description: unit.description,
        });
      }
    }
  }

  const stats = {
    files: cache.size,
    units: nodes.length,
    language: projectInfo.language,
    framework: projectInfo.framework,
  };

  return {
    projectInfo,
    stats,
    topLevel,
    hotspots,
    documented,
    edgeCount: edges.length,
    wikiLinks,
    specs,
  };
}

/** Coverage numbers for ONBOARDING / tool output. */
export function summarizeSpecs(
  specs: SpecFile[],
  cache: Map<string, FileInfo>,
): SpecSummary {
  const covered = new Set(
    specs.flatMap((s) => s.targets.map((t) => `${t.file}::${t.name}`)),
  );
  let totalUnits = 0;
  for (const info of cache.values()) totalUnits += info.units.size;
  return {
    files: specs.length,
    tests: specs.reduce((n, s) => n + s.tests.length, 0),
    coveredUnits: covered.size,
    totalUnits,
  };
}

// ─── main pipeline ─────────────────────────────────────────────────────────

export async function analyze(
  _workDir: string,
  opts: {
    srcRoot: string;
    rootFile: string;
    rootName: string;
    docsDir: string;
    repoRoot: string;
    framework: string;
    language: string;
    styledComponents?: boolean;
    /** "node" = plain JS/TS project (see AnalyzeOptions.projectKind). */
    projectKind?: ProjectKind;
    /** Scan spec/test files → "Tested by" sections + Tests.md (for testers). */
    includeSpecs?: boolean;
    /**
     * Multi-root mode: folders/files of independent roots (no single entry).
     * When set, rootFile is ignored and rootName labels the tree root.
     */
    roots?: string[];
    /** Wipe docs/src before regenerating (default: additive — keep other pages). */
    rebuild?: boolean;
  },
): Promise<AnalyzeResult> {
  const {
    srcRoot,
    rootFile,
    rootName,
    docsDir,
    repoRoot,
    framework,
    language,
    styledComponents,
    projectKind,
    includeSpecs,
    roots,
    rebuild,
  } = opts;

  const aliases = loadPathAliases(repoRoot);
  const analyzeOpts = { styledComponents, projectKind };
  const rootFiles = roots?.length ? expandRoots(roots, repoRoot) : null;
  if (rootFiles && !rootFiles.length)
    throw new Error(`No source files found under roots: ${roots!.join(", ")}`);
  const cache = rootFiles
    ? await buildRootsCache(rootFiles, srcRoot, aliases, analyzeOpts)
    : await buildCache(srcRoot, rootFile, aliases, analyzeOpts);
  const manualEdges = await readManualTree(docsDir);
  // Seed manual-link targets (and their deps) into the cache so the tree can
  // expand subtrees that the root doesn't statically import (e.g. AEM pages).
  const docsIndex = await readDocsNameIndex(docsDir, repoRoot);
  const seeds = [...new Set([...manualEdges.values()].flat())]
    .map((n) => docsIndex.get(n))
    .filter((f): f is string => !!f);
  await extendCache(cache, seeds, srcRoot, aliases, analyzeOpts);
  const rootUnits = rootFiles
    ? pickRootUnits(
        cache,
        rootFiles,
        srcRoot,
        pinnedRootFiles(roots!, repoRoot, rootFiles),
      )
    : null;
  if (!rootUnits) ensureRootUnit(cache, rootFile, rootName);
  const displayNames = computeDisplayNames(cache, srcRoot);
  const manual = { edges: manualEdges, nameToFile: buildNameIndex(cache) };
  const treeData = rootUnits
    ? await buildMultiTree(rootUnits, cache, manual, displayNames)
    : await buildTree(
        rootFile,
        rootName,
        new Set(),
        cache,
        manual,
        displayNames,
      );
  const specs = includeSpecs
    ? await collectSpecs({ repoRoot, docsDir, cache, aliases })
    : undefined;

  const tree: Tree = { [rootName]: treeData };
  if (specs) attachSpecsToTree(tree, cache, srcRoot, repoRoot, specs);
  const treeText = printIndented(rootName, treeData);

  // Emitters consume the canonical cache (units / reExports) directly — no
  // legacy `components` bridge anymore (see graph-core.ts).
  await emitFolderDocs({ cache, srcRoot, docsDir, repoRoot, rebuild, specs });
  await emitMermaid({ tree, docsDir });
  await emitGraph({ cache, srcRoot, docsDir, repoRoot, specs });
  await emitApi({ cache, srcRoot, docsDir, projectKind });
  await emitMatrix({ cache, srcRoot, docsDir });
  if (specs) {
    await emitTests({ cache, srcRoot, docsDir, repoRoot, specs });
    await emitSpecPages({ cache, srcRoot, docsDir, repoRoot, specs });
  } else {
    // Specs switched off → drop stale Tests.md + spec pages from an earlier run.
    await rm(join(docsDir, TESTS_FILENAME), { force: true });
    await rm(join(docsDir, SPECS_DIRNAME), { recursive: true, force: true });
  }

  const { nodes, edges, collisions } = buildGraphData(cache, srcRoot);

  // Surface name collisions as a single summary (distinct units sharing a name
  // collapse to one node / one wiki-link target) rather than scattered warns.
  if (collisions.length) {
    console.warn(
      `⚠️  ${collisions.length} unit name(s) defined in multiple files — ` +
        `diagrams/wiki-links show one; the rest are reachable via their nested doc pages: ` +
        collisions
          .slice(0, 10)
          .map((c) => `${c.name} (×${c.files.length})`)
          .join(", ") +
        (collisions.length > 10 ? `, …` : ""),
    );
  }

  // Graph integrity check: every edge endpoint should be a known node, and no
  // self-loops. Edges use display names, so compare against display names.
  const nodeNames = new Set(nodes.map((n) => n.displayName));
  const badEdges = edges.filter(
    (e) =>
      e.parent === e.child ||
      !nodeNames.has(e.parent) ||
      !nodeNames.has(e.child),
  );
  if (badEdges.length) {
    console.warn(
      `⚠️  ${badEdges.length} invalid edge(s) (missing node or self-loop) — skipped in diagrams`,
    );
  }

  return {
    tree,
    treeText,
    cache,
    stats: { files: cache.size, units: nodes.length, language, framework },
    ...(specs ? { specs: summarizeSpecs(specs, cache) } : {}),
  };
}
