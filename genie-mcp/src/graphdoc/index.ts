#!/usr/bin/env node
/**
 * graphdoc-mcp — MCP server
 *
 * For React apps (Next.js / Remix / Vite / CRA) and plain JS/TS projects (Node.js,
 * Express, NestJS, libraries, CLIs). Gives AI agents (Cursor, VS Code, Claude Code,
 * Windsurf, etc.) a full understanding of a codebase — the entry root and all its
 * dependencies — through these tools:
 *
 *  1. detect_project    — identify the framework, source root, entry point
 *  2. analyze_project   — full pipeline: parse + emit all docs + onboarding guide
 *  3. onboard           — read existing docs and return a token-efficient briefing
 *  4. get_tree          — dependency tree (JSON + ASCII)
 *  5. get_graph         — all edges (list or Mermaid)
 *  6. get_unit          — deep info on one unit (component/hook/function/class)
 *  7. query_docs        — search generated docs by unit name or topic (no source reads)
 *  8. generate_graphdoc — full pipeline in one call, ends with Obsidian instructions
 *  9. read_unit_source  — return source code + auto-extracted TS props for a unit
 * 10. document_unit     — write description + props into a unit's doc file
 * 11. document_all_units — bulk: read all undocumented sources, then write all at once
 * 12. link_units        — persist a manual edge (survives regeneration)
 * 13. unlink_units      — remove a manual edge
 * 14. generate_module_graphdoc — scoped doc set for one module + its deps
 * 15. export_doc_state  — migrate existing docs/src into graphdoc.json (one-time)
 * 16. sync         — rebuild the WHOLE doc set (src + modules) from graphdoc.json
 *
 * Setup memory: all curated content + generate settings live in a single committed
 * `<docsDir>/graphdoc.json` (see state-store.ts). document_unit/document_all_units
 * write descriptions there; link_units/unlink_units write manual links; analyze_project/
 * generate_graphdoc record the generate settings + onboarding notes;
 * generate_module_graphdoc records each module. `sync` replays the file to rebuild
 * everything — so `docs/src/`, `docs/modules/` and the root pages can all be gitignored
 * and rebuilt identically on any device from just `graphdoc.json`.
 *
 * Onboarding is additive by default (pass rebuild:true to wipe docs/src).
 * includeSpecs (persisted in graphdoc.json) adds spec coverage for testers:
 * "Tested by" sections on unit pages + Tests.md.
 * styled(CustomComponent), barrel re-exports and dynamic import() are followed.
 */

import {
  McpServer,
  type ToolCallback,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodRawShape } from "zod";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, dirname, basename, isAbsolute } from "node:path";
import { extractPropsFromSource } from "./extract-props.js";

import { detectProject as detectSourceProject, noEntryMessage } from "./detect-project.js";
import { collectSpecs } from "./spec-analyzer.js";
import { loadPathAliases } from "./tsconfig-paths.js";
import {
  buildCache,
  buildTree,
  buildNameIndex,
  readManualTree,
  readDocsNameIndex,
  extendCache,
  ensureRootUnit,
  attachSpecsToTree,
  expandRoots,
  buildRootsCache,
  pickRootUnits,
  pinnedRootFiles,
  buildMultiTree,
  rootsLabel,
  printIndented,
  buildGraphData,
  buildOnboardingContext,
  subsetReachableFrom,
  analyze,
  type Tree,
} from "./analyzer.js";
import { capOutput, computeDisplayNames } from "./graph-core.js";
import {
  readState,
  writeState,
  writeDocsEntry,
  writeDocsEntries,
  setManualUses,
  recordAnalyze,
  isRealDoc,
  recordModule,
  relDocPathFor,
  nameIndexFromState,
  type GraphdocState,
  type UnitState,
} from "./state-store.js";
import type { FileInfo, SpecSummary } from "./types.js";
import { emitOnboarding } from "./emit-onboarding.js";
import { emitFolderDocs } from "./emit-folder-docs.js";
import { emitMermaid } from "./emit-mermaid.js";
import { emitGraph } from "./emit-graph.js";
import { emitMatrix } from "./emit-matrix.js";
import { emitApi } from "./emit-api.js";
import { configureGraphdocWrites, graphdocMkdir as mkdir, graphdocRm as rm, graphdocWriteFile as writeFile } from "./write-guard.js";

// Fail fast with a clear message on unsupported Node — old binaries otherwise
// die with cryptic syntax errors deep inside dependencies.
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 20) {
  console.error(
    `graphdoc-mcp requires Node >= 20 (running ${process.versions.node}). ` +
      `Point your MCP config's "command" at a newer node.`,
  );
  process.exit(1);
}

let server: McpServer;

// ─── tool registration ──────────────────────────────────────────────────────
// `server.tool()` is deprecated in the MCP SDK; every tool below goes through
// this thin wrapper onto `registerTool`, with behavior hints declared once
// here. readOnlyHint lets clients cache/parallelize safely; idempotentHint
// marks regeneration tools whose repeat calls converge to the same state.

export function registerGraphdocTools(
  serverInstance: McpServer,
  options: { root: string; graphdocDir: string },
): void {
  server = serverInstance;
  const workspaceRoot = options.root;
  const graphdocDir = options.graphdocDir;
  configureGraphdocWrites({ root: workspaceRoot, graphdocDir });

  function detectProject(workDir: string) {
    const detected = detectSourceProject(workDir);
    detected.docsDir = graphdocDir;
    return detected;
  }

const TOOL_ANNOTATIONS: Record<
  string,
  { readOnlyHint?: boolean; idempotentHint?: boolean }
> = {
  detect_project: { readOnlyHint: true },
  onboard: { readOnlyHint: true },
  get_tree: { readOnlyHint: true },
  get_graph: { readOnlyHint: true },
  get_unit: { readOnlyHint: true },
  query_docs: { readOnlyHint: true },
  read_unit_source: { readOnlyHint: true },
  analyze_project: { idempotentHint: true },
  generate_graphdoc: { idempotentHint: true },
  generate_module_graphdoc: { idempotentHint: true },
  sync: { idempotentHint: true },
  export_doc_state: { idempotentHint: true },
  document_unit: { idempotentHint: true },
  document_all_units: {},
  link_units: { idempotentHint: true },
  unlink_units: { idempotentHint: true },
};

function defineTool<S extends ZodRawShape>(
  name: string,
  description: string,
  inputSchema: S,
  cb: ToolCallback<S>,
): void {
  server.registerTool(
    name,
    { description, inputSchema, annotations: TOOL_ANNOTATIONS[name] ?? {} },
    cb,
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Wrap a tool's text result, capping it so a single response can never blow
 * past the model's context window. `hint` tells the caller how to get the rest.
 */
function ok(text: string, hint?: string) {
  return {
    content: [
      { type: "text" as const, text: capOutput(text, undefined, hint) },
    ],
  };
}
function err(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text" as const, text: `❌ ${msg}` }],
    isError: true,
  };
}

/** Validate + default the working directory. Paths must be absolute when given. */
function resolveWorkDir(workDir?: string): string {
  if (workDir !== undefined && !isAbsolute(workDir)) {
    throw new Error(`workDir must be an absolute path (got "${workDir}").`);
  }
  return workDir ?? process.cwd();
}

/** Guard an optional rootFile override. */
function checkRootFile(rootFile?: string): void {
  if (rootFile !== undefined && !isAbsolute(rootFile)) {
    throw new Error(`rootFile must be an absolute path (got "${rootFile}").`);
  }
}

/**
 * Redirect where docs are written/read. When `outDir` is given it replaces the
 * default `<repo>/docs` on the detected info, so every downstream use (emitters,
 * per-unit pages, onboarding, search) targets that location — which may live
 * anywhere, including outside the repository. Mutates `detected` in place.
 */
function applyOutDir(detected: { docsDir: string }, outDir?: string): void {
  if (outDir === undefined) return;
  if (!isAbsolute(outDir)) {
    throw new Error(`outDir must be an absolute path (got "${outDir}").`);
  }
  detected.docsDir = outDir;
}

/** Standard schema description for the outDir override. */
const OUT_DIR_DESC =
  "Absolute path for the docs directory (default: <repo>/docs). Set this to write/read the documentation anywhere, including outside the repository.";

/**
 * Locate the file defining `unitName`. With a `fileHint` (repo-relative or
 * absolute path, as shown in read_unit_source / document_all_units output),
 * the exact file is targeted — this is how same-named units in different files
 * each get their own doc page instead of all writing to the first match.
 * Cache entries are scanned in sorted order so the no-hint fallback is stable.
 */
function findUnitFile(
  cache: Map<string, FileInfo>,
  unitName: string,
  fileHint?: string,
): string | null {
  const entries = [...cache.entries()]
    .filter(([, info]) => info.units.has(unitName))
    .sort((a, b) => a[0].localeCompare(b[0]));
  if (entries.length === 0) return null;
  if (fileHint) {
    const norm = fileHint.replace(/\\/g, "/");
    const hit = entries.find(([f]) => {
      const fp = f.replace(/\\/g, "/");
      return fp === norm || fp.endsWith("/" + norm) || fp.endsWith(norm);
    });
    if (hit) return hit[0];
  }
  return entries[0][0];
}

/** All files that define `unitName`, sorted (deterministic). */
function unitFilesFor(
  cache: Map<string, FileInfo>,
  unitName: string,
): string[] {
  return [...cache.entries()]
    .filter(([, info]) => info.units.has(unitName))
    .map(([f]) => f)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve which file a tool should act on for `unitName`.
 * - 0 matches → { error } with the available list.
 * - exact `fileHint` → that file.
 * - 1 match → that file.
 * - >1 and no hint → { ambiguous } message listing each variant's display name + path.
 */
function selectUnitFile(
  cache: Map<string, FileInfo>,
  srcRoot: string,
  repoRoot: string,
  unitName: string,
  fileHint?: string,
): { file: string } | { ambiguous: string } | { notFound: true } {
  const files = unitFilesFor(cache, unitName);
  if (files.length === 0) return { notFound: true };
  if (fileHint) {
    const hit = findUnitFile(cache, unitName, fileHint);
    if (hit) return { file: hit };
  }
  if (files.length === 1) return { file: files[0] };
  const dnames = computeDisplayNames(cache, srcRoot);
  const variants = files
    .map(
      (f) =>
        `  • ${dnames.get(`${f}::${unitName}`) ?? unitName}   file: ${relative(repoRoot, f)}`,
    )
    .join("\n");
  return {
    ambiguous:
      `"${unitName}" is defined in ${files.length} files — specify one:\n${variants}\n` +
      `Re-call with file=<one of the paths above> (or use the qualified name shown).`,
  };
}

// Shared detection + cache-building used by most tools. Honors the multi-root
// `roots` setting from graphdoc.json unless an explicit rootFile is given.
async function setup(
  workDir?: string,
  rootFile?: string,
  rootName?: string,
  styledComponents?: boolean,
  outDir?: string,
) {
  const dir = resolveWorkDir(workDir);
  checkRootFile(rootFile);
  const detected = detectProject(dir);
  applyOutDir(detected, outDir);
  const aliases = loadPathAliases(detected.repoRoot);
  const opts = cacheOpts(detected, styledComponents);

  const roots = rootFile
    ? undefined
    : (await readState(detected.docsDir)).analyze.roots;
  if (roots?.length) {
    const files = expandRoots(roots, detected.repoRoot);
    const cache = await buildRootsCache(files, detected.srcRoot, aliases, opts);
    const rootUnits = pickRootUnits(
      cache,
      files,
      detected.srcRoot,
      pinnedRootFiles(roots, detected.repoRoot, files),
    );
    const rn = rootName ?? rootsLabel(roots);
    return { detected, rf: "", rn, cache, rootUnits };
  }

  const rf = rootFile ?? detected.rootFile;
  const rn = rootName ?? detected.rootName;
  if (!rf) throw new Error(noEntryMessage(detected));
  const cache = await buildCache(detected.srcRoot, rf, aliases, opts);
  ensureRootUnit(cache, rf, rn);
  return { detected, rf, rn, cache, rootUnits: undefined };
}

/**
 * Effective multi-root setting: the tool argument when given (`[]` clears it),
 * else the value stored in graphdoc.json. Normalized to repo-relative paths.
 */
async function resolveRoots(
  detected: ReturnType<typeof detectProject>,
  roots?: string[],
): Promise<string[] | undefined> {
  const raw = roots ?? (await readState(detected.docsDir)).analyze.roots;
  if (!raw?.length) return undefined;
  return raw.map((r) =>
    (isAbsolute(r) ? relative(detected.repoRoot, r) : r).replace(/\\/g, "/"),
  );
}

const ROOTS_DESC =
  "Multi-root mode for projects with no single entry point: folders (or files) whose files are independent roots, e.g. ['src/pages'] — repo-relative or absolute. Every file directly inside them is its own root (even if another page imports it); files in subfolders become roots only if nothing else imports them (a page's private fragments stay nested); all are documented in ONE doc set (Tree.md shows them side by side, never artificially connected). Overrides rootFile. Persisted in graphdoc.json (analyze.roots); when omitted the stored value is used, pass [] to switch back to the single entry.";

/** Per-file analyzer options for a detected project. */
function cacheOpts(
  detected: ReturnType<typeof detectProject>,
  styledComponents?: boolean,
) {
  return { styledComponents, projectKind: detected.kind };
}

const INCLUDE_SPECS_DESC =
  "For testers: also scan spec/test files (*.spec.*, *.test.*, __tests__/) and document which units each spec covers — adds a 'Tested by' section with test case titles to every unit page plus Tests.md (coverage map + untested units). Persisted in graphdoc.json (analyze.includeSpecs); when omitted, the stored value is used.";

/** Spec summary lines for tool output (empty when specs are off). */
function specLines(stats: { specs?: SpecSummary }): string[] {
  const sp = stats.specs;
  if (!sp) return [];
  return [
    `Specs     : ${sp.files} files, ${sp.tests} test cases, ${sp.coveredUnits}/${sp.totalUnits} units covered (Tests.md)`,
  ];
}

// ─── Tool 1: detect_project ───────────────────────────────────────────────

defineTool(
  "detect_project",
  "Auto-detect the framework, source root, and entry point from any directory. Recognizes React apps (Next.js, Remix, React (Vite), Create React App) and plain JS/TS projects (Node.js, Express, NestJS, Fastify, Koa, libraries, CLIs — entry taken from package.json main/bin/exports, mapped back to source).",
  {
    workDir: z
      .string()
      .optional()
      .describe("Absolute path to the project or any subdirectory."),
  },
  async ({ workDir }) => {
    try {
      const dir = resolveWorkDir(workDir);
      const info = detectProject(dir);
      return ok(
        [
          `✅ Project detected`,
          ``,
          `Framework : ${info.framework}`,
          `Kind      : ${info.kind === "react" ? "React app" : "plain JS/TS"}`,
          `Language  : ${info.language}`,
          `repoRoot  : ${info.repoRoot}`,
          `srcRoot   : ${relative(info.repoRoot, info.srcRoot)}`,
          `rootFile  : ${info.rootFile ? relative(info.repoRoot, info.rootFile) : "(none found — pass roots=['src/pages'] for a folder of independent roots, or rootFile)"}`,
          `rootName  : ${info.rootName}`,
          `docsDir   : ${relative(info.repoRoot, info.docsDir)}`,
        ].join("\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 2: analyze_project ──────────────────────────────────────────────

defineTool(
  "analyze_project",
  "Full pipeline: auto-detect the project, parse all source files, build the dependency graph, emit Tree.md / Graph.md / Matrix.md / Api.md / per-unit docs / ONBOARDING.md into docs/. Run this once to set up the codebase for efficient AI navigation.",
  {
    workDir: z.string().optional(),
    rootFile: z
      .string()
      .optional()
      .describe("Override entry file (absolute path)."),
    rootName: z.string().optional().describe("Override root unit name."),
    styledComponents: z
      .boolean()
      .optional()
      .describe(
        "Include native-tag styled-components (styled.div/.View) as units too. styled(CustomComponent) edges are always captured regardless. Off by default.",
      ),
    includeSpecs: z.boolean().optional().describe(INCLUDE_SPECS_DESC),
    roots: z.array(z.string()).optional().describe(ROOTS_DESC),
    rebuild: z
      .boolean()
      .optional()
      .describe(
        "Wipe docs/src before regenerating. Default false = additive: pages outside the analyzed graph are kept, not deleted.",
      ),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({
    workDir,
    rootFile,
    rootName,
    styledComponents,
    includeSpecs,
    roots,
    rebuild,
    outDir,
  }) => {
    try {
      const dir = resolveWorkDir(workDir);
      checkRootFile(rootFile);
      const detected = detectProject(dir);
      applyOutDir(detected, outDir);
      const effRoots = await resolveRoots(detected, roots);
      if (!effRoots && !rootFile && !detected.rootFile)
        throw new Error(noEntryMessage(detected));
      const opts = {
        srcRoot: detected.srcRoot,
        rootFile: rootFile ?? detected.rootFile,
        rootName:
          rootName ?? (effRoots ? rootsLabel(effRoots) : detected.rootName),
        docsDir: detected.docsDir,
        repoRoot: detected.repoRoot,
        framework: detected.framework,
        language: detected.language,
        styledComponents,
        projectKind: detected.kind,
        // Unset → fall back to the project config stored in graphdoc.json.
        includeSpecs:
          includeSpecs ??
          (await readState(detected.docsDir)).analyze.includeSpecs,
        roots: effRoots,
        rebuild,
      };
      const result = await analyze(dir, opts);
      const { nodes, edges } = buildGraphData(result.cache, detected.srcRoot);
      const treeData = result.tree[opts.rootName] ?? {};
      const ctx = buildOnboardingContext(
        result.cache,
        detected.srcRoot,
        {
          ...detected,
          rootFile: opts.rootFile,
          rootName: opts.rootName,
          roots: effRoots,
        },
        treeData,
        result.specs,
      );
      await emitOnboarding(ctx, detected.docsDir, {
        stateDir: detected.docsDir,
        noteKey: "",
      });

      // Record generate settings into graphdoc.json ("setup memory"). Store
      // rootFile repo-relative so the committed file stays device-portable.
      await recordAnalyze(
        detected.docsDir,
        {
          rootFile: rootFile ? relative(detected.repoRoot, rootFile) : null,
          rootName: rootName ?? null,
          styledComponents: !!styledComponents,
          includeSpecs: !!opts.includeSpecs,
          ...(effRoots ? { roots: effRoots } : {}),
        },
        relative(detected.docsDir, detected.repoRoot),
      );

      return ok(
        [
          `✅ Analysis complete — ${detected.framework} project`,
          ``,
          ...(effRoots
            ? [
                `Roots     : ${effRoots.join(", ")} → ${Object.keys(treeData).filter((k) => !k.startsWith("🧪 ")).length} independent roots`,
              ]
            : []),
          `Files     : ${result.stats.files}`,
          `Units     : ${result.stats.units}`,
          `Edges     : ${edges.length}`,
          ...specLines(result),
          `Docs      : ${detected.docsDir}`,
          ``,
          `Generated:`,
          `  • ONBOARDING.md  — newcomer + AI agent briefing`,
          `  • Tree.md        — dependency mindmap`,
          `  • Graph.md       — full DAG`,
          `  • Matrix.md      — dependency matrix`,
          `  • Api.md         — prop/param class diagram`,
          ...(result.specs
            ? [
                `  • Tests.md       — spec coverage map for testers`,
                `  • docs/specs/    — one page per spec, linked to its units`,
              ]
            : []),
          `  • docs/src/      — per-unit wiki pages`,
          ``,
          result.treeText,
        ].join("\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 3: onboard ──────────────────────────────────────────────────────

defineTool(
  "onboard",
  "Read the pre-generated ONBOARDING.md and return a token-efficient briefing for navigating the codebase. Call this at the START of any session before touching source files — it tells you what to look at and in what order. If docs don't exist yet, call analyze_project first.",
  {
    workDir: z.string().optional(),
    format: z
      .enum(["full", "compact"])
      .default("compact")
      .describe(
        "'compact' = just the snapshot + hotspots + navigation guide (fastest). 'full' = entire ONBOARDING.md.",
      ),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, format, outDir }) => {
    try {
      const dir = resolveWorkDir(workDir);
      const detected = detectProject(dir);
      applyOutDir(detected, outDir);
      const onboardingPath = join(detected.docsDir, "ONBOARDING.md");

      if (!existsSync(onboardingPath)) {
        return ok(
          `⚠️  No ONBOARDING.md found at ${onboardingPath}.\n\n` +
            `Run analyze_project first to generate documentation.\n\n` +
            `Quick detect result:\n` +
            `  Framework : ${detected.framework}\n` +
            `  Language  : ${detected.language}\n` +
            `  Entry     : ${detected.rootFile ? relative(detected.repoRoot, detected.rootFile) : "(none — use roots)"}`,
        );
      }

      const content = await readFile(onboardingPath, "utf8");

      if (format === "full") return ok(content);

      // Compact: extract Project Snapshot + Hotspots + AI Agent Instructions sections
      const sections = [
        "## Project Snapshot",
        "## High-Reuse Units",
        "## Instructions for AI Agents",
      ];
      const parts: string[] = [`# Codebase Briefing (compact)\n`];

      for (const section of sections) {
        const start = content.indexOf(section);
        if (start === -1) continue;
        // Find next ## heading
        const nextH2 = content.indexOf("\n## ", start + 4);
        const chunk =
          nextH2 !== -1 ? content.slice(start, nextH2) : content.slice(start);
        parts.push(chunk.trim());
      }

      parts.push(`\n---\n*Run onboard(format="full") for the complete guide.*`);
      return ok(parts.join("\n\n"));
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 4: get_tree ─────────────────────────────────────────────────────

defineTool(
  "get_tree",
  "Return the unit dependency tree as JSON and/or ASCII. Does NOT write any files.",
  {
    workDir: z.string().optional(),
    rootFile: z.string().optional(),
    rootName: z.string().optional(),
    format: z.enum(["both", "json", "ascii"]).default("ascii"),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, rootFile, rootName, format, outDir }) => {
    try {
      const { detected, rf, rn, cache, rootUnits } = await setup(
        workDir,
        rootFile,
        rootName,
        undefined,
        outDir,
      );
      const manualEdges = await readManualTree(detected.docsDir);
      const docsIndex = await readDocsNameIndex(
        detected.docsDir,
        detected.repoRoot,
      );
      const seeds = [...new Set([...manualEdges.values()].flat())]
        .map((n) => docsIndex.get(n))
        .filter((f): f is string => !!f);
      await extendCache(
        cache,
        seeds,
        detected.srcRoot,
        loadPathAliases(detected.repoRoot),
        cacheOpts(detected),
      );
      const manual = {
        edges: manualEdges,
        nameToFile: buildNameIndex(cache),
      };
      const treeData = rootUnits
        ? await buildMultiTree(
            rootUnits,
            cache,
            manual,
            computeDisplayNames(cache, detected.srcRoot),
          )
        : await buildTree(rf, rn, new Set(), cache, manual);
      const tree: Tree = { [rn]: treeData };
      // includeSpecs (graphdoc.json): show 🧪 spec leaves under tested units.
      if ((await readState(detected.docsDir)).analyze.includeSpecs) {
        const specs = await collectSpecs({
          repoRoot: detected.repoRoot,
          docsDir: detected.docsDir,
          cache,
          aliases: loadPathAliases(detected.repoRoot),
        });
        attachSpecsToTree(
          tree,
          cache,
          detected.srcRoot,
          detected.repoRoot,
          specs,
        );
      }
      const parts: string[] = [];
      if (format === "json" || format === "both")
        parts.push(
          "### JSON\n```json\n" + JSON.stringify(tree, null, 2) + "\n```",
        );
      if (format === "ascii" || format === "both")
        parts.push(
          "### ASCII Tree\n```\n" + printIndented(rn, treeData) + "\n```",
        );
      return ok(
        parts.join("\n\n"),
        "Pass rootFile to scope to a subtree, or use get_unit for one unit.",
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 5: get_graph ────────────────────────────────────────────────────

defineTool(
  "get_graph",
  "Return all dependency edges between units. 'edges' = plain list, 'mermaid' = flowchart code block.",
  {
    workDir: z.string().optional(),
    rootFile: z.string().optional(),
    rootName: z.string().optional(),
    format: z.enum(["edges", "mermaid", "both"]).default("edges"),
  },
  async ({ workDir, rootFile, rootName, format }) => {
    try {
      const { detected, cache } = await setup(workDir, rootFile, rootName);
      const { nodes, edges } = buildGraphData(cache, detected.srcRoot);
      const parts: string[] = [];
      if (format === "edges" || format === "both") {
        const lines = edges
          .sort(
            (a, b) =>
              a.parent.localeCompare(b.parent) ||
              a.child.localeCompare(b.child),
          )
          .map((e) => `${e.parent} → ${e.child}`);
        parts.push(
          `### Edges (${edges.length} total, ${nodes.length} units)\n` +
            lines.join("\n"),
        );
      }
      if (format === "mermaid" || format === "both") {
        const mLines = [
          "flowchart LR",
          ...edges.map((e) => `  ${e.parent} --> ${e.child}`),
        ];
        parts.push("### Mermaid\n```mermaid\n" + mLines.join("\n") + "\n```");
      }
      return ok(
        parts.join("\n\n"),
        "Use the generated docs/Matrix.md for the full edge list, or get_unit for one unit.",
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 6: get_unit ────────────────────────────────────────────────────

defineTool(
  "get_unit",
  "Get detailed information about a single unit (component / class / function / service): what it depends on, what depends on it, its kind, its file, and its doc comment. Token-efficient — no source code returned.",
  {
    workDir: z.string().optional(),
    rootFile: z.string().optional(),
    rootName: z.string().optional(),
    unitName: z
      .string()
      .describe(
        "Name of the unit to look up, e.g. 'ProductCard', 'UserService', 'parseDate'.",
      ),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, rootFile, rootName, unitName, outDir }) => {
    try {
      const { detected, cache } = await setup(
        workDir,
        rootFile,
        rootName,
        undefined,
        outDir,
      );
      const { nodes, edges } = buildGraphData(cache, detected.srcRoot);

      // Match by display name (e.g. "ui/Button") first, else by bare name.
      let node = nodes.find((n) => n.displayName === unitName);
      if (!node) {
        const byBare = nodes.filter((n) => n.name === unitName);
        if (byBare.length === 0) {
          const all = [...new Set(nodes.map((n) => n.displayName))]
            .sort()
            .join(", ");
          return ok(
            `Unit "${unitName}" not found.\n\nAvailable units:\n${all}`,
            "Use a name from the list (qualified names like `ui/Button` disambiguate collisions).",
          );
        }
        if (byBare.length > 1) {
          const variants = byBare
            .map(
              (n) =>
                `  • ${n.displayName}   file: ${relative(detected.repoRoot, n.file)}`,
            )
            .join("\n");
          return ok(
            `"${unitName}" is defined in ${byBare.length} files — pick one:\n${variants}\n\nRe-call get_unit with the qualified name (e.g. unitName="${byBare[0].displayName}").`,
          );
        }
        node = byBare[0];
      }

      const fileInfo = cache.get(node.file);
      const unit = fileInfo?.units.get(node.name);
      const uses = edges
        .filter((e) => e.parent === node!.displayName)
        .map((e) => e.child)
        .sort();
      const usedBy = edges
        .filter((e) => e.child === node!.displayName)
        .map((e) => e.parent)
        .sort();

      // Check if a doc page exists
      const relFile = relative(detected.srcRoot, node.file).replace(
        /\.[^.]+$/,
        "",
      );
      const docPath = join(detected.docsDir, "src", relFile + ".md");
      const hasDocPage = existsSync(docPath);

      return ok(
        [
          `## ${node.displayName}`,
          node.colliding
            ? `*(name "${node.name}" collides across files — this is the \`${node.displayName}\` variant)*`
            : undefined,
          ``,
          `**Kind**        : ${unit?.kind ?? "unknown"}`,
          `**Language**    : ${fileInfo?.language ?? "unknown"}`,
          `**Category**    : ${node.category}`,
          `**File**        : ${relative(detected.repoRoot, node.file)}`,
          hasDocPage ? `**Doc page**    : docs/src/${relFile}.md` : undefined,
          ``,
          `**Description** : ${unit?.description ?? "_(no doc comment found)_"}`,
          ``,
          `**Uses** (${uses.length})    : ${uses.length ? uses.join(", ") : "none — leaf unit"}`,
          `**Used by** (${usedBy.length}) : ${usedBy.length ? usedBy.join(", ") : "none — root or isolated"}`,
        ]
          .filter((l): l is string => l !== undefined)
          .join("\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 7: query_docs ──────────────────────────────────────────────────

defineTool(
  "query_docs",
  "Search the generated docs/ folder for information about a unit or topic WITHOUT reading source files. Token-efficient: reads pre-digested markdown summaries only. Call onboard() first for the top-level map, then query_docs() for specific units.",
  {
    workDir: z.string().optional(),
    query: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "Unit name or topic to search for. Examples: 'UserCard', 'authentication', 'Button'.",
      ),
    maxResults: z.number().int().min(1).max(20).default(5),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, query, maxResults, outDir }) => {
    try {
      const dir = resolveWorkDir(workDir);
      const detected = detectProject(dir);
      applyOutDir(detected, outDir);
      const docsSrcDir = join(detected.docsDir, "src");

      if (!existsSync(docsSrcDir)) {
        return ok(
          `⚠️  No docs found at ${docsSrcDir}.\nRun analyze_project first.`,
        );
      }

      // Walk docs/src/ and collect matching .md files
      async function walkMd(d: string): Promise<string[]> {
        const results: string[] = [];
        try {
          const entries = await readdir(d, { withFileTypes: true });
          for (const e of entries) {
            const full = join(d, e.name);
            if (e.isDirectory()) results.push(...(await walkMd(full)));
            else if (e.isFile() && e.name.endsWith(".md")) results.push(full);
          }
        } catch {
          /* ignore */
        }
        return results;
      }

      const allDocs = await walkMd(docsSrcDir);
      const queryLower = query.toLowerCase();

      type Match = { file: string; score: number; snippet: string };
      const matches: Match[] = [];

      for (const docFile of allDocs) {
        const name =
          docFile.replace(/\\/g, "/").split("/").pop()?.replace(".md", "") ??
          "";
        let score = 0;

        // Exact name match = highest score
        if (name.toLowerCase() === queryLower) score += 100;
        else if (name.toLowerCase().includes(queryLower)) score += 50;

        // Content match
        let content = "";
        try {
          content = await readFile(docFile, "utf8");
        } catch {
          continue;
        }

        const contentLower = content.toLowerCase();
        if (contentLower.includes(queryLower)) score += 10;

        // Boost for query in description or uses/used-by sections
        const descMatch =
          content.match(/\*\*Description\*\*[^\n]*/i)?.[0] ?? "";
        if (descMatch.toLowerCase().includes(queryLower)) score += 20;

        if (score === 0) continue;

        // Build a short snippet: first 600 chars of doc, trimmed
        const trimmed = content
          .replace(/^---[\s\S]+?---\n/, "") // strip frontmatter
          .trim()
          .slice(0, 600);

        matches.push({
          file: relative(detected.docsDir, docFile),
          score,
          snippet: trimmed,
        });
      }

      if (matches.length === 0) {
        return ok(
          `No docs found matching "${query}".\n\nTry a unit name like 'Button' or 'UserService'.`,
        );
      }

      matches.sort((a, b) => b.score - a.score);
      const top = matches.slice(0, maxResults);

      const parts = top.map(
        (m, i) =>
          `### ${i + 1}. ${m.file}\n\n${m.snippet}${m.snippet.length >= 600 ? "\n\n*(truncated — read full file for details)*" : ""}`,
      );

      return ok(
        `Found ${matches.length} doc(s) matching "${query}" — showing top ${top.length}:\n\n` +
          parts.join("\n\n---\n\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 8: generate_graphdoc ────────────────────────────────────────────────
//
// One command that runs the full pipeline in order:
//   detect → analyze → generate docs → onboarding briefing → Obsidian instructions

defineTool(
  "generate_graphdoc",
  "Generate full GraphDoc documentation for a React app or plain JS/TS project (Node.js, Express, NestJS, libraries) in one command — the entry root and all its dependencies. Runs the whole pipeline: detect framework → analyze all source files → generate structured docs (Tree, Graph, Matrix, API, per-unit pages) → produce an onboarding guide → explain how to open docs in Obsidian. Call this whenever someone says 'generate docs', 'generate graphdoc', 'onboard me', 'explain this project', 'help me understand this codebase', or 'set this project up for me'.",
  {
    workDir: z
      .string()
      .optional()
      .describe(
        "Absolute path to the project root. Defaults to current directory.",
      ),
    rootFile: z
      .string()
      .optional()
      .describe("Override the detected entry file (absolute path)."),
    rootName: z
      .string()
      .optional()
      .describe("Override the detected root unit name, e.g. 'App'."),
    styledComponents: z
      .boolean()
      .optional()
      .describe(
        "Include native-tag styled-components (styled.div/.View) as units too. styled(CustomComponent) edges are always captured regardless. Off by default.",
      ),
    includeSpecs: z.boolean().optional().describe(INCLUDE_SPECS_DESC),
    roots: z.array(z.string()).optional().describe(ROOTS_DESC),
    rebuild: z
      .boolean()
      .optional()
      .describe(
        "Wipe docs/src before regenerating. Default false = additive: onboarding one root keeps previously generated pages instead of deleting them.",
      ),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({
    workDir,
    rootFile,
    rootName,
    styledComponents,
    includeSpecs,
    roots,
    rebuild,
    outDir,
  }) => {
    try {
      const dir = resolveWorkDir(workDir);
      checkRootFile(rootFile);
      const out: string[] = [];

      // ── Step 1: detect ────────────────────────────────────────────────────
      out.push("## Step 1 / 3 — Detecting project…\n");
      const detected = detectProject(dir);
      applyOutDir(detected, outDir);
      const effRoots = await resolveRoots(detected, roots);
      if (!effRoots && !rootFile && !detected.rootFile)
        throw new Error(noEntryMessage(detected));
      out.push(
        `✅ **${detected.framework}** (${detected.language})\n` +
          (effRoots
            ? `   Roots    : ${effRoots.join(", ")} (independent roots, no single entry)\n`
            : `   Entry    : ${relative(detected.repoRoot, rootFile ?? detected.rootFile)}\n`) +
          `   Src root : ${relative(detected.repoRoot, detected.srcRoot)}\n` +
          `   Docs dir : ${relative(detected.repoRoot, detected.docsDir)}\n`,
      );

      // ── Step 2: analyze ───────────────────────────────────────────────────
      out.push("## Step 2 / 3 — Analyzing codebase…\n");
      const opts = {
        srcRoot: detected.srcRoot,
        rootFile: rootFile ?? detected.rootFile,
        rootName:
          rootName ?? (effRoots ? rootsLabel(effRoots) : detected.rootName),
        docsDir: detected.docsDir,
        repoRoot: detected.repoRoot,
        framework: detected.framework,
        language: detected.language,
        styledComponents,
        projectKind: detected.kind,
        // Unset → fall back to the project config stored in graphdoc.json.
        includeSpecs:
          includeSpecs ??
          (await readState(detected.docsDir)).analyze.includeSpecs,
        roots: effRoots,
        rebuild,
      };

      const result = await analyze(dir, opts);
      const { edges } = buildGraphData(result.cache, detected.srcRoot);
      const treeData = result.tree[opts.rootName] ?? {};
      const ctx = buildOnboardingContext(
        result.cache,
        detected.srcRoot,
        {
          ...detected,
          rootFile: opts.rootFile,
          rootName: opts.rootName,
          roots: effRoots,
        },
        treeData,
        result.specs,
      );
      await emitOnboarding(ctx, detected.docsDir, {
        stateDir: detected.docsDir,
        noteKey: "",
      });

      // Record generate settings into graphdoc.json ("setup memory").
      await recordAnalyze(
        detected.docsDir,
        {
          rootFile: rootFile ? relative(detected.repoRoot, rootFile) : null,
          rootName: rootName ?? null,
          styledComponents: !!styledComponents,
          includeSpecs: !!opts.includeSpecs,
          ...(effRoots ? { roots: effRoots } : {}),
        },
        relative(detected.docsDir, detected.repoRoot),
      );

      out.push(
        `✅ Analysis complete\n` +
          `   Files  : ${result.stats.files}\n` +
          `   Units  : ${result.stats.units}\n` +
          `   Edges  : ${edges.length}\n` +
          (result.specs
            ? `   Specs  : ${result.specs.files} files, ${result.specs.tests} test cases, ${result.specs.coveredUnits}/${result.specs.totalUnits} units covered\n`
            : "") +
          `\n` +
          `   Generated:\n` +
          `   • docs/ONBOARDING.md\n` +
          `   • docs/Tree.md\n` +
          `   • docs/Graph.md\n` +
          `   • docs/Matrix.md\n` +
          `   • docs/Api.md\n` +
          (result.specs
            ? `   • docs/Tests.md\n   • docs/specs/ (${result.specs.files} spec pages)\n`
            : "") +
          `   • docs/src/   (${result.stats.units} unit pages)\n`,
      );

      // ── Step 3: onboarding briefing ───────────────────────────────────────
      out.push("## Step 3 / 3 — Onboarding briefing\n");
      const onboardingPath = join(detected.docsDir, "ONBOARDING.md");
      const onboardingContent = await readFile(onboardingPath, "utf8");

      // Pull out the three most useful sections for a compact briefing
      const sections = [
        "## Project Snapshot",
        "## High-Reuse Units",
        "## Instructions for AI Agents",
      ];
      for (const section of sections) {
        const start = onboardingContent.indexOf(section);
        if (start === -1) continue;
        const nextH2 = onboardingContent.indexOf("\n## ", start + 4);
        const chunk =
          nextH2 !== -1
            ? onboardingContent.slice(start, nextH2)
            : onboardingContent.slice(start);
        out.push(chunk.trim() + "\n");
      }

      // ── Obsidian instructions ─────────────────────────────────────────────
      const absDocsDir = detected.docsDir;
      const relDocsDir = relative(detected.repoRoot, absDocsDir);
      const vaultFolderName =
        detected.framework.toLowerCase().replace(/[^a-z0-9]/g, "-") + "-docs";

      out.push(`---

## 📂 Add to Obsidian

Your docs are plain Markdown with \`[[wiki-links]]\` and Mermaid diagrams —
both work in Obsidian with zero plugins.

### Option A — Open docs folder as a vault (quickest)

1. Open Obsidian → **Open folder as vault**
2. Select:
   \`\`\`
   ${absDocsDir}
   \`\`\`
3. Done — all links and diagrams render immediately.

### Option B — Add inside an existing vault

\`\`\`bash
# Copy into your vault (safe, works everywhere):
cp -r ${absDocsDir} "<your-vault>/${vaultFolderName}"

# OR symlink so it stays in sync automatically (macOS / Linux):
ln -s ${absDocsDir} "<your-vault>/${vaultFolderName}"
\`\`\`

Then press **Cmd / Ctrl + R** to reload Obsidian.

### Option C — Commit and share with the team (recommended)

\`\`\`bash
git add ${relDocsDir}/
git commit -m "docs: add graphdoc-mcp onboarding documentation"
git push
\`\`\`

Every developer opens \`${relDocsDir}/\` as their vault after pulling.
Re-run \`setup\` after major refactors — hand-written blocks inside
\`<!-- ONBOARD:START -->\` and \`<!-- DOCS:START -->\` are always preserved.

### Useful Obsidian features for these docs

| Feature | How to use it |
|---|---|
| **Graph view** | Built-in — mirrors your dependency graph visually |
| **Mermaid diagrams** | Built-in since v0.14 — Tree/Graph/Api/Matrix all render |
| **Dataview plugin** | Query unit pages: \`LIST WHERE type = "component"\` |
| **Backlinks panel** | Shows every page that links to the current unit |

Start reading from **ONBOARDING.md** — it links to everything else.`);

      return ok(out.join("\n"));
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 9: read_unit_source ─────────────────────────────────────────────

defineTool(
  "read_unit_source",
  "Return the source code of a unit (component / class / function) so you can analyze it and write a description. Also auto-extracts TypeScript props if a *Props interface or type is found. Call this before document_unit.",
  {
    workDir: z.string().optional(),
    unitName: z
      .string()
      .describe(
        "Name of the unit whose source you want, e.g. 'Button', 'UserService'.",
      ),
    file: z
      .string()
      .optional()
      .describe(
        "Repo-relative or absolute source path to disambiguate same-named units (use the **File** value shown in output).",
      ),
    rootFile: z
      .string()
      .optional()
      .describe(
        "Root file to analyze from (absolute path). Needed for units not reachable from the default entry, e.g. AEM-mapped or lazily-imported pages.",
      ),
    rootName: z.string().optional().describe("Root unit name override."),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, unitName, file, rootFile, rootName, outDir }) => {
    try {
      const { detected, cache } = await setup(
        workDir,
        rootFile,
        rootName,
        undefined,
        outDir,
      );

      const sel = selectUnitFile(
        cache,
        detected.srcRoot,
        detected.repoRoot,
        unitName,
        file,
      );
      if ("ambiguous" in sel) return ok(sel.ambiguous);
      if ("notFound" in sel) {
        const all = [
          ...new Set([...cache.values()].flatMap((i) => [...i.units.keys()])),
        ]
          .sort()
          .join(", ");
        return ok(
          `Unit "${unitName}" not found.\n\nAvailable units:\n${all}\n\nTip: if it's an AEM-mapped or lazily-imported page, pass rootFile pointing at its entry (e.g. the page's .tsx).`,
        );
      }
      const unitFile = sel.file;

      const source = await readFile(unitFile, "utf8").catch(() => null);
      if (!source) return ok(`Could not read source for "${unitName}".`);

      const fileInfo = cache.get(unitFile);
      const unit = fileInfo?.units.get(unitName);
      // Props come from analysis (unit.props); re-parse only if not cached.
      const props =
        unit?.props ?? (await extractPropsFromSource(unitFile, unitName));

      const relFile = relative(detected.repoRoot, unitFile);
      const docsSrcDir = join(detected.docsDir, "src");
      const docRelDir = relative(detected.srcRoot, dirname(unitFile));
      const docFile = join(docsSrcDir, docRelDir, `${unitName}.md`);
      const hasDocPage = existsSync(docFile);

      const parts: string[] = [
        `## ${unitName}`,
        ``,
        `**File** : \`${relFile}\``,
        `**Kind** : ${unit?.kind ?? "unknown"}`,
        `**Current description** : ${unit?.description ?? "_(none — no leading doc comment in source)_"}`,
        hasDocPage
          ? `**Doc page** : \`${relative(detected.repoRoot, docFile)}\``
          : "",
        ``,
        props.length > 0
          ? `**Auto-extracted props** : ${props.map((p) => `\`${p}\``).join(", ")}`
          : "",
        props.length > 0 ? `` : "",
        `### Source (\`${relFile}\`)`,
        ``,
        "```" + (fileInfo?.language ?? "ts"),
        source,
        "```",
        ``,
        `---`,
        `After analyzing, call \`document_unit\` with unitName="${unitName}", a description, and (if applicable) a props list.`,
      ].filter((l) => l !== undefined);

      return ok(
        parts.join("\n"),
        "Source truncated — open the file directly for the full implementation.",
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 10: document_unit ───────────────────────────────────────────────

defineTool(
  "document_unit",
  "Write a description and optional props list for a unit into graphdoc.json (the committed source of truth). The per-unit .md page is NOT written here — run `sync` (or generate_graphdoc) to materialize the JSON into pages. Use after read_unit_source to analyze the unit.",
  {
    workDir: z.string().optional(),
    unitName: z
      .string()
      .describe("Name of the unit to document, e.g. 'Button'."),
    description: z
      .string()
      .describe("Clear description of what this unit does."),
    props: z
      .array(z.string())
      .optional()
      .describe(
        "Prop names for components, e.g. ['label', 'onClick', 'disabled']. Omit for non-components.",
      ),
    file: z
      .string()
      .optional()
      .describe(
        "Repo-relative or absolute source path to disambiguate same-named units.",
      ),
    rootFile: z
      .string()
      .optional()
      .describe(
        "Root file to analyze from (absolute path). Needed for units not reachable from the default entry, e.g. AEM-mapped or lazily-imported pages.",
      ),
    rootName: z.string().optional().describe("Root unit name override."),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({
    workDir,
    unitName,
    description,
    props,
    file,
    rootFile,
    rootName,
    outDir,
  }) => {
    try {
      const { detected, cache } = await setup(
        workDir,
        rootFile,
        rootName,
        undefined,
        outDir,
      );

      const sel = selectUnitFile(
        cache,
        detected.srcRoot,
        detected.repoRoot,
        unitName,
        file,
      );
      if ("ambiguous" in sel) return ok(sel.ambiguous);
      if ("notFound" in sel)
        return ok(
          `Unit "${unitName}" not found. If it's an AEM-mapped or lazily-imported page, pass rootFile pointing at its entry (e.g. the page's .tsx).`,
        );
      const unitFile = sel.file;

      // Build the DOCS block body (description + optional props bullets).
      const docsLines: string[] = [description];
      if (props && props.length > 0) {
        docsLines.push("", "> **Props**");
        for (const p of props) docsLines.push(`> - \`${p}\``);
      }
      const docsBody = docsLines.join("\n");

      // Write to graphdoc.json (the committed source of truth)…
      const relDocPath = relDocPathFor(
        detected.docsDir,
        detected.srcRoot,
        unitFile,
        unitName,
      );
      await writeDocsEntry(detected.docsDir, relDocPath, {
        source: relative(detected.repoRoot, unitFile),
        docs: docsBody,
      });

      // …then materialize ONLY this page from the JSON (no full-project re-emit).
      await emitFolderDocs({
        cache,
        srcRoot: detected.srcRoot,
        docsDir: detected.docsDir,
        repoRoot: detected.repoRoot,
        only: new Set([relDocPath]),
      });

      return ok(
        [
          `✅ Documented ${unitName}`,
          ``,
          `**Entry**       : \`graphdoc.json\` → \`${relDocPath}\``,
          `**Page**        : \`${join("src", relDocPath)}\` (materialized)`,
          `**Description** : ${description}`,
          props?.length
            ? `**Props**       : ${props.map((p) => `\`${p}\``).join(", ")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool: link_units / unlink_units (persistent manual edges) ────────────
//
// Some edges can't be inferred statically (dynamic import(), or a unit reached
// only through a barrel that re-exports many things). These tools record a
// manual edge in the SOURCE page's `manualUses` frontmatter, which onboard/
// analyze re-emit on every run — so the link survives regeneration.

const MDOCS_START = "<!-- DOCS:START -->";
const MDOCS_END = "<!-- DOCS:END -->";

async function findMdByName(
  dir: string,
  fileName: string,
): Promise<string | null> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const r = await findMdByName(full, fileName);
      if (r) return r;
    } else if (e.isFile() && e.name === fileName) return full;
  }
  return null;
}

/**
 * Cache for the link tools: import-following from the project root (fast),
 * extended with graphdoc.json-known sources so off-graph (AEM/lazy) units
 * resolve, and only falling back to a full crawl when a name is still missing
 * everywhere (e.g. a unit in a file nothing imports).
 */
async function buildLinkCache(
  detected: ReturnType<typeof detectProject>,
  aliases: ReturnType<typeof loadPathAliases>,
  names: string[],
): Promise<Map<string, FileInfo>> {
  const opts = cacheOpts(detected);
  const cache = await buildCache(
    detected.srcRoot,
    detected.rootFile,
    aliases,
    opts,
  );
  const has = (n: string) => [...cache.values()].some((i) => i.units.has(n));
  const idx = nameIndexFromState(
    await readState(detected.docsDir),
    detected.repoRoot,
  );
  for (const n of names) {
    if (!has(n)) {
      const src = idx.get(n);
      if (src) await extendCache(cache, [src], detected.srcRoot, aliases, opts);
    }
  }
  if (names.every(has)) return cache;
  return buildCache(detected.srcRoot, undefined, aliases, opts);
}

/** Locate (or decide where to create) the doc page for a unit name. */
async function locateDocPage(
  name: string,
  detected: { srcRoot: string; docsDir: string },
  cache: Map<string, { units: Map<string, unknown> }>,
): Promise<{ docFile: string; existed: boolean; sourceFile: string | null }> {
  const docsSrcDir = join(detected.docsDir, "src");
  // 1) In the static graph → mirror its source path.
  for (const [file, info] of cache) {
    if (info.units.has(name)) {
      const docFile = join(
        docsSrcDir,
        relative(detected.srcRoot, dirname(file)),
        `${name}.md`,
      );
      return { docFile, existed: existsSync(docFile), sourceFile: file };
    }
  }
  // 2) An existing page somewhere under docs/src.
  const found = await findMdByName(docsSrcDir, `${name}.md`);
  if (found) return { docFile: found, existed: true, sourceFile: null };
  // 3) Fallback: create at docs/src root.
  return {
    docFile: join(docsSrcDir, `${name}.md`),
    existed: false,
    sourceFile: null,
  };
}

function parseFmList(content: string, field: string): string[] {
  if (!content.startsWith("---")) return [];
  const end = content.indexOf("\n---", 3);
  if (end === -1) return [];
  const fm = content.slice(3, end);
  const out: string[] = [];
  let inField = false;
  for (const line of fm.split("\n")) {
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
}

/** Rewrite a page's `manualUses` frontmatter list to exactly `list`. */
function setManualUsesFrontmatter(content: string, list: string[]): string {
  const block = list.length
    ? ["manualUses:", ...list.map((n) => `  - ${n}`)].join("\n")
    : "";
  if (content.startsWith("---")) {
    const end = content.indexOf("\n---", 3);
    if (end !== -1) {
      let fm = content.slice(4, end); // inside frontmatter (after "---\n")
      // strip existing manualUses block
      const fmLines = fm.split("\n").filter((l) => l.length || true);
      const kept: string[] = [];
      let skipping = false;
      for (const l of fmLines) {
        if (/^manualUses:/.test(l)) {
          skipping = true;
          continue;
        }
        if (skipping) {
          if (/^\s*-\s+/.test(l)) continue;
          skipping = false;
        }
        kept.push(l);
      }
      const newFm = [
        ...kept.filter((l) => l !== ""),
        ...(block ? [block] : []),
      ].join("\n");
      return `---\n${newFm}\n---${content.slice(end + 4)}`;
    }
  }
  // No frontmatter → synthesize a minimal page.
  const name = "Unit";
  return [
    "---",
    "type: component",
    block || "manualUses: []",
    "---",
    "",
    `# ${name}`,
    "",
    MDOCS_START,
    "> _Add a description here. This block is preserved across regenerations._",
    MDOCS_END,
    "",
    content.trim(),
  ].join("\n");
}

/** Idempotently inject `bullet` under a `## Heading` list, dropping placeholders. */
function injectBullet(
  content: string,
  heading: string,
  bullet: string,
): string {
  if (content.includes(bullet)) return content;
  const h = `## ${heading}`;
  const start = content.indexOf(h);
  if (start === -1) return content.trimEnd() + `\n\n${h}\n\n${bullet}\n`;
  const after = start + h.length;
  const nextH = content.indexOf("\n## ", after);
  const sectionEnd = nextH === -1 ? content.length : nextH;
  let section = content.slice(after, sectionEnd);
  section = section.replace(/\n- \*\([^)]*\)\*/g, ""); // drop "(none)"/"(not used…)" placeholders
  section = section.replace(/\s+$/, "") + `\n${bullet}\n`;
  return content.slice(0, after) + section + content.slice(sectionEnd);
}

function buildMinimalPage(name: string, to: string): string {
  return [
    "---",
    "type: component",
    "uses: []",
    "usedBy: []",
    "manualUses:",
    `  - ${to}`,
    "---",
    "",
    `# ${name}`,
    "",
    MDOCS_START,
    "> _Add a description here. This block is preserved across regenerations._",
    MDOCS_END,
    "",
    "## Uses",
    "",
    `- [[${to}]] *(manual)*`,
    "",
    "## Used by",
    "",
    "- *(not used by any other component in this project)*",
    "",
  ].join("\n");
}

defineTool(
  "link_units",
  "Manually link one unit to another and persist it across regenerations. Records `to` in the `from` page's `manualUses` frontmatter (re-emitted by every onboard/analyze run) and shows it as a *(manual)* edge on both pages. Use for edges static analysis can't see — dynamic import() or barrel re-exports (e.g. link RechargeManagerV2 → RechargePage).",
  {
    workDir: z.string().optional(),
    from: z
      .string()
      .describe("Source unit name (the page that 'uses' the other)."),
    to: z.string().describe("Target unit name (the dependency)."),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, from, to, outDir }) => {
    try {
      const dir = resolveWorkDir(workDir);
      const detected = detectProject(dir);
      applyOutDir(detected, outDir);
      const aliases = loadPathAliases(detected.repoRoot);
      const cache = await buildLinkCache(detected, aliases, [from, to]);

      const fromLoc = await locateDocPage(from, detected, cache as any);
      const toLoc = await locateDocPage(to, detected, cache as any);

      // 1) Persist on the source page (+ its rendered Uses).
      let fromContent: string | null = null;
      try {
        fromContent = await readFile(fromLoc.docFile, "utf8");
      } catch {
        /* new */
      }
      if (fromContent) {
        const list = [
          ...new Set([...parseFmList(fromContent, "manualUses"), to]),
        ];
        let updated = setManualUsesFrontmatter(fromContent, list);
        updated = injectBullet(updated, "Uses", `- [[${to}]] *(manual)*`);
        await mkdir(dirname(fromLoc.docFile), { recursive: true });
        await writeFile(fromLoc.docFile, updated);
      } else {
        await mkdir(dirname(fromLoc.docFile), { recursive: true });
        await writeFile(fromLoc.docFile, buildMinimalPage(from, to));
      }

      // 2) Reflect reciprocal on the target page if it exists.
      if (toLoc.existed) {
        try {
          const toContent = await readFile(toLoc.docFile, "utf8");
          const updated = injectBullet(
            toContent,
            "Used by",
            `- [[${from}]] *(manual)*`,
          );
          await writeFile(toLoc.docFile, updated);
        } catch {
          /* ignore */
        }
      }

      // 3) Persist to the committed graphdoc.json (source of truth across regens).
      const relDocPath = relative(
        join(detected.docsDir, "src"),
        fromLoc.docFile,
      );
      const state = await readState(detected.docsDir);
      const merged = [
        ...new Set([
          ...(state.units[relDocPath]?.manualUses ?? []),
          ...(fromContent ? parseFmList(fromContent, "manualUses") : []),
          to,
        ]),
      ];
      await setManualUses(
        detected.docsDir,
        relDocPath,
        merged,
        fromLoc.sourceFile
          ? relative(detected.repoRoot, fromLoc.sourceFile)
          : undefined,
      );

      return ok(
        [
          `✅ Linked ${from} → ${to} (manual, persistent)`,
          ``,
          `**Source page** : \`${relative(detected.repoRoot, fromLoc.docFile)}\`${fromContent ? "" : " (created)"}`,
          toLoc.existed
            ? `**Target page** : \`${relative(detected.repoRoot, toLoc.docFile)}\` (reciprocal added)`
            : `**Target page** : not generated yet — reciprocal will appear when ${to} is documented.`,
          ``,
          `Stored in \`graphdoc.json\` (and \`manualUses\` frontmatter); survives regeneration even if docs/src is gitignored.`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

defineTool(
  "unlink_units",
  "Remove a manual link previously created with link_units. Strips `to` from the `from` page's `manualUses` frontmatter.",
  {
    workDir: z.string().optional(),
    from: z.string().describe("Source unit name."),
    to: z.string().describe("Target unit name to unlink."),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, from, to, outDir }) => {
    try {
      const dir = resolveWorkDir(workDir);
      const detected = detectProject(dir);
      applyOutDir(detected, outDir);
      const aliases = loadPathAliases(detected.repoRoot);
      const cache = await buildLinkCache(detected, aliases, [from]);

      const fromLoc = await locateDocPage(from, detected, cache as any);
      const relDocPath = relative(
        join(detected.docsDir, "src"),
        fromLoc.docFile,
      );
      const state = await readState(detected.docsDir);
      const stateList = (state.units[relDocPath]?.manualUses ?? []).filter(
        (n) => n !== to,
      );

      let fromContent: string | null = null;
      try {
        fromContent = await readFile(fromLoc.docFile, "utf8");
      } catch {
        /* none */
      }

      // Page may be gitignored/absent — graphdoc.json is still authoritative.
      if (!fromContent && !state.units[relDocPath]?.manualUses?.includes(to)) {
        return ok(
          `No manual link "${from}" → "${to}" found — nothing to unlink.`,
        );
      }

      if (fromContent) {
        const pageList = parseFmList(fromContent, "manualUses").filter(
          (n) => n !== to,
        );
        let updated = setManualUsesFrontmatter(fromContent, pageList);
        updated = updated.replace(`\n- [[${to}]] *(manual)*`, "");
        await writeFile(fromLoc.docFile, updated);
      }

      await setManualUses(detected.docsDir, relDocPath, stateList);

      return ok(
        `✅ Unlinked ${from} → ${to}. Remaining manual links: ${stateList.length ? stateList.join(", ") : "none"}.`,
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 11: document_all_units ─────────────────────────────────────────

const DOCS_PLACEHOLDER_MARKER = "_Add a description here";

async function isUndocumented(docFile: string): Promise<boolean> {
  try {
    const content = await readFile(docFile, "utf8");
    const start = content.indexOf("<!-- DOCS:START -->");
    const end = content.indexOf("<!-- DOCS:END -->");
    if (start === -1 || end === -1) return true;
    const block = content
      .slice(start + "<!-- DOCS:START -->".length, end)
      .trim();
    return !block || block.includes(DOCS_PLACEHOLDER_MARKER);
  } catch {
    return true;
  }
}

defineTool(
  "document_all_units",
  "Two-mode bulk documentation tool. " +
    "READ mode (no `units` param): scans all units, returns their source code and auto-extracted props in one response so you can write descriptions for all of them. " +
    "WRITE mode (`units` provided): writes descriptions and props for every listed unit in one call. " +
    "Typical flow: call once without `units` → analyze the sources → call again with all descriptions filled in.",
  {
    workDir: z.string().optional(),
    units: z
      .array(
        z.object({
          unitName: z.string(),
          description: z.string(),
          props: z.array(z.string()).optional(),
          file: z.string().optional(),
        }),
      )
      .optional()
      .describe(
        "WRITE mode: array of {unitName, description, props?, file?} to save. Include `file` (from READ output) for same-named units in different files. Omit to enter READ mode.",
      ),
    onlyUndocumented: z
      .boolean()
      .default(true)
      .describe(
        "READ mode only: skip units that already have a description. Default true.",
      ),
    maxUnits: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .describe(
        "READ mode only: max units to return in one batch to avoid token overload.",
      ),
    rootFile: z
      .string()
      .optional()
      .describe(
        "Root file to analyze from (absolute path). Needed for units not reachable from the default entry, e.g. AEM-mapped or lazily-imported pages.",
      ),
    rootName: z.string().optional().describe("Root unit name override."),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({
    workDir,
    units,
    onlyUndocumented,
    maxUnits,
    rootFile,
    rootName,
    outDir,
  }) => {
    try {
      const { detected, cache } = await setup(
        workDir,
        rootFile,
        rootName,
        undefined,
        outDir,
      );
      const docsSrcDir = join(detected.docsDir, "src");

      // ── WRITE MODE ────────────────────────────────────────────────────────
      if (units && units.length > 0) {
        const results: string[] = [];
        const stateEntries: Array<{
          relDocPath: string;
          source: string;
          docs: string;
        }> = [];
        let written = 0;

        for (const { unitName, description, props, file } of units) {
          const sel = selectUnitFile(
            cache,
            detected.srcRoot,
            detected.repoRoot,
            unitName,
            file,
          );
          if ("notFound" in sel) {
            results.push(`⚠️  ${unitName} — not found, skipped`);
            continue;
          }
          if ("ambiguous" in sel) {
            results.push(
              `⚠️  ${unitName} — ambiguous (defined in multiple files); pass \`file\` to target one, skipped`,
            );
            continue;
          }
          const unitFile = sel.file;

          const docsLines = [description];
          if (props && props.length > 0) {
            docsLines.push("", "> **Props**");
            for (const p of props) docsLines.push(`> - \`${p}\``);
          }
          const docsBody = docsLines.join("\n");

          stateEntries.push({
            relDocPath: relDocPathFor(
              detected.docsDir,
              detected.srcRoot,
              unitFile,
              unitName,
            ),
            source: relative(detected.repoRoot, unitFile),
            docs: docsBody,
          });
          results.push(
            `✅ ${unitName}${props?.length ? ` [${props.length} props]` : ""}`,
          );
          written++;
        }

        // Persist all descriptions to graphdoc.json in one write…
        await writeDocsEntries(detected.docsDir, stateEntries);
        // …then materialize ONLY the changed pages (no full-project re-emit).
        if (stateEntries.length) {
          await emitFolderDocs({
            cache,
            srcRoot: detected.srcRoot,
            docsDir: detected.docsDir,
            repoRoot: detected.repoRoot,
            only: new Set(stateEntries.map((e) => e.relDocPath)),
          });
        }

        return ok(
          [
            `✅ Documented ${written} / ${units.length} units (graphdoc.json + materialized pages)`,
            ``,
            ...results,
          ].join("\n"),
        );
      }

      // ── READ MODE ─────────────────────────────────────────────────────────
      const allUnits: Array<{ name: string; file: string }> = [];
      for (const [file, info] of cache) {
        for (const name of info.units.keys()) {
          allUnits.push({ name, file });
        }
      }
      // Stable order so successive batches (maxUnits) are reproducible.
      allUnits.sort((a, b) =>
        a.file === b.file
          ? a.name.localeCompare(b.name)
          : a.file.localeCompare(b.file),
      );

      // Filter to undocumented if requested. A unit counts as documented if it
      // has a real entry in graphdoc.json OR a non-placeholder DOCS block on disk
      // (so re-runs are correct even when docs/src is gitignored / absent).
      const state = await readState(detected.docsDir);
      const candidates: typeof allUnits = [];
      for (const u of allUnits) {
        if (candidates.length >= maxUnits) break;
        if (onlyUndocumented) {
          const docRelDir = relative(detected.srcRoot, dirname(u.file));
          const docFile = join(docsSrcDir, docRelDir, `${u.name}.md`);
          const relDocPath = relative(docsSrcDir, docFile);
          if (isRealDoc(state.units[relDocPath]?.docs)) continue;
          if (!(await isUndocumented(docFile))) continue;
        }
        candidates.push(u);
      }

      if (candidates.length === 0) {
        return ok(
          "✅ All units are already documented. Pass `onlyUndocumented: false` to re-document.",
        );
      }

      const parts: string[] = [
        `Found **${candidates.length}** undocumented unit(s)${allUnits.length > maxUnits ? ` (showing first ${maxUnits} of ${allUnits.length})` : ""}. Analyze each source block below, then call \`document_all_units\` with a \`units\` array containing one entry per unit.`,
        ``,
      ];

      for (const u of candidates) {
        const source = await readFile(u.file, "utf8").catch(() => null);
        const fileInfo = cache.get(u.file);
        // Props come from analysis (unit.props); candidates always derive from
        // the cache, so no re-parse is needed.
        const props = fileInfo?.units.get(u.name)?.props ?? [];
        const relFile = relative(detected.repoRoot, u.file);

        parts.push(`---`);
        parts.push(`## ${u.name}`);
        parts.push(
          `**File**: \`${relFile}\` | **Kind**: ${fileInfo?.units.get(u.name)?.kind ?? "unknown"}${props.length ? ` | **Props**: ${props.map((p) => `\`${p}\``).join(", ")}` : ""}`,
        );
        parts.push(``);
        if (source) {
          parts.push("```" + (fileInfo?.language ?? "ts"));
          parts.push(
            source.slice(0, 1500) +
              (source.length > 1500 ? "\n// … (truncated)" : ""),
          );
          parts.push("```");
        }
        parts.push(``);
      }

      parts.push(`---`);
      parts.push(
        `Call \`document_all_units\` with a \`units\` array to save all descriptions at once.`,
      );
      parts.push(
        `For same-named units in different files, include the \`file\` field (shown above) so each gets its own page.`,
      );

      return ok(
        parts.join("\n"),
        "Output capped — lower `maxUnits` (or scope with `rootFile`) to fit the rest in a batch.",
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool 12: generate_module_graphdoc ────────────────────────────────────
//
// A focused doc set (Tree / Graph / Matrix / API / ONBOARDING) for ONE module
// and its dependency closure, written into docs/modules/<unit>/ so it sits
// alongside — not on top of — the project-wide docs. Per-unit pages are NOT
// regenerated: the API diagram reads props from the existing docs/src so
// curated descriptions/props are reused.

/**
 * Generate a module's scoped doc set (Tree/Graph/Matrix/Api/ONBOARDING) into
 * `outDir` (default `<docs>/modules/<unitName>`), reusing the main per-unit pages
 * for props/descriptions. Records the module into graphdoc.json so `sync`
 * can replay it. Shared by the generate_module_graphdoc tool and sync.
 */
async function generateModuleDocs(
  detected: ReturnType<typeof detectProject>,
  aliases: ReturnType<typeof loadPathAliases>,
  unitName: string,
  file: string | undefined,
  outDir: string | undefined,
  styledComponents: boolean | undefined,
  /**
   * An already-built cache (e.g. sync's analyze cache) to reuse. Must have been
   * built with the SAME styledComponents flag. When the module root is inside
   * it, the scoped cache is derived in-memory (subsetReachableFrom) — no
   * re-parse at all.
   */
  preCache?: Map<string, FileInfo>,
): Promise<
  | { notFound: string }
  | {
      moduleFile: string;
      moduleOut: string;
      relOut: string;
      nodes: ReturnType<typeof buildGraphData>["nodes"];
      edges: ReturnType<typeof buildGraphData>["edges"];
      treeData: Awaited<ReturnType<typeof buildTree>>;
    }
> {
  // ── Locate the module's defining file WITHOUT a full-tree crawl ──────────
  // Order: explicit `file` hint → graphdoc.json unit sources → import-following
  // cache from the project root → full crawl (last resort only). Each candidate
  // is validated by building its scoped cache and checking it defines unitName.
  const scopedFor = async (
    candidate: string,
  ): Promise<Map<string, FileInfo> | null> => {
    const scoped = preCache?.has(candidate)
      ? subsetReachableFrom(preCache, candidate)
      : await buildCache(
          detected.srcRoot,
          candidate,
          aliases,
          cacheOpts(detected, styledComponents),
        );
    return scoped.get(candidate)?.units.has(unitName) ? scoped : null;
  };

  let moduleFile: string | null = null;
  let cache: Map<string, FileInfo> | null = null;

  // 1) Explicit file hint (repo-relative or absolute).
  if (file) {
    const abs = isAbsolute(file) ? file : join(detected.repoRoot, file);
    if (existsSync(abs)) {
      cache = await scopedFor(abs);
      if (cache) moduleFile = abs;
    }
  }

  // 2) graphdoc.json unit-source index (covers AEM/lazy off-graph modules).
  if (!moduleFile) {
    const idx = nameIndexFromState(
      await readState(detected.docsDir),
      detected.repoRoot,
    );
    const hit = idx.get(unitName);
    if (hit && existsSync(hit)) {
      cache = await scopedFor(hit);
      if (cache) moduleFile = hit;
    }
  }

  // 3) Import-following cache from the project root (or the provided preCache).
  if (!moduleFile) {
    const rootCache =
      preCache ??
      (await buildCache(
        detected.srcRoot,
        detected.rootFile,
        aliases,
        cacheOpts(detected, styledComponents),
      ));
    const found = findUnitFile(rootCache, unitName, file);
    if (found) {
      cache = await scopedFor(found);
      if (cache) moduleFile = found;
    }
  }

  // 4) Full crawl — last resort so units anywhere under srcRoot stay findable.
  if (!moduleFile) {
    const crawl = await buildCache(
      detected.srcRoot,
      undefined,
      aliases,
      cacheOpts(detected, styledComponents),
    );
    const found = findUnitFile(crawl, unitName, file);
    if (found) {
      cache = await scopedFor(found);
      if (cache) moduleFile = found;
    }
    if (!moduleFile || !cache) {
      const all = [
        ...new Set([...crawl.values()].flatMap((i) => [...i.units.keys()])),
      ]
        .sort()
        .join(", ");
      return { notFound: all };
    }
  }
  if (!moduleFile || !cache) return { notFound: "" };

  // 3) Self-contained output folder; reuse the MAIN per-unit pages for props.
  const moduleOut = outDir ?? join(detected.docsDir, "modules", unitName);
  const containingVaultSrc = join(moduleOut, "..", "..", "src");
  const mainSrcDocs = existsSync(containingVaultSrc)
    ? containingVaultSrc
    : join(detected.docsDir, "src");

  // 4) Build the subtree and emit the five aggregate files (no docs/src writes).
  const treeData = await buildTree(moduleFile, unitName, new Set(), cache);
  const tree: Tree = { [unitName]: treeData };
  await emitMermaid({ tree, docsDir: moduleOut });
  await emitGraph({ cache, srcRoot: detected.srcRoot, docsDir: moduleOut });
  await emitMatrix({ cache, srcRoot: detected.srcRoot, docsDir: moduleOut });
  await emitApi({
    cache,
    srcRoot: detected.srcRoot,
    docsDir: moduleOut,
    srcDocsDir: mainSrcDocs,
    projectKind: detected.kind,
  });
  const ctx = buildOnboardingContext(
    cache,
    detected.srcRoot,
    { ...detected, rootFile: moduleFile, rootName: unitName },
    treeData,
  );
  await emitOnboarding(ctx, moduleOut, {
    stateDir: detected.docsDir,
    noteKey: `module:${unitName}`,
  });

  const { nodes, edges } = buildGraphData(cache, detected.srcRoot);
  // Record into graphdoc.json so sync can replay this module. Store a
  // custom outDir only when it differs from the default modules/<unitName>.
  const defaultOut = join(detected.docsDir, "modules", unitName);
  await recordModule(detected.docsDir, {
    unitName,
    file: relative(detected.repoRoot, moduleFile),
    ...(moduleOut !== defaultOut
      ? { outDir: relative(detected.docsDir, moduleOut) }
      : {}),
    styledComponents: !!styledComponents,
  });
  return {
    moduleFile,
    moduleOut,
    relOut: relative(detected.repoRoot, moduleOut),
    nodes,
    edges,
    treeData,
  };
}

defineTool(
  "generate_module_graphdoc",
  "Generate a focused GraphDoc doc set (Tree, Graph, Matrix, API, ONBOARDING) for ONE module and ALL its dependencies, written to docs/modules/<unitName>/ (separate from the project-wide docs). Reuses existing per-unit pages for descriptions/props. Recorded in graphdoc.json so `sync` can rebuild it. Call this for requests like 'generate graphdoc for RechargeManagerV2 and its deps' or 'graph just this module'.",
  {
    workDir: z.string().optional(),
    unitName: z
      .string()
      .describe("The module's root unit name, e.g. 'RechargeManagerV2'."),
    file: z
      .string()
      .optional()
      .describe(
        "Repo-relative or absolute source path to disambiguate same-named units.",
      ),
    outDir: z
      .string()
      .optional()
      .describe(
        "Output directory (absolute). Default: <docs>/modules/<unitName>.",
      ),
    styledComponents: z
      .boolean()
      .optional()
      .describe(
        "Include native-tag styled-components (styled.div/.View) as units too. Off by default.",
      ),
  },
  async ({ workDir, unitName, file, outDir, styledComponents }) => {
    try {
      const dir = resolveWorkDir(workDir);
      const detected = detectProject(dir);
      const aliases = loadPathAliases(detected.repoRoot);

      const res = await generateModuleDocs(
        detected,
        aliases,
        unitName,
        file,
        outDir,
        styledComponents,
      );
      if ("notFound" in res) {
        return ok(
          `Unit "${unitName}" not found.\n\nAvailable units:\n${res.notFound}`,
          "Pass `file` to disambiguate, or check the name.",
        );
      }
      const { moduleFile, relOut, nodes, edges, treeData } = res;
      return ok(
        [
          `✅ Module GraphDoc generated for ${unitName}`,
          ``,
          `Root file : ${relative(detected.repoRoot, moduleFile)}`,
          `Subtree   : ${nodes.length} units, ${edges.length} edges (module + all dependencies)`,
          `Output    : ${relOut}/`,
          ``,
          `Generated:`,
          `  • ${relOut}/ONBOARDING.md`,
          `  • ${relOut}/Tree.md`,
          `  • ${relOut}/Graph.md`,
          `  • ${relOut}/Matrix.md`,
          `  • ${relOut}/Api.md`,
          ``,
          `Per-unit pages were NOT regenerated — descriptions/props are reused from docs/src/.`,
          `Open ${relOut}/ as its own Obsidian vault for clean, scoped [[wiki-links]].`,
          ``,
          printIndented(unitName, treeData),
        ].join("\n"),
        "Large subtree — pass `outDir` or inspect the files directly.",
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool: sync (reproduce everything from graphdoc.json) ─────────────
//
// On a fresh clone the docs folder may contain ONLY graphdoc.json. sync
// rebuilds the entire doc set from it, in the order that matters:
//   1) full project analyze → regenerates root docs + docs/src/, restoring
//      DOCS blocks, manual links and onboarding notes from graphdoc.json;
//   2) each recorded module → docs/modules/<unit>/ (now that docs/src exists,
//      module Api.md keeps curated props/descriptions).

defineTool(
  "sync",
  "Reproduce the COMPLETE GraphDoc doc set from the committed graphdoc.json — for a fresh clone where docs/src and docs/modules were gitignored. Locates the source via the stored `sourceRoot` offset (or the `workDir` override), runs the full project analyze (restoring descriptions, manual links and onboarding notes), then regenerates every recorded module in the correct order. Run it from the docs folder (or pass outDir) — the one command to rebuild everything after cloning.",
  {
    workDir: z
      .string()
      .optional()
      .describe(
        "Absolute path to the source project (overrides the stored sourceRoot offset).",
      ),
    outDir: z
      .string()
      .optional()
      .describe(
        "Absolute path to the docs folder holding graphdoc.json (default: current directory).",
      ),
  },
  async ({ workDir, outDir }) => {
    try {
      // 1) Locate the docs folder (where graphdoc.json lives).
      let docsDir: string;
      if (outDir !== undefined) {
        if (!isAbsolute(outDir))
          throw new Error(`outDir must be an absolute path (got "${outDir}").`);
        docsDir = outDir;
      } else if (workDir !== undefined) {
        if (!isAbsolute(workDir))
          throw new Error(
            `workDir must be an absolute path (got "${workDir}").`,
          );
        docsDir = detectProject(workDir).docsDir;
      } else {
        docsDir = graphdocDir;
      }

      const state = await readState(docsDir);

      // 2) Locate the source project: explicit workDir override → stored
      //    sourceRoot offset (relative to the docs folder) → cwd fallback.
      const projectDir = workDir
        ? workDir
        : state.sourceRoot
          ? join(docsDir, state.sourceRoot)
          : process.cwd();
      if (!existsSync(projectDir)) {
        throw new Error(
          `Source project not found at "${projectDir}". ` +
            `Pass workDir=<path to the project>, or fix \`sourceRoot\` in graphdoc.json (it is relative to the docs folder).`,
        );
      }

      const detected = detectProject(projectDir);
      applyOutDir(detected, docsDir); // read from / write to the docs folder
      const aliases = loadPathAliases(detected.repoRoot);

      // ── Step 1: full project analyze (restores src + root from graphdoc.json) ──
      const rootFile = state.analyze.rootFile
        ? join(detected.repoRoot, state.analyze.rootFile)
        : detected.rootFile;
      const roots = state.analyze.roots?.length
        ? state.analyze.roots
        : undefined;
      if (!roots && !rootFile) throw new Error(noEntryMessage(detected));
      const rootName =
        state.analyze.rootName ??
        (roots ? rootsLabel(roots) : detected.rootName);
      const opts = {
        srcRoot: detected.srcRoot,
        rootFile,
        rootName,
        docsDir: detected.docsDir,
        repoRoot: detected.repoRoot,
        framework: detected.framework,
        language: detected.language,
        styledComponents: state.analyze.styledComponents,
        projectKind: detected.kind,
        includeSpecs: state.analyze.includeSpecs,
        roots,
        rebuild: true,
      };
      const result = await analyze(projectDir, opts);
      const { edges } = buildGraphData(result.cache, detected.srcRoot);
      const treeData = result.tree[rootName] ?? {};
      const ctx = buildOnboardingContext(
        result.cache,
        detected.srcRoot,
        { ...detected, rootFile, rootName, roots },
        treeData,
        result.specs,
      );
      await emitOnboarding(ctx, detected.docsDir, {
        stateDir: detected.docsDir,
        noteKey: "",
      });

      // ── Step 2: replay each recorded module (src now exists for curated props) ──
      const moduleResults: string[] = [];
      for (const m of state.modules) {
        const res = await generateModuleDocs(
          detected,
          aliases,
          m.unitName,
          m.file ? join(detected.repoRoot, m.file) : undefined,
          m.outDir ? join(detected.docsDir, m.outDir) : undefined,
          m.styledComponents,
          // Reuse the analyze cache (in-memory subset, zero re-parse) when the
          // module was recorded with the same styledComponents variant.
          !!m.styledComponents === !!state.analyze.styledComponents
            ? result.cache
            : undefined,
        );
        moduleResults.push(
          "notFound" in res
            ? `  ⚠️  ${m.unitName} — not found, skipped`
            : `  ✅ ${m.unitName} → ${res.relOut}/`,
        );
      }

      return ok(
        [
          `✅ Sync complete — rebuilt from graphdoc.json`,
          ``,
          `Project   : ${detected.framework} (${detected.language})`,
          `Files     : ${result.stats.files}`,
          `Units     : ${result.stats.units}`,
          `Edges     : ${edges.length}`,
          ...specLines(result),
          `Docs      : ${detected.docsDir}`,
          ``,
          `Restored from graphdoc.json:`,
          `  • ${Object.values(state.units).filter((u) => isRealDoc(u.docs)).length} curated descriptions`,
          `  • ${Object.values(state.units).reduce((n, u) => n + (u.manualUses?.length ?? 0), 0)} manual links`,
          `  • ${Object.keys(state.onboard).length} onboarding note block(s)`,
          ``,
          `Modules (${state.modules.length}):`,
          ...(moduleResults.length ? moduleResults : ["  (none recorded)"]),
        ].join("\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── Tool: export_doc_state (one-time migration) ──────────────────────────
//
// Seeds graphdoc.json from the CURRENT populated docs/src/ pages so nothing is
// lost before docs/src is gitignored. Walks every page, lifting its DOCS block,
// `manualUses` frontmatter, and `source:` path into the committed state file.
// Idempotent: existing JSON entries are merged (JSON `analyze` settings kept).

const DOCS_START = "<!-- DOCS:START -->";
const DOCS_END = "<!-- DOCS:END -->";

function extractDocsBlockFrom(content: string): string | null {
  const s = content.indexOf(DOCS_START);
  const e = content.indexOf(DOCS_END);
  if (s !== -1 && e !== -1 && e > s) {
    const block = content.slice(s + DOCS_START.length, e).trim();
    return block || null;
  }
  return null;
}

defineTool(
  "export_doc_state",
  "One-time migration: scan the existing docs/src/ pages and write their descriptions, props, manual links, and source paths into the committed graphdoc.json ('setup memory'). Run this ONCE before adding docs/src to .gitignore so curated documentation survives. Idempotent and additive.",
  {
    workDir: z.string().optional(),
    outDir: z.string().optional().describe(OUT_DIR_DESC),
  },
  async ({ workDir, outDir }) => {
    try {
      const dir = resolveWorkDir(workDir);
      const detected = detectProject(dir);
      applyOutDir(detected, outDir);
      const docsSrcDir = join(detected.docsDir, "src");

      if (!existsSync(docsSrcDir)) {
        return ok(
          `⚠️  No docs/src at ${docsSrcDir}. Run analyze_project / generate_graphdoc first.`,
        );
      }

      // Reuse query_docs' walker pattern.
      async function walkMd(d: string): Promise<string[]> {
        const results: string[] = [];
        try {
          const entries = await readdir(d, { withFileTypes: true });
          for (const e of entries) {
            const full = join(d, e.name);
            if (e.isDirectory()) results.push(...(await walkMd(full)));
            else if (e.isFile() && e.name.endsWith(".md")) results.push(full);
          }
        } catch {
          /* ignore */
        }
        return results;
      }

      const state: GraphdocState = await readState(detected.docsDir);
      const files = await walkMd(docsSrcDir);
      let docs = 0;
      let links = 0;

      for (const f of files) {
        const content = await readFile(f, "utf8").catch(() => null);
        if (!content) continue;
        const relDocPath = relative(docsSrcDir, f);
        const fmEnd = content.indexOf("\n---", 3);
        const sourceMatch =
          content.startsWith("---") && fmEnd !== -1
            ? content.slice(3, fmEnd).match(/^source:\s*(.+)$/m)
            : null;
        const block = extractDocsBlockFrom(content);
        const manualUses = parseFmList(content, "manualUses");

        const entry: UnitState = state.units[relDocPath] ?? { source: "" };
        if (sourceMatch) entry.source = sourceMatch[1].trim();
        if (isRealDoc(block ?? undefined)) {
          entry.docs = block as string;
          docs++;
        }
        if (manualUses.length) {
          entry.manualUses = [
            ...new Set([...(entry.manualUses ?? []), ...manualUses]),
          ];
          links += manualUses.length;
        }

        // Only persist pages that carry real content (docs or links).
        if (
          isRealDoc(entry.docs) ||
          (entry.manualUses && entry.manualUses.length)
        ) {
          state.units[relDocPath] = entry;
        }
      }

      await writeState(detected.docsDir, state);

      return ok(
        [
          `✅ Exported documentation state to graphdoc.json`,
          ``,
          `Pages scanned : ${files.length}`,
          `Descriptions  : ${docs}`,
          `Manual links  : ${links}`,
          `Units stored  : ${Object.keys(state.units).length}`,
          `File          : ${join(relative(detected.repoRoot, detected.docsDir), "graphdoc.json")}`,
          ``,
          `Next: commit graphdoc.json, then add \`src/\` to the docs folder's .gitignore.`,
          `Regenerate any time with generate_graphdoc — DOCS blocks + manual links restore automatically.`,
        ].join("\n"),
      );
    } catch (e) {
      return err(e);
    }
  },
);

// ─── start ─────────────────────────────────────────────────────────────────

// `graphdoc-mcp --setup` runs the opt-in editor configurator (project-scoped by
// default, `--global` for global editor configs) instead of starting the server.
}
