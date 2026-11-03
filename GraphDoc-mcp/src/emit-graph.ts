import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileInfo } from "./types.js";
import {
  buildGraphData,
  CATEGORY_ORDER,
  safeMermaidIdent,
} from "./graph-core.js";

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

export async function emitGraph({
  cache,
  srcRoot,
  docsDir,
}: {
  cache: Map<string, FileInfo>;
  srcRoot: string;
  docsDir: string;
}): Promise<void> {
  const { nodes, edges } = buildGraphData(cache, srcRoot);

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
    lines.push("");
    for (const e of edges) lines.push(edgeLine(e.parent, e.child));
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
    body = sections.join("\n\n");
  }

  const md = `${intro}\n\n${body}\n`;

  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "Graph.md"), md);
  console.log(
    `wrote Graph.md (${nodes.length} nodes, ${edges.length} edges${big ? " — split by category" : ""})`,
  );
}
