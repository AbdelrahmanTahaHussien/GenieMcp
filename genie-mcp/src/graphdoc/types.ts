/**
 * types.ts — shared contracts used by the analyzer and emitters.
 *
 * A React project is modeled as "modules" (files), "units" (the things defined
 * in them — components, hooks/functions, classes), and "edges" (import/use
 * relationships between units). JSX parsing lives in react-analyzer.ts;
 * everything downstream — graph building, doc emission, onboarding — works on
 * these types.
 */

// ─── core graph types ──────────────────────────────────────────────────────

/** One resolved import inside a file. */
export type ImportRecord = {
  /** Absolute path to the file being imported. */
  file: string;
  /** The exported name inside that file ("default" | named symbol). */
  importedName: string;
};

/** One named unit (component / class / function / service) in a file. */
export type UnitInfo = {
  /** Names of other units this unit directly uses/calls/renders. */
  used: Set<string>;
  /**
   * Subset of `used` that was reached via a dynamic `import()` (e.g. lazy
   * loading). These are also present in `used` so normal resolution works;
   * this set only drives the `(lazy)` render tag.
   */
  lazyUsed?: Set<string>;
  /** Leading doc comment, if any. */
  description: string | null;
  /** Kind of unit: "component" | "class" | "function" | "other" */
  kind: UnitKind;
  /**
   * Prop names from the unit's `<Name>Props` (or file-primary bare `Props`)
   * interface / type-literal alias, captured during analysis so consumers
   * don't need a separate re-parse of the source file.
   */
  props?: string[];
};

export type UnitKind =
  | "component" // React component (returns JSX)
  | "class" // TS/JS class
  | "function" // standalone function / hook
  | "other";

/** All information extracted from one source file. */
export type FileInfo = {
  imports: Map<string, ImportRecord>;
  /** key = unit name */
  units: Map<string, UnitInfo>;
  defaultExport: string | null;
  /** "js" | "ts" */
  language: string;
  /**
   * Named re-exports that forward to another module — barrels.
   * key = exported (local) name, value = where it really comes from.
   * e.g. `export { default as Wallet } from './Wallet/Wallet'`
   *      → "Wallet" → { file: <…/Wallet.tsx>, importedName: "default" }
   */
  reExports: Map<string, ImportRecord>;
  /** Resolved files behind `export * from './x'` (wildcard barrels). */
  wildcardReExports: string[];
  /**
   * Dynamic `import()` targets found in unit bodies, attributed to the unit.
   * Resolved into real edges after the whole cache is built.
   */
  pendingLazy: Array<{ unit: string; file: string }>;
};

// ─── tree + graph ─────────────────────────────────────────────────────────

export type Tree = { [k: string]: Tree };

export type GraphNode = {
  /** Bare unit name as written in source (e.g. "Button"). */
  name: string;
  /**
   * Globally-unique display name. Equals `name` unless the name is defined in
   * multiple files, in which case it is path-prefixed (e.g. "ui/Button").
   */
  displayName: string;
  /** True when `displayName !== name` (the name collides across files). */
  colliding?: boolean;
  file: string;
  category: string;
  kind: UnitKind;
  language: string;
};

export type GraphEdge = { parent: string; child: string };

// ─── project detection ─────────────────────────────────────────────────────

export type ProjectInfo = {
  repoRoot: string;
  srcRoot: string;
  /** Absolute path to the "root" entry file (best-effort). */
  rootFile: string;
  /** Name of the root unit (component / main function / etc.). */
  rootName: string;
  docsDir: string;
  /** "js" | "ts" */
  language: string;
  /** Display name of the framework detected (e.g. "React (Vite)"). */
  framework: string;
};

// ─── analysis result ───────────────────────────────────────────────────────

export type AnalyzeResult = {
  tree: Tree;
  treeText: string;
  cache: Map<string, FileInfo>;
  stats: {
    files: number;
    units: number;
    language: string;
    framework: string;
  };
};

// ─── onboarding ────────────────────────────────────────────────────────────

export type OnboardingContext = {
  projectInfo: ProjectInfo;
  stats: AnalyzeResult["stats"];
  /** Top-level tree (root → direct children display names). */
  topLevel: string[];
  /** Most-reused units (display name → count). */
  hotspots: Array<{
    name: string;
    displayName: string;
    usedBy: number;
    kind: UnitKind;
  }>;
  /** Units with doc comments (display name → description). */
  documented: Array<{ displayName: string; description: string }>;
  /** Total edge count. */
  edgeCount: number;
  /** Display name → wiki-link string (path-qualified for colliding units). */
  wikiLinks: Map<string, string>;
};
