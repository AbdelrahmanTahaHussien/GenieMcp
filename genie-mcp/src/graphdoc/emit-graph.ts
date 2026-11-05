import { graphdocMkdir as mkdir, graphdocWriteFile as writeFile } from "./write-guard.js";
import { join } from "node:path";
import type { FileInfo, SpecFile } from "./types.js";
import {
  buildGraphData,
  CATEGORY_ORDER,
  computeDisplayNames,
  safeMermaidIdent,
} from "./graph-core.js";
import { specNames } from "./spec-analyzer.js";

// Above these sizes a single Mermaid graph is unreadable / may fail to render,
// so we split it into one diagram per category.
const SPLIT_NODES = 150;
const SPLIT_EDGES = 300;

function nodeDecl(name: string): string {
  return `${safeMermaidIdent(name)}["${name}"]`;
}

function edgeLine(parent: string, child: string): string {
  return `    ${safeMermaidIdent(parent)} --> ${safeMermaidIdent(child)}`;
}

/** Mermaid id for a spec node — prefixed so it can't clash with a unit id. */
const specIdent = (name: string) => safeMermaidIdent(`spec_${name}`);

/**
 * The "🧪 Tests" subgraph: one node per spec file + a dashed edge to every
 * unit it imports. Empty when specs are off.
 */
function specLines(
  cache: Map<string, FileInfo>,
  srcRoot: string,
  repoRoot: string,
  specs: SpecFile[],
): { decl: string[]; edges: string[] } {
  if (!specs.length) return { decl: [], edges: [] };
  const displayNames = computeDisplayNames(cache, srcRoot);
  const names = specNames(specs, repoRoot);
  const decl = [`    subgraph cat_Tests["🧪 Tests"]`];
  const edges: string[] = [];
  for (const s of specs) {
    const { name } = names.get(s.file)!;
    decl.push(`        ${specIdent(name)}["🧪 ${name}"]`);
    const targets = new Set(
      s.targets.map((t) => displayNames.get(`${t.file}::${t.name}`) ?? t.name),
    );
    for (const t of [...targets].sort())
      edges.push(`    ${specIdent(name)} -.-> ${safeMermaidIdent(t)}`);
  }
  decl.push(`    end`);
  decl.push(
    `    classDef spec fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20`,
    `    class ${specs.map((s) => specIdent(names.get(s.file)!.name)).join(",")} spec`,
  );
  return { decl, edges };
}

export async function emitGraph({
  cache,
  srcRoot,
  docsDir,
  repoRoot = srcRoot,
  specs = [],
}: {
  cache: Map<string, FileInfo>;
  srcRoot: string;
  docsDir: string;
  repoRoot?: string;
  /** includeSpecs: spec files drawn as nodes with dashed edges to their units. */
  specs?: SpecFile[];
}): Promise<void> {
  const { nodes, edges } = buildGraphData(cache, srcRoot);
  const tests = specLines(cache, srcRoot, repoRoot, specs);

  const catOf = new Map<string, string>();
  const byCategory = new Map<string, string[]>();
  for (const n of nodes) {
    catOf.set(n.displayName, n.category);
    if (!byCategory.has(n.category)) byCategory.set(n.category, []);
    byCategory.get(n.category)!.push(n.displayName);
  }

  const intro = `# Component Dependency Graph

> Directed graph of every component, grouped by folder. Unlike [[Tree]] (which is a mindmap that repeats shared children), this is a **DAG**: each component appears exactly once, so high-reuse leaves like \`Button\` and \`Container\` light up with many incoming arrows.`;

  const big = nodes.length > SPLIT_NODES || edges.length > SPLIT_EDGES;
  let body: string;

  if (!big) {
    // Single combined diagram with category subgraphs.
    const lines: string[] = ["flowchart LR"];
    for (const cat of CATEGORY_ORDER) {
      const ns = byCategory.get(cat);
      if (!ns || ns.length === 0) continue;
      lines.push(`    subgraph cat_${safeMermaidIdent(cat)}["${cat}"]`);
      for (const n of [...ns].sort()) lines.push(`        ${nodeDecl(n)}`);
      lines.push(`    end`);
    }
    lines.push(...tests.decl);
    lines.push("");
    for (const e of edges) lines.push(edgeLine(e.parent, e.child));
    lines.push(...tests.edges);
    body = "```mermaid\n" + lines.join("\n") + "\n```";
  } else {
    // Too large for one diagram — one diagram per category (its nodes + the
    // edges leaving them), so each renders cleanly.
    const sections: string[] = [
      `> ⚠️ This project has **${nodes.length} units / ${edges.length} edges** — too large for a single readable diagram, so it is split by category below. See [[Matrix]] for the complete edge list.`,
    ];
    const cats = [...CATEGORY_ORDER].filter((c) => byCategory.get(c)?.length);
    for (const cat of cats) {
      const ns = new Set(byCategory.get(cat)!);
      const catEdges = edges.filter((e) => catOf.get(e.parent) === cat);
      const lines: string[] = ["flowchart LR"];
      lines.push(`    subgraph cat_${safeMermaidIdent(cat)}["${cat}"]`);
      for (const n of [...ns].sort()) lines.push(`        ${nodeDecl(n)}`);
      lines.push(`    end`);
      lines.push("");
      for (const e of catEdges) lines.push(edgeLine(e.parent, e.child));
      sections.push(
        `## ${cat} (${ns.size} units, ${catEdges.length} outgoing edges)\n\n\`\`\`mermaid\n${lines.join("\n")}\n\`\`\``,
      );
    }
    if (specs.length) {
      // Specs get their own diagram: spec nodes → the units they import.
      const lines = ["flowchart LR", ...tests.decl, "", ...tests.edges];
      sections.push(
        `## 🧪 Tests (${specs.length} spec files, ${tests.edges.length} edges)\n\n\`\`\`mermaid\n${lines.join("\n")}\n\`\`\``,
      );
    }
    body = sections.join("\n\n");
  }

  const legend = specs.length
    ? `\n\n> 🧪 Green nodes are spec files; dashed arrows point to the units each spec imports. See [[Tests]].`
    : "";
  const md = `${intro}${legend}\n\n${body}\n`;

  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "Graph.md"), md);
  console.error(
    `wrote Graph.md (${nodes.length} nodes, ${edges.length} edges${big ? " — split by category" : ""})`,
  );
}
