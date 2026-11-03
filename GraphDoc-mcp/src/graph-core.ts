/**
 * graph-core.ts — the single source of truth for turning a parsed file cache
 * into a dependency graph, plus the shared output/formatting helpers every
 * emitter and tool needs.
 *
 * Historically there were TWO copies of the edge resolver and `buildGraphData`
 * (one in analyzer.ts, one in graph-helpers.ts) that drifted apart — a barrel
 * re-export bug slipped through exactly because a fix landed in one and not the
 * other. This module consolidates them so there is one resolver, one graph
 * builder, and one set of sanitizers used everywhere.
 */

import { relative, dirname, join, basename } from "node:path";
import type { FileInfo, GraphNode, GraphEdge } from "./types.js";

// ─── categories ──────────────────────────────────────────────────────────────

export const CATEGORY_ORDER = [
  "Root",
  "Pages",
  "Layout",
  "Components",
  "Views",
  "Services",
  "Models",
  "Controllers",
  "Hooks",
  "Stores",
  "API",
  "Routes",
  "Utils",
  "Lib",
  "Other",
] as const;

const KNOWN_CATEGORIES: Record<string, string> = {
  pages: "Pages",
  page: "Pages",
  components: "Components",
  component: "Components",
  views: "Views",
  view: "Views",
  layouts: "Layout",
  layout: "Layout",
  services: "Services",
  service: "Services",
  models: "Models",
  model: "Models",
  controllers: "Controllers",
  controller: "Controllers",
  utils: "Utils",
  util: "Utils",
  helpers: "Utils",
  helper: "Utils",
  hooks: "Hooks",
  hook: "Hooks",
  stores: "Stores",
  store: "Stores",
  state: "Stores",
  api: "API",
  routes: "Routes",
  route: "Routes",
  lib: "Lib",
  libs: "Lib",
};

export function categoryFor(filePath: string, srcRoot: string): string {
  const rel = relative(srcRoot, filePath);
  const parts = rel.split(/[/\\]/);
  if (parts.length === 1) return "Root";
  const top = parts[0].toLowerCase();
  return KNOWN_CATEGORIES[top] ?? (parts.length > 2 ? parts[0] : "Other");
}

// ─── resolution ──────────────────────────────────────────────────────────────

export type Resolved = { file: string; name: string };

/** Guard against pathological barrel/extends cycles even with the `seen` set. */
const MAX_RESOLVE_DEPTH = 64;

/**
 * Resolve an exported name in `file` to the file + unit where it is actually
 * defined, forwarding through barrel re-exports (`export … from`) and wildcard
 * barrels (`export * from`). This is THE resolver — used by tree building, graph
 * building, and per-unit docs alike.
 */
export function resolveExported(
  file: string,
  importedName: string,
  cache: Map<string, FileInfo>,
  seen: Set<string> = new Set(),
  depth = 0,
): Resolved | null {
  if (depth > MAX_RESOLVE_DEPTH) return null;
  const key = `${file}::${importedName}`;
  if (seen.has(key)) return null;
  seen.add(key);

  const info = cache.get(file);
  if (!info) return null;

  if (importedName === "default") {
    if (info.defaultExport && info.units.has(info.defaultExport)) {
      return { file, name: info.defaultExport };
    }
    const re = info.reExports.get("default");
    if (re)
      return resolveExported(re.file, re.importedName, cache, seen, depth + 1);
    return null;
  }

  if (info.units.has(importedName)) return { file, name: importedName };

  const re = info.reExports.get(importedName);
  if (re)
    return resolveExported(re.file, re.importedName, cache, seen, depth + 1);

  for (const wf of info.wildcardReExports) {
    const r = resolveExported(wf, importedName, cache, seen, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Back-compat alias — analyzer.ts historically called this `resolveUnit`. */
export const resolveUnit = resolveExported;

/**
 * Resolve a name used inside `fromFile` (via its imports, or a local unit) to
 * the concrete (file, unit) it refers to.
 */
export function resolveChild(
  fromFile: string,
  info: FileInfo,
  local: string,
  cache: Map<string, FileInfo>,
): Resolved | null {
  const imp = info.imports.get(local);
  if (imp) return resolveExported(imp.file, imp.importedName, cache);
  if (info.units.has(local)) return { file: fromFile, name: local };
  return null;
}

// ─── disambiguation (same-name units) ────────────────────────────────────────

const unitKey = (file: string, name: string) => `${file}::${name}`;

/**
 * Strip the common leading AND trailing segments shared by every array, leaving
 * the minimal distinguishing middle. e.g.
 *   [components, ui, Button] and [components, ui-v2, Button]
 *   → [ui] and [ui-v2]   (common head `components` + tail `Button` removed)
 */
function stripCommonEnds(arrs: string[][]): string[][] {
  if (arrs.length === 0) return arrs;
  const minLen = Math.min(...arrs.map((a) => a.length));
  let lead = 0;
  while (lead < minLen && arrs.every((a) => a[lead] === arrs[0][lead])) lead++;
  let trail = 0;
  while (
    trail < minLen - lead &&
    arrs.every(
      (a) => a[a.length - 1 - trail] === arrs[0][arrs[0].length - 1 - trail],
    )
  )
    trail++;
  return arrs.map((a) => a.slice(lead, a.length - trail));
}

/**
 * Map every `(file, name)` to a globally-unique display name. A name defined in
 * one file keeps its bare name; a name defined in several files becomes
 * `<discriminator>/<name>` (e.g. `ui/Button`, `ui-v2/Button`) so distinct units
 * never collapse into one node or one ambiguous wiki-link. Deterministic.
 */
export function computeDisplayNames(
  cache: Map<string, FileInfo>,
  srcRoot: string,
): Map<string, string> {
  const filesByName = new Map<string, string[]>();
  for (const [file, info] of cache) {
    for (const name of info.units.keys()) {
      const arr = filesByName.get(name) ?? [];
      arr.push(file);
      filesByName.set(name, arr);
    }
  }

  const out = new Map<string, string>();
  for (const [name, files] of filesByName) {
    if (files.length === 1) {
      out.set(unitKey(files[0], name), name);
      continue;
    }
    const sortedFiles = [...files].sort();
    const dirSegs = sortedFiles.map((f) =>
      relative(srcRoot, dirname(f)).split(/[/\\]/).filter(Boolean),
    );
    const middles = stripCommonEnds(dirSegs);
    sortedFiles.forEach((f, i) => {
      const mid = middles[i];
      const disc = mid.length
        ? mid.join("/")
        : basename(f).replace(/\.[^.]+$/, "");
      out.set(unitKey(f, name), `${disc}/${name}`);
    });
  }
  return out;
}

/**
 * Wiki-link for a node. Unique names link bare (`[[Button]]`); colliding names
 * use an Obsidian path-qualified alias link (`[[src/<relpath>|ui/Button]]`),
 * which is how Obsidian disambiguates two pages sharing a basename. Vault root
 * is assumed to be the `docs/` dir (pages live under `docs/src/...`).
 */
export function wikiLinkFor(
  node: Pick<GraphNode, "name" | "displayName" | "file" | "colliding">,
  srcRoot: string,
): string {
  if (!node.colliding) return `[[${node.displayName}]]`;
  // Doc pages are written under the UNIT name (docPathFor uses dirname(file) +
  // unitName), which is NOT always the source file's basename — e.g. a file
  // `RechargeManagerV2.tsx` whose component is `RechargeManager`. Build the link
  // from the page's real path (dir + unit name), or it dangles in Obsidian.
  const relDir = relative(srcRoot, dirname(node.file)).replace(/\\/g, "/");
  const rel = relDir ? `${relDir}/${node.name}` : node.name;
  // Escape the alias pipe as `\|` so the link survives inside Markdown table
  // cells (an unescaped `|` is read as a column separator and corrupts the row).
  // Obsidian renders the escaped form identically in tables and prose.
  return `[[src/${rel}\\|${node.displayName}]]`;
}

// ─── graph building ──────────────────────────────────────────────────────────

/** A unit name defined in more than one file (graph keys nodes by name). */
export type Collision = { name: string; files: string[] };

export type GraphData = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Names defined in multiple files — the diagram shows one, but all are reported. */
  collisions: Collision[];
};

// Edge-set separator that cannot appear in a JS identifier, so splitting back is
// always safe even if a unit name contained a pipe or colon.
const EDGE_SEP = " ";

/**
 * Build the node + edge graph from the file cache. Deterministic: files are
 * visited in sorted order so the canonical node for a duplicated name (and thus
 * generated docs) is stable across runs.
 */
export function buildGraphData(
  cache: Map<string, FileInfo>,
  srcRoot: string,
): GraphData {
  const displayNames = computeDisplayNames(cache, srcRoot);
  const dn = (file: string, name: string) =>
    displayNames.get(unitKey(file, name)) ?? name;

  const nodes = new Map<string, GraphNode>(); // keyed by displayName (globally unique)
  const collisionFiles = new Map<string, Set<string>>();
  const edgeSet = new Set<string>();

  const entries = [...cache.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  for (const [file, info] of entries) {
    for (const [name, unit] of info.units) {
      // Track every defining file so collisions are reported.
      const files = collisionFiles.get(name) ?? new Set<string>();
      files.add(file);
      collisionFiles.set(name, files);

      const display = dn(file, name);
      if (!nodes.has(display)) {
        nodes.set(display, {
          name,
          displayName: display,
          colliding: display !== name,
          file,
          category: categoryFor(file, srcRoot),
          kind: unit.kind,
          language: info.language,
        });
      }
      for (const dep of unit.used) {
        const r = resolveChild(file, info, dep, cache);
        if (r) edgeSet.add(`${display}${EDGE_SEP}${dn(r.file, r.name)}`);
      }
    }
  }

  const edges: GraphEdge[] = [...edgeSet].map((e) => {
    const [parent, child] = e.split(EDGE_SEP);
    return { parent, child };
  });

  const collisions: Collision[] = [...collisionFiles.entries()]
    .filter(([, files]) => files.size > 1)
    .map(([name, files]) => ({ name, files: [...files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { nodes: [...nodes.values()], edges, collisions };
}

// ─── formatting helpers (shared by all emitters) ─────────────────────────────

/** Mermaid node/class ids must be alphanumeric+underscore. */
export function safeMermaidIdent(name: string): string {
  return name.replace(/[^A-Za-z0-9_]/g, "_").replace(/_+/g, "_");
}

/** Escape a value for use inside a Markdown table cell. */
export function escapeMdCell(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
}

/** Per-unit doc page path: mirrors the source folder layout under docs/src/. */
export function docPathFor(
  srcRoot: string,
  docsSrcDir: string,
  file: string,
  unitName: string,
): string {
  return join(docsSrcDir, relative(srcRoot, dirname(file)), `${unitName}.md`);
}

// ─── output capping ──────────────────────────────────────────────────────────

/** Default ceiling for a single MCP tool response (chars, not tokens). */
export const DEFAULT_OUTPUT_CAP = 45_000;

/**
 * Truncate `text` to `limit` chars with an explicit notice, so a tool can never
 * silently blow past the model's context window. `hint` tells the caller how to
 * get the rest (narrow the root, use get_unit, etc.).
 */
export function capOutput(
  text: string,
  limit: number = DEFAULT_OUTPUT_CAP,
  hint?: string,
): string {
  if (text.length <= limit) return text;
  const notice =
    `\n\n⚠️ Output truncated — showing ${limit.toLocaleString()} of ` +
    `${text.length.toLocaleString()} characters.` +
    (hint ? ` ${hint}` : "");
  // Reserve room for the notice so the final string still fits under the limit.
  const room = Math.max(0, limit - notice.length);
  return text.slice(0, room) + notice;
}
