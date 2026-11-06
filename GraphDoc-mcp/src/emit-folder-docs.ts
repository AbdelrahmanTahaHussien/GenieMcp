import { mkdir, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { FileInfo, SpecFile } from "./types.js";
import { resolveChild, docPathFor, computeDisplayNames } from "./graph-core.js";
import {
  readState,
  docsMapFromState,
  manualEdgesFromState,
} from "./state-store.js";
import { specNames, specsByUnit } from "./spec-analyzer.js";
import { signatureText } from "./emit-api.js";

/** An edge target plus how it was discovered. */
type Edge = {
  /** Display name (path-prefixed for colliding units, e.g. `ui/Button`). */
  displayName: string;
  /** Defining file of the target (absent for manual edges). */
  file?: string;
  /** Whether the target's name collides across files (→ path-qualified link). */
  colliding?: boolean;
  /** `${file}::${bareName}` of the target — used for precise reciprocal linking. */
  targetKey?: string;
  lazy?: boolean;
  manual?: boolean;
};

const DOCS_START = "<!-- DOCS:START -->";
const DOCS_END = "<!-- DOCS:END -->";
/** Max test titles listed per spec on a unit page (Tests.md lists them all). */
const MAX_TESTS_PER_SPEC = 30;
const DOCS_PLACEHOLDER =
  "> _Add a description here. This block is preserved across regenerations._";

function sourceLinkFor(
  docFile: string,
  jsxFile: string,
  repoRoot: string,
): string {
  const rel = relative(dirname(docFile), jsxFile);
  const label = relative(repoRoot, jsxFile);
  return `[\`${label}\`](${rel})`;
}

async function walkMdFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkMdFiles(full)));
    else if (e.isFile() && e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

function extractDocsBlock(content: string): string | null {
  const startIdx = content.indexOf(DOCS_START);
  const endIdx = content.indexOf(DOCS_END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    const block = content.slice(startIdx + DOCS_START.length, endIdx).trim();
    return block || null;
  }
  const legacy = content.match(/^#\s+[^\n]+\n\n([\s\S]*?)\n\*Defined in/m);
  if (legacy) {
    const block = legacy[1].trim();
    return block || null;
  }
  return null;
}

/**
 * Pull a curated prop list out of a DOCS-block body (the `> **Props**` bullets
 * that document_unit writes). Mirrors emit-api's extractor so the per-unit page
 * and the Api diagram agree on which props a component exposes.
 */
function propsFromDocsBody(body: string): string[] {
  const m = body.match(/^>\s*\*\*Props\*\*\s*$/m);
  if (!m) return [];
  const after = body.slice(body.indexOf(m[0]) + m[0].length);
  const out: string[] = [];
  for (const line of after.split("\n")) {
    if (/^>?\s*$/.test(line)) continue; // blank
    if (/^>\s*\*\*[A-Za-z]/.test(line)) break; // next bold sub-heading
    if (!line.startsWith(">")) break; // left the blockquote
    const bullet = line.match(/^>\s*-\s*`([^`]+)`/);
    if (bullet) out.push(bullet[1]);
  }
  return out;
}

/** Minimal leading-`---` frontmatter parser for the list fields we care about. */
function parseFrontmatterList(content: string, field: string): string[] {
  if (!content.startsWith("---")) return [];
  const end = content.indexOf("\n---", 3);
  if (end === -1) return [];
  const fm = content.slice(3, end);
  const lines = fm.split("\n");
  const out: string[] = [];
  let inField = false;
  for (const line of lines) {
    const head = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (head) {
      if (head[1] === field) {
        inField = true;
        const rest = head[2].trim();
        if (rest.startsWith("[")) {
          for (const x of rest
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)) {
            out.push(x);
          }
          inField = false;
        } else if (rest && rest !== "[]") {
          out.push(rest);
          inField = false;
        }
      } else {
        inField = false;
      }
      continue;
    }
    const item = line.match(/^\s*-\s*(.+?)\s*$/);
    if (item && inField) out.push(item[1]);
  }
  return out;
}

async function readExistingDocs(
  docsSrcDir: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const files = await walkMdFiles(docsSrcDir);
  for (const f of files) {
    try {
      const content = await readFile(f, "utf8");
      const block = extractDocsBlock(content);
      if (block) map.set(relative(docsSrcDir, f), block);
    } catch {
      /* ignore unreadable files */
    }
  }
  return map;
}

/** Read persisted manual links from every page's `manualUses` frontmatter. */
async function readManualEdges(docsSrcDir: string): Promise<{
  edges: Array<{ from: string; to: string }>;
  ownByPath: Map<string, string[]>;
}> {
  const edges: Array<{ from: string; to: string }> = [];
  const ownByPath = new Map<string, string[]>();
  const files = await walkMdFiles(docsSrcDir);
  for (const f of files) {
    try {
      const content = await readFile(f, "utf8");
      const targets = parseFrontmatterList(content, "manualUses");
      if (!targets.length) continue;
      const from = basename(f, ".md");
      ownByPath.set(relative(docsSrcDir, f), targets);
      for (const to of targets) edges.push({ from, to });
    } catch {
      /* ignore */
    }
  }
  return { edges, ownByPath };
}

/** Path-qualified Obsidian link for colliding targets, bare otherwise. */
function edgeLink(e: Edge, srcRoot: string): string {
  if (e.colliding && e.file) {
    // The page lives at dirname(file)/<unitName>.md (docPathFor), and the unit
    // name is NOT always the file basename (e.g. RechargeManagerV2.tsx exporting
    // `RechargeManager`). The bare unit name is the last segment of the display
    // name (`RechargePageV2/RechargeManager` → `RechargeManager`) since unit
    // names never contain a slash. Link to that page path, not the source file.
    const bare = e.displayName.split("/").pop()!;
    const relDir = relative(srcRoot, dirname(e.file)).replace(/\\/g, "/");
    const rel = relDir ? `${relDir}/${bare}` : bare;
    return `[[src/${rel}|${e.displayName}]]`;
  }
  return `[[${e.displayName}]]`;
}

function renderEdgeList(edges: Edge[], srcRoot: string): string[] {
  const byKey = new Map<string, Edge>();
  for (const e of edges) {
    const prev = byKey.get(e.displayName);
    byKey.set(e.displayName, {
      displayName: e.displayName,
      file: e.file ?? prev?.file,
      colliding: e.colliding ?? prev?.colliding,
      lazy: e.lazy || prev?.lazy,
      manual: e.manual || prev?.manual,
    });
  }
  return [...byKey.values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
    .map((e) => {
      const tag = e.manual ? " *(manual)*" : e.lazy ? " *(lazy)*" : "";
      return `- ${edgeLink(e, srcRoot)}${tag}`;
    });
}

export async function emitFolderDocs({
  cache,
  srcRoot,
  docsDir,
  repoRoot,
  rebuild = false,
  only,
  specs,
}: {
  cache: Map<string, FileInfo>;
  srcRoot: string;
  docsDir: string;
  repoRoot: string;
  /** Wipe docs/src before regenerating. Default: additive — keep other pages. */
  rebuild?: boolean;
  /**
   * Targeted mode: when given a set of relDocPaths (e.g. "components/ui/Button.md"),
   * only those pages are (re)written — the rest are left untouched and `rebuild`
   * is ignored. Used to materialize just the components that changed (document_unit)
   * without re-emitting the whole docs/src tree.
   */
  only?: Set<string>;
  /** Analyzed spec files (includeSpecs) → adds a "Tested by" section per unit. */
  specs?: SpecFile[];
}): Promise<void> {
  const docsSrcDir = join(docsDir, "src");

  // Preserve hand-written DOCS blocks and persisted manual links across runs.
  // The committed graphdoc.json ("setup memory") is the source of truth and
  // overrides on-disk pages, so a fresh clone with no docs/src still restores
  // every description + manual link.
  const existingDocs = await readExistingDocs(docsSrcDir);
  const pageManual = await readManualEdges(docsSrcDir);
  const state = await readState(docsDir);
  for (const [k, v] of docsMapFromState(state)) existingDocs.set(k, v);

  // Merge manual links by page (JSON wins per page), then rebuild the flat edge
  // list from the merged owners so duplicates can't accumulate.
  const manualOwn = new Map(pageManual.ownByPath);
  for (const [k, v] of manualEdgesFromState(state).ownByPath)
    manualOwn.set(k, v);
  const manualEdges: Array<{ from: string; to: string }> = [];
  for (const [relDocPath, targets] of manualOwn) {
    const from = basename(relDocPath, ".md");
    for (const to of targets) manualEdges.push({ from, to });
  }

  if (rebuild && !only) {
    await rm(docsSrcDir, { recursive: true, force: true });
  }
  await mkdir(docsSrcDir, { recursive: true });

  type Node = {
    name: string;
    displayName: string;
    colliding: boolean;
    file: string;
    uses: Edge[];
    usedBy: Edge[];
  };

  const displayNames = computeDisplayNames(cache, srcRoot);
  const dn = (file: string, name: string) =>
    displayNames.get(`${file}::${name}`) ?? name;

  const nodes = new Map<string, Node>(); // key = `${file}::${name}`

  // unit key → specs that import it; spec file → its page name / wiki-link.
  const testedByUnit = specsByUnit(specs ?? []);
  const specName = specNames(specs ?? [], repoRoot);

  for (const [file, info] of cache) {
    for (const [name, unit] of info.units) {
      const k = `${file}::${name}`;
      const uses: Edge[] = [];
      for (const local of unit.used) {
        const r = resolveChild(file, info, local, cache);
        if (r) {
          const d = dn(r.file, r.name);
          uses.push({
            displayName: d,
            file: r.file,
            colliding: d !== r.name,
            targetKey: `${r.file}::${r.name}`,
            lazy: unit.lazyUsed?.has(local),
          });
        }
      }
      const myDisplay = dn(file, name);
      nodes.set(k, {
        name,
        displayName: myDisplay,
        colliding: myDisplay !== name,
        file,
        uses,
        usedBy: [],
      });
    }
  }

  // Reciprocal static usedBy — matched by precise (file::name) identity, so two
  // same-named units don't cross-link to each other.
  for (const node of nodes.values()) {
    for (const child of node.uses) {
      const target = child.targetKey ? nodes.get(child.targetKey) : undefined;
      if (target) {
        target.usedBy.push({
          displayName: node.displayName,
          file: node.file,
          colliding: node.colliding,
          lazy: child.lazy,
        });
      }
    }
  }

  // Merge persisted manual edges (bare names; may reference pages outside the
  // current graph). Matched by bare name — manual links are a best-effort escape hatch.
  for (const { from, to } of manualEdges) {
    for (const n of [...nodes.values()].filter((n) => n.name === from))
      n.uses.push({ displayName: to, manual: true });
    for (const n of [...nodes.values()].filter((n) => n.name === to))
      n.usedBy.push({ displayName: from, manual: true });
  }

  // Collision summary: distinct units sharing a name get distinct (nested) doc
  // pages, but `[[wiki-links]]` are name-based so they resolve ambiguously.
  // Report once, not one console line per pair.
  const filesByName = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    const set = filesByName.get(node.name) ?? new Set<string>();
    set.add(node.file);
    filesByName.set(node.name, set);
  }
  const collisions = [...filesByName.entries()].filter(
    ([, files]) => files.size > 1,
  );
  if (collisions.length) {
    console.warn(
      `[emit-folder-docs] ${collisions.length} duplicate unit name(s) across files — ` +
        `each has its own nested page, but [[wiki-links]] to these are ambiguous: ` +
        collisions
          .slice(0, 8)
          .map(([n, f]) => `${n} (×${f.size})`)
          .join(", ") +
        (collisions.length > 8 ? ", …" : ""),
    );
  }

  let written = 0;
  let preserved = 0;
  for (const node of nodes.values()) {
    const docFile = docPathFor(srcRoot, docsSrcDir, node.file, node.name);
    const relDocPath = relative(docsSrcDir, docFile);
    // Targeted mode: only (re)write the requested pages.
    if (only && !only.has(relDocPath)) continue;
    await mkdir(dirname(docFile), { recursive: true });

    const existing = existingDocs.get(relDocPath);
    if (existing) preserved++;
    const docsBody = existing ?? DOCS_PLACEHOLDER;

    // This page's own persisted manual links (so they survive regeneration).
    const ownManual = manualOwn.get(relDocPath) ?? [];

    const usesLines = renderEdgeList(node.uses, srcRoot);
    const usedByLines = renderEdgeList(node.usedBy, srcRoot);
    const autoUses = [
      ...new Set(node.uses.filter((u) => !u.manual).map((u) => u.displayName)),
    ].sort();
    const autoUsedBy = [
      ...new Set(
        node.usedBy.filter((u) => !u.manual).map((u) => u.displayName),
      ),
    ].sort();

    const lines: string[] = [];
    lines.push("---");
    lines.push("type: component");
    lines.push(`source: ${relative(repoRoot, node.file)}`);
    // Declare the disambiguated identity when this name collides across files.
    if (node.colliding) lines.push(`name: ${node.displayName}`);
    if (autoUses.length > 0) {
      lines.push("uses:");
      for (const n of autoUses) lines.push(`  - ${n}`);
    } else {
      lines.push("uses: []");
    }
    if (autoUsedBy.length > 0) {
      lines.push("usedBy:");
      for (const n of autoUsedBy) lines.push(`  - ${n}`);
    } else {
      lines.push("usedBy: []");
    }
    if (ownManual.length > 0) {
      lines.push("manualUses:");
      for (const n of ownManual) lines.push(`  - ${n}`);
    }
    const testedBy = testedByUnit.get(`${node.file}::${node.name}`) ?? [];
    if (specs) {
      if (testedBy.length > 0) {
        lines.push("testedBy:");
        for (const sp of testedBy)
          lines.push(`  - ${relative(repoRoot, sp.file)}`);
      } else {
        lines.push("testedBy: []");
      }
    }
    lines.push("---");
    lines.push("");
    lines.push(`# ${node.displayName}`);
    lines.push("");
    lines.push(DOCS_START);
    lines.push(docsBody);
    lines.push(DOCS_END);
    lines.push("");
    lines.push(`*Defined in ${sourceLinkFor(docFile, node.file, repoRoot)}.*`);
    lines.push("");

    // Auto Props section: curated `**Props**` from the DOCS block if present,
    // else the props captured during analysis (unit.props — no re-parse).
    // Regenerated every run, so it shows props by default without documenting.
    let props = propsFromDocsBody(docsBody);
    if (props.length === 0)
      props = cache.get(node.file)?.units.get(node.name)?.props ?? [];
    // Plain JS/TS units: their signatures (methods / fields / parameters)
    // instead of React props.
    const api = cache.get(node.file)?.units.get(node.name)?.api;
    if (api && props.length === 0) {
      lines.push("## API");
      lines.push("");
      if (api.extends || api.implements?.length)
        lines.push(
          `*${[
            api.extends ? `extends \`${api.extends}\`` : "",
            api.implements?.length
              ? `implements ${api.implements.map((i) => `\`${i}\``).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join(" · ")}*`,
          "",
        );
      if (api.members.length === 0) lines.push("- *(no members)*");
      for (const m of api.members)
        lines.push(
          `- \`${signatureText(m, api.shape === "function" ? node.name : m.name)}\``,
        );
      lines.push("");
    } else {
      lines.push("## Props");
      lines.push("");
      if (props.length === 0) {
        lines.push("- *(no props detected)*");
      } else {
        for (const p of props) {
          const isCallback = /^on[A-Z]/.test(p);
          lines.push(`- \`${p}${isCallback ? "()" : ""}\``);
        }
      }
      lines.push("");
    }

    lines.push("## Uses");
    lines.push("");
    if (usesLines.length === 0) {
      lines.push("- *(none — leaf component)*");
    } else {
      lines.push(...usesLines);
    }
    lines.push("");
    lines.push("## Used by");
    lines.push("");
    if (usedByLines.length === 0) {
      lines.push("- *(not used by any other component in this project)*");
    } else {
      lines.push(...usedByLines);
    }
    lines.push("");

    if (specs) {
      lines.push("## Tested by");
      lines.push("");
      if (testedBy.length === 0) {
        lines.push("- *(no spec imports this unit)*");
      }
      for (const sp of testedBy) {
        lines.push(
          `- 🧪 ${specName.get(sp.file)!.link} (${sourceLinkFor(docFile, sp.file, repoRoot)}) — ${sp.tests.length} test case(s)`,
        );
        for (const t of sp.tests.slice(0, MAX_TESTS_PER_SPEC))
          lines.push(`  - ${t}`);
        if (sp.tests.length > MAX_TESTS_PER_SPEC)
          lines.push(
            `  - *…${sp.tests.length - MAX_TESTS_PER_SPEC} more in [[Tests]]*`,
          );
      }
      lines.push("");
    }

    await writeFile(docFile, lines.join("\n"));
    written++;
  }

  console.error(
    `wrote ${written} component docs to docs/src/ (preserved ${preserved} hand-written description blocks${rebuild ? "" : ", additive"})`,
  );
}
