import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type Tree = { [k: string]: Tree };

function renderBranches(children: Tree, depth: number, out: string[]): void {
  const indent = "  ".repeat(depth);
  for (const [name, grand] of Object.entries(children)) {
    out.push(`${indent}${name}`);
    renderBranches(grand, depth + 1, out);
  }
}

export async function emitMermaid({
  tree,
  docsDir,
}: {
  tree: Tree;
  docsDir: string;
}): Promise<void> {
  const rootName = Object.keys(tree)[0];
  if (!rootName) return;

  const lines: string[] = [`  root((${rootName}))`];
  renderBranches(tree[rootName], 2, lines);

  const md = `# Component Tree

\`\`\`mermaid
mindmap
${lines.join("\n")}
\`\`\`
`;

  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "Tree.md"), md);
  console.error(`wrote mindmap with ${lines.length} nodes to docs/Tree.md`);
}
