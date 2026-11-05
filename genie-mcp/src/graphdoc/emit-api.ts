import { readFile } from "node:fs/promises";
import { graphdocMkdir as mkdir, graphdocWriteFile as writeFile } from "./write-guard.js";
import { join } from "node:path";
import type { FileInfo } from "./types.js";
import { buildGraphData, docPathFor, safeMermaidIdent } from "./graph-core.js";
import { extractPropsFromSource } from "./extract-props.js";

// Above this many prop-bearing classes a single Mermaid classDiagram is
// unreadable, so we split it into one diagram per category.
const SPLIT_CLASSES = 60;

function extractProps(md: string): string[] {
  const startIdx = md.indexOf("<!-- DOCS:START -->");
  const endIdx = md.indexOf("<!-- DOCS:END -->");
  if (startIdx === -1 || endIdx === -1) return [];
  const block = md.slice(startIdx, endIdx);

  const propsHeaderRegex = /^>\s*\*\*Props\*\*\s*$/m;
  const m = block.match(propsHeaderRegex);
  if (!m) return [];
  const headerIdx = block.indexOf(m[0]);
  const after = block.slice(headerIdx + m[0].length);
  const lines = after.split("\n");

  const props: string[] = [];
  for (const line of lines) {
    if (/^>?\s*$/.test(line)) continue;
    if (/^>\s*\*\*[A-Za-z]/.test(line)) break;
    if (!line.startsWith(">")) break;
    const bullet = line.match(/^>\s*-\s*`([^`]+)`/);
    if (bullet) props.push(bullet[1]);
  }
  return props;
}

function classBlock(name: string, category: string, props: string[]): string[] {
  const lines: string[] = [];
  lines.push(`    class ${safeMermaidIdent(name)}["${name}"] {`);
  lines.push(`        <<${category}>>`);
  for (const p of props) {
    const safeProp = p.replace(/[^A-Za-z0-9_]/g, "_");
    const isCallback = /^on[A-Z]/.test(p) || p.endsWith("()");
    lines.push(`        +${safeProp}${isCallback ? "()" : ""}`);
  }
  lines.push(`    }`);
  return lines;
}

export async function emitApi({
  cache,
  srcRoot,
  docsDir,
  srcDocsDir,
}: {
  cache: Map<string, FileInfo>;
  srcRoot: string;
  docsDir: string;
  /**
   * Where to READ per-unit pages from when extracting props. Defaults to
   * `<docsDir>/src`. A module-scoped run points this at the MAIN docs/src so it
   * reuses already-written descriptions/props instead of empty placeholders.
   */
  srcDocsDir?: string;
}): Promise<void> {
  const docsSrcDir = srcDocsDir ?? join(docsDir, "src");
  const { nodes, edges } = buildGraphData(cache, srcRoot);

  // Props are read per (file, bare name) so the right page is found, but keyed
  // by displayName so colliding components (ui/Button vs ui-v2/Button) stay distinct.
  const propsByDisplay = new Map<string, string[]>();
  for (const n of nodes) {
    const docFile = docPathFor(srcRoot, docsSrcDir, n.file, n.name);
    // Prefer a human-curated `**Props**` list from the per-unit page, if any…
    let props: string[] = [];
    try {
      props = extractProps(await readFile(docFile, "utf8"));
    } catch {
      /* page may not exist (e.g. a module run, or a not-yet-documented unit) */
    }
    // …otherwise use the props captured during analysis (unit.props, no
    // re-parse). Re-parsing the source remains only as a fallback for units
    // that are somehow not in the cache.
    if (props.length === 0) {
      const fromCache = cache.get(n.file)?.units.get(n.name)?.props;
      props = fromCache ?? (await extractPropsFromSource(n.file, n.name));
    }
    propsByDisplay.set(n.displayName, props);
  }

  const withProps = nodes.filter(
    (n) => (propsByDisplay.get(n.displayName) ?? []).length > 0,
  );
  const withPropsSet = new Set(withProps.map((n) => n.displayName));
  const propEdges = edges.filter(
    (e) => withPropsSet.has(e.parent) && withPropsSet.has(e.child),
  );

  const intro = `# Component API

> Class-diagram view of every component that exposes props. Each class lists its prop and callback names — taken from a curated \`**Props**\` list in the unit's page if present, otherwise parsed directly from the component's \`*Props\` interface in source. Arrows show "uses" relationships between prop-bearing components.
>
> Components without documented props (e.g. layout shells, pages, root) are omitted to keep the diagram readable.`;

  let body: string;
  const big = withProps.length > SPLIT_CLASSES;

  if (!big) {
    const lines: string[] = ["classDiagram", "    direction LR"];
    for (const n of withProps)
      lines.push(
        ...classBlock(
          n.displayName,
          n.category,
          propsByDisplay.get(n.displayName)!,
        ),
      );
    for (const e of propEdges) {
      lines.push(
        `    ${safeMermaidIdent(e.parent)} --> ${safeMermaidIdent(e.child)}`,
      );
    }
    body = "```mermaid\n" + lines.join("\n") + "\n```";
  } else {
    const catOf = new Map(
      withProps.map((n) => [n.displayName, n.category] as const),
    );
    const cats = [...new Set(withProps.map((n) => n.category))].sort();
    const sections: string[] = [
      `> ⚠️ **${withProps.length} prop-bearing components** — too many for one readable class diagram, so it is split by category below.`,
    ];
    for (const cat of cats) {
      const catNodes = withProps.filter((n) => n.category === cat);
      const lines: string[] = ["classDiagram", "    direction LR"];
      for (const n of catNodes)
        lines.push(
          ...classBlock(
            n.displayName,
            n.category,
            propsByDisplay.get(n.displayName)!,
          ),
        );
      for (const e of propEdges) {
        if (catOf.get(e.parent) === cat) {
          lines.push(
            `    ${safeMermaidIdent(e.parent)} --> ${safeMermaidIdent(e.child)}`,
          );
        }
      }
      sections.push(
        `## ${cat} (${catNodes.length} components)\n\n\`\`\`mermaid\n${lines.join("\n")}\n\`\`\``,
      );
    }
    body = sections.join("\n\n");
  }

  const md = `${intro}\n\n${body}\n`;

  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "Api.md"), md);
  console.error(
    `wrote Api.md (${withProps.length} classes with props${big ? " — split by category" : ""})`,
  );
}
