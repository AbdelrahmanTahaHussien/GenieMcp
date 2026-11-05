/**
 * state-store.ts — the project's "setup memory".
 *
 * All hand-curated content and generate settings are persisted to a single
 * committed JSON file (`<docsDir>/graphdoc.json`) so that `docs/src/` can be
 * gitignored and fully regenerated on any device. The store holds:
 *
 *   • analyze  — settings of the last full-project generate run (rootFile, etc.)
 *   • units    — per doc-page documentation + manual links, keyed by the page's
 *                path relative to `docs/src` (the same `relDocPath` the folder
 *                emitter uses, e.g. "components/ui/Button.md", "App.md").
 *
 * Every mutating tool (document_unit, document_all_units, link_units,
 * unlink_units, analyze_project, generate_graphdoc) records into this file; the
 * regeneration read-path restores from it. The on-disk `.md` pages become a
 * disposable, regenerable view of this state.
 */

import { readFile } from "node:fs/promises";
import { graphdocMkdir as mkdir, graphdocWriteFile as writeFile } from "./write-guard.js";
import { join, relative } from "node:path";
import { docPathFor } from "./graph-core.js";

export const STATE_FILENAME = "graphdoc.json";

/**
 * Default .gitignore emitted next to graphdoc.json. Everything the generators
 * produce is regenerable via `sync`, so only graphdoc.json (+ the .gitignore
 * itself) needs to be committed. Written once and never overwritten, so hand
 * edits survive.
 */
export const GITIGNORE_FILENAME = ".gitignore";
export const GITIGNORE_CONTENT = `.obsidian

# Everything here is regenerated from graphdoc.json ("setup memory") via the
# \`sync\` tool. Only graphdoc.json (+ this .gitignore) needs to be committed;
# descriptions, manual links, onboarding notes, generate settings, the source
# location offset, and the module list all live in graphdoc.json.
src/
modules/
/Api.md
/Graph.md
/Matrix.md
/ONBOARDING.md
/Tree.md
`;

/** Create <docsDir>/.gitignore if absent; existing files are left untouched. */
async function ensureGitignore(docsDir: string): Promise<void> {
  try {
    await writeFile(join(docsDir, GITIGNORE_FILENAME), GITIGNORE_CONTENT, {
      flag: "wx",
    });
  } catch {
    // Already exists (or unwritable) — never overwrite a hand-edited file.
  }
}

/** Placeholder body written for undocumented pages — never persisted as a real doc. */
export const DOCS_PLACEHOLDER_MARKER = "_Add a description here";
/** Placeholder marker for the ONBOARDING Architecture Notes block. */
export const ONBOARD_PLACEHOLDER_MARKER = "_Add architecture notes";

export type AnalyzeSettings = {
  rootFile: string | null;
  rootName: string | null;
  styledComponents: boolean;
};

/** A recorded generate_module_graphdoc invocation, replayed by sync. */
export type ModuleStep = {
  unitName: string;
  /** Repo-relative source file of the module root (disambiguates same-named units). */
  file: string;
  /** Docs-relative output dir, only when it differs from the default `modules/<unitName>`. */
  outDir?: string;
  styledComponents?: boolean;
};

export type UnitState = {
  /** Repo-relative path of the defining source file (restores manual-target resolution). */
  source: string;
  /** Verbatim DOCS-block body (description + props bullets). */
  docs?: string;
  /** Manually-linked target unit names (declarative, re-applied on every regen). */
  manualUses?: string[];
};

export type GraphdocState = {
  version: number;
  /**
   * Where the source project lives, RELATIVE TO THE DOCS FOLDER (the dir holding
   * graphdoc.json). Lets `sync` auto-locate the source on another machine
   * when the docs and source sit in sibling trees (e.g. "../../jawwy-webportal/react-app").
   * Optional — sync falls back to its workDir argument / cwd when unset.
   */
  sourceRoot?: string;
  analyze: AnalyzeSettings;
  /** Recorded module generations (ordered), replayed after the main docs by sync. */
  modules: ModuleStep[];
  /** Hand-written ONBOARDING notes, keyed "" (root) or "module:<unitName>". */
  onboard: Record<string, string>;
  /** Keyed by relDocPath = relative(docs/src, docPathFor(...)). */
  units: Record<string, UnitState>;
};

const CURRENT_VERSION = 1;

export function statePath(docsDir: string): string {
  return join(docsDir, STATE_FILENAME);
}

function emptyState(): GraphdocState {
  return {
    version: CURRENT_VERSION,
    analyze: { rootFile: null, rootName: null, styledComponents: false },
    modules: [],
    onboard: {},
    units: {},
  };
}

/** Read the state file, returning an empty state if it does not exist or is unreadable. */
export async function readState(docsDir: string): Promise<GraphdocState> {
  let raw: string;
  try {
    raw = await readFile(statePath(docsDir), "utf8");
  } catch {
    return emptyState();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GraphdocState>;
    return {
      version: parsed.version ?? CURRENT_VERSION,
      ...(parsed.sourceRoot ? { sourceRoot: parsed.sourceRoot } : {}),
      analyze: {
        rootFile: null,
        rootName: null,
        styledComponents: false,
        ...(parsed.analyze ?? {}),
      },
      modules: parsed.modules ?? [],
      onboard: parsed.onboard ?? {},
      units: parsed.units ?? {},
    };
  } catch {
    // Corrupt file: don't silently wipe it — surface the problem.
    throw new Error(
      `${STATE_FILENAME} is not valid JSON (at ${statePath(docsDir)}).`,
    );
  }
}

/** Write the state file with sorted keys and stable field order for clean diffs. */
export async function writeState(
  docsDir: string,
  state: GraphdocState,
): Promise<void> {
  const units: Record<string, UnitState> = {};
  for (const key of Object.keys(state.units).sort((a, b) =>
    a.localeCompare(b),
  )) {
    const u = state.units[key];
    const ordered: UnitState = { source: u.source };
    if (u.docs !== undefined) ordered.docs = u.docs;
    if (u.manualUses && u.manualUses.length)
      ordered.manualUses = [...u.manualUses].sort((a, b) => a.localeCompare(b));
    units[key] = ordered;
  }
  const onboard: Record<string, string> = {};
  const srcOnboard = state.onboard ?? {};
  for (const key of Object.keys(srcOnboard).sort((a, b) =>
    a.localeCompare(b),
  )) {
    if (isRealNote(srcOnboard[key])) onboard[key] = srcOnboard[key];
  }
  const out: GraphdocState = {
    version: state.version || CURRENT_VERSION,
    ...(state.sourceRoot ? { sourceRoot: state.sourceRoot } : {}),
    analyze: state.analyze,
    modules: state.modules ?? [],
    onboard,
    units,
  };
  await mkdir(docsDir, { recursive: true });
  await writeFile(statePath(docsDir), JSON.stringify(out, null, 2) + "\n");
  await ensureGitignore(docsDir);
}

/**
 * The doc-page key for a unit: its page path relative to `docs/src`, matching
 * the key the folder emitter uses (e.g. "components/ui/Button.md").
 */
export function relDocPathFor(
  docsDir: string,
  srcRoot: string,
  sourceFile: string,
  unitName: string,
): string {
  const docsSrcDir = join(docsDir, "src");
  return relative(
    docsSrcDir,
    docPathFor(srcRoot, docsSrcDir, sourceFile, unitName),
  );
}

/** True if a stored docs body is real content (not the regeneration placeholder). */
export function isRealDoc(docs: string | undefined): boolean {
  return !!docs && !docs.includes(DOCS_PLACEHOLDER_MARKER);
}

/** True if an ONBOARDING notes block is real content (not the placeholder). */
export function isRealNote(note: string | undefined): boolean {
  return (
    !!note &&
    note.trim().length > 0 &&
    !note.includes(ONBOARD_PLACEHOLDER_MARKER)
  );
}

// ─── mutations ───────────────────────────────────────────────────────────────
//
// Every mutation is a read-modify-write of graphdoc.json. They are serialized
// through a single promise chain so concurrent tool handlers can't interleave
// reads/writes and silently lose an update.

let stateLock: Promise<unknown> = Promise.resolve();

function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = stateLock.then(fn, fn);
  stateLock = run.catch(() => undefined);
  return run;
}

/** Locked read-modify-write helper all mutations go through. */
function mutateState(
  docsDir: string,
  mutate: (state: GraphdocState) => void,
): Promise<void> {
  return withStateLock(async () => {
    const state = await readState(docsDir);
    mutate(state);
    await writeState(docsDir, state);
  });
}

/** Upsert one unit's documentation, preserving any existing manualUses. */
export async function writeDocsEntry(
  docsDir: string,
  relDocPath: string,
  entry: { source: string; docs: string },
): Promise<void> {
  await mutateState(docsDir, (state) => {
    const prev = state.units[relDocPath];
    state.units[relDocPath] = {
      source: entry.source,
      docs: entry.docs,
      ...(prev?.manualUses ? { manualUses: prev.manualUses } : {}),
    };
  });
}

/** Batch upsert — reads/writes the file once for many units (document_all_units). */
export async function writeDocsEntries(
  docsDir: string,
  entries: Array<{ relDocPath: string; source: string; docs: string }>,
): Promise<void> {
  if (!entries.length) return;
  await mutateState(docsDir, (state) => {
    for (const { relDocPath, source, docs } of entries) {
      const prev = state.units[relDocPath];
      state.units[relDocPath] = {
        source,
        docs,
        ...(prev?.manualUses ? { manualUses: prev.manualUses } : {}),
      };
    }
  });
}

/** Set the full manualUses list for a page (creates the entry if needed). */
export async function setManualUses(
  docsDir: string,
  relDocPath: string,
  targets: string[],
  source?: string,
): Promise<void> {
  await mutateState(docsDir, (state) => {
    const prev = state.units[relDocPath];
    const list = [...new Set(targets)];
    const resolvedSource = prev?.source ?? source ?? "";
    // Drop the entry entirely if it would carry no docs and no links.
    if (!list.length && !isRealDoc(prev?.docs)) {
      delete state.units[relDocPath];
    } else {
      state.units[relDocPath] = {
        source: resolvedSource,
        ...(prev?.docs !== undefined ? { docs: prev.docs } : {}),
        ...(list.length ? { manualUses: list } : {}),
      };
    }
  });
}

/**
 * Record the settings of the last full-project generate run. When `sourceRoot`
 * (docs-relative path to the source project) is given, persist it so `sync`
 * can auto-locate the source on another machine.
 */
export async function recordAnalyze(
  docsDir: string,
  settings: AnalyzeSettings,
  sourceRoot?: string,
): Promise<void> {
  await mutateState(docsDir, (state) => {
    state.analyze = settings;
    if (sourceRoot) state.sourceRoot = sourceRoot;
  });
}

/** Record (or update) a module generation so sync can replay it. Dedup by unitName+file. */
export async function recordModule(
  docsDir: string,
  step: ModuleStep,
): Promise<void> {
  await mutateState(docsDir, (state) => {
    const idx = state.modules.findIndex(
      (m) => m.unitName === step.unitName && m.file === step.file,
    );
    const entry: ModuleStep = {
      unitName: step.unitName,
      file: step.file,
      ...(step.outDir ? { outDir: step.outDir } : {}),
      ...(step.styledComponents ? { styledComponents: true } : {}),
    };
    if (idx === -1) state.modules.push(entry);
    else state.modules[idx] = entry;
  });
}

/** Read a stored ONBOARDING notes block ("" = root, "module:<unitName>" = a module). */
export function getOnboardNote(
  state: GraphdocState,
  key: string,
): string | undefined {
  const note = state.onboard[key];
  return isRealNote(note) ? note : undefined;
}

/** Persist an ONBOARDING notes block; drops the key if the note is just a placeholder. */
export async function setOnboardNote(
  docsDir: string,
  key: string,
  note: string,
): Promise<void> {
  await mutateState(docsDir, (state) => {
    if (isRealNote(note)) state.onboard[key] = note;
    else delete state.onboard[key];
  });
}

// ─── derived views (consumed by the regeneration read-path) ───────────────────

/** relDocPath → docs body, for merging into readExistingDocs. */
export function docsMapFromState(state: GraphdocState): Map<string, string> {
  const map = new Map<string, string>();
  for (const [relDocPath, u] of Object.entries(state.units)) {
    if (isRealDoc(u.docs)) map.set(relDocPath, u.docs as string);
  }
  return map;
}

/** Manual edges + per-page owner list, mirroring readManualEdges' shape. */
export function manualEdgesFromState(state: GraphdocState): {
  edges: Array<{ from: string; to: string }>;
  ownByPath: Map<string, string[]>;
} {
  const edges: Array<{ from: string; to: string }> = [];
  const ownByPath = new Map<string, string[]>();
  for (const [relDocPath, u] of Object.entries(state.units)) {
    if (!u.manualUses || !u.manualUses.length) continue;
    const from = baseName(relDocPath);
    ownByPath.set(relDocPath, u.manualUses);
    for (const to of u.manualUses) edges.push({ from, to });
  }
  return { edges, ownByPath };
}

/** unitName → target names, for analyzer.readManualTree. */
export function manualTreeFromState(
  state: GraphdocState,
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [relDocPath, u] of Object.entries(state.units)) {
    if (u.manualUses && u.manualUses.length)
      map.set(baseName(relDocPath), u.manualUses);
  }
  return map;
}

/** unitName → absolute source path, for analyzer.readDocsNameIndex. */
export function nameIndexFromState(
  state: GraphdocState,
  repoRoot: string,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const [relDocPath, u] of Object.entries(state.units)) {
    if (u.source) map.set(baseName(relDocPath), join(repoRoot, u.source));
  }
  return map;
}

function baseName(relDocPath: string): string {
  const file = relDocPath.replace(/\\/g, "/").split("/").pop() ?? relDocPath;
  return file.replace(/\.md$/, "");
}
