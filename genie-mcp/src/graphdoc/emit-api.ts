import { readFile } from "node:fs/promises";
import { graphdocMkdir as mkdir, graphdocWriteFile as writeFile } from "./write-guard.js";
import { basename, join, relative } from "node:path";
import type {
  ApiMember,
  FileInfo,
  GraphNode,
  ProjectKind,
  UnitApi,
} from "./types.js";
import {
  buildGraphData,
  computeDisplayNames,
  docPathFor,
  resolveChild,
  safeMermaidIdent,
} from "./graph-core.js";
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
  projectKind,
}: {
  cache: Map<string, FileInfo>;
  srcRoot: string;
  docsDir: string;
  /** "node" renders classes/functions (Api.md for plain JS/TS projects). */
  projectKind?: ProjectKind;
  /**
   * Where to READ per-unit pages from when extracting props. Defaults to
   * `<docsDir>/src`. A module-scoped run points this at the MAIN docs/src so it
   * reuses already-written descriptions/props instead of empty placeholders.
   */
  srcDocsDir?: string;
}): Promise<void> {
  if (projectKind === "node") return emitPlainApi({ cache, srcRoot, docsDir });
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

// ─── plain JS/TS projects ────────────────────────────────────────────────────

const VIS = { public: "+", protected: "#", private: "-" } as const;

/**
 * Mermaid-safe type text: generics become `~T~`; anything Mermaid can't parse
 * inside a class body (object/function/union-of-literal types) collapses to `…`.
 */
function mermaidType(t?: string): string {
  if (!t) return "";
  // `Book | undefined` / `X | null` → `Book` (optionality isn't drawn).
  const core = t.replace(/\s*\|\s*(undefined|null)\b/g, "").trim();
  const out = core.replace(/</g, "~").replace(/>/g, "~");
  if (!/^[\w.$~\[\], ?]+$/.test(out) || out.length > 48) return "…";
  return out;
}

function mermaidParam(p: string): string {
  const [name, ...rest] = p.split(":");
  const type = rest.join(":").trim();
  const n =
    name
      .trim()
      .replace(/[{}[\]…]/g, "")
      .trim() || "arg";
  return type ? `${n}: ${mermaidType(type)}` : n;
}

/** One class-diagram member line. */
function memberLine(m: ApiMember, name = m.name): string {
  const mod = `${m.abstract ? "*" : ""}${m.static ? "$" : ""}`;
  const ident = name.replace(/^#/, "").replace(/[^\w$]/g, "_");
  if (m.kind === "field") {
    const t = mermaidType(m.type);
    return `${VIS[m.visibility]}${t ? `${t} ` : ""}${ident}${mod}`;
  }
  const params = (m.params ?? []).map(mermaidParam).join(", ");
  const ret = mermaidType(m.type);
  return `${VIS[m.visibility]}${ident}(${params})${mod}${ret ? ` ${ret}` : ""}`;
}

type Box = {
  id: string;
  label: string;
  stereotype: string;
  category: string;
  lines: string[];
};

/** Plain-markdown signature (per-unit pages): `login(user: TestUser): Promise<X>`. */
export function signatureText(m: ApiMember, name = m.name): string {
  const vis = m.visibility === "public" ? "" : `${m.visibility} `;
  const mods = `${m.static ? "static " : ""}${m.abstract ? "abstract " : ""}`;
  if (m.kind === "field")
    return `${vis}${mods}${name}${m.type ? `: ${m.type}` : ""}`;
  return `${vis}${mods}${name}(${(m.params ?? []).join(", ")})${m.type ? `: ${m.type}` : ""}`;
}

async function emitPlainApi({
  cache,
  srcRoot,
  docsDir,
}: {
  cache: Map<string, FileInfo>;
  srcRoot: string;
  docsDir: string;
}): Promise<void> {
  const { nodes, edges } = buildGraphData(cache, srcRoot);
  const displayNames = computeDisplayNames(cache, srcRoot);
  const apiOf = (n: GraphNode): UnitApi | undefined =>
    cache.get(n.file)?.units.get(n.name)?.api;

  // Unit display name → id of the box it is drawn in.
  const boxOf = new Map<string, string>();
  const boxes = new Map<string, Box>();
  const inherit: string[] = [];

  for (const n of [...nodes].sort((a, b) =>
    a.displayName.localeCompare(b.displayName),
  )) {
    const api = apiOf(n);
    if (!api) continue;
    if (api.shape === "function") {
      // Functions are grouped into one «module» box per file.
      const rel = relative(srcRoot, n.file).replace(/\\/g, "/");
      const id = safeMermaidIdent(`mod_${rel}`);
      const box = boxes.get(id) ?? {
        id,
        // File name WITH extension, so it never looks like a same-named class.
        label: basename(n.file),
        stereotype: "module",
        category: n.category,
        lines: [],
      };
      box.lines.push(memberLine(api.members[0], n.name));
      boxes.set(id, box);
      boxOf.set(n.displayName, id);
      continue;
    }
    const id = safeMermaidIdent(n.displayName);
    boxes.set(id, {
      id,
      label: n.displayName,
      stereotype:
        api.shape === "object"
          ? "object"
          : api.abstract
            ? "abstract"
            : n.category,
      category: n.category,
      lines: api.members.map((m) => memberLine(m)),
    });
    boxOf.set(n.displayName, id);

    // Inheritance — resolve the superclass through the file's imports.
    const info = cache.get(n.file)!;
    if (api.extends) {
      const r = resolveChild(n.file, info, api.extends, cache);
      const parent = r && displayNames.get(`${r.file}::${r.name}`);
      if (parent) inherit.push(`${parent}${"\u0000"}${n.displayName}`);
    }
  }

  const inheritIds = new Set(
    inherit.map((p) => {
      const [parent, child] = p.split("\u0000");
      return `${boxOf.get(child)}->${boxOf.get(parent)}`;
    }),
  );
  const usesIds = new Set<string>();
  for (const e of edges) {
    const from = boxOf.get(e.parent);
    const to = boxOf.get(e.child);
    if (!from || !to || from === to) continue;
    if (inheritIds.has(`${from}->${to}`)) continue;
    usesIds.add(`${from}->${to}`);
  }

  const render = (only?: Set<string>): string[] => {
    const lines = ["classDiagram", "    direction LR"];
    for (const b of boxes.values()) {
      if (only && !only.has(b.id)) continue;
      lines.push(`    class ${b.id}["${b.label}"] {`);
      lines.push(`        <<${b.stereotype}>>`);
      for (const l of b.lines) lines.push(`        ${l}`);
      lines.push(`    }`);
    }
    for (const p of inheritIds) {
      const [child, parent] = p.split("->");
      if (only && !only.has(child)) continue;
      lines.push(`    ${parent} <|-- ${child}`);
    }
    for (const p of usesIds) {
      const [from, to] = p.split("->");
      if (only && !only.has(from)) continue;
      lines.push(`    ${from} --> ${to}`);
    }
    return lines;
  };

  const intro = `# API

> Class diagram of the project's public shape: every **class** with its fields and methods, **object** literals with their members, and standalone **functions** grouped into one «module» box per file. \`+\` public · \`#\` protected · \`-\` private · \`*\` abstract · \`$\` static.
>
> Arrows: \`<|--\` extends · \`-->\` uses.`;

  let body: string;
  const big = boxes.size > SPLIT_CLASSES;
  if (!boxes.size) {
    body = "*(no classes, objects or functions found in the analyzed graph)*";
  } else if (!big) {
    body = "```mermaid\n" + render().join("\n") + "\n```";
  } else {
    const cats = [
      ...new Set([...boxes.values()].map((b) => b.category)),
    ].sort();
    const sections = [
      `> ⚠️ **${boxes.size} boxes** — too many for one readable class diagram, so it is split by category below.`,
    ];
    for (const cat of cats) {
      const ids = new Set(
        [...boxes.values()].filter((b) => b.category === cat).map((b) => b.id),
      );
      sections.push(
        `## ${cat} (${ids.size})\n\n\`\`\`mermaid\n${render(ids).join("\n")}\n\`\`\``,
      );
    }
    body = sections.join("\n\n");
  }

  await mkdir(docsDir, { recursive: true });
  await writeFile(join(docsDir, "Api.md"), `${intro}\n\n${body}\n`);
  console.error(
    `wrote Api.md (${boxes.size} boxes, ${inheritIds.size} extends, ${usesIds.size} uses${big ? " — split by category" : ""})`,
  );
}
