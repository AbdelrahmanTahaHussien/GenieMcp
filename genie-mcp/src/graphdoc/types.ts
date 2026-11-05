/**
 * types.ts — shared contracts used by the analyzer and emitters.
 *
 * A project (React app or plain JS/TS / Node) is modeled as "modules" (files),
 * "units" (the things defined in them — components, hooks/functions, classes),
 * and "edges" (import/use relationships between units). Parsing lives in
 * react-analyzer.ts; everything downstream — graph building, doc emission,
 * onboarding — works on these types.
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
  /**
   * Plain JS/TS projects: the unit's public shape — class methods/fields,
   * function parameters, object-literal members — rendered in Api.md.
   */
  api?: UnitApi;
};

/** One method / field / function signature for Api.md. */
export type ApiMember = {
  name: string;
  kind: "method" | "field";
  /** Parameter texts (`user: TestUser`); methods only. */
  params?: string[];
  /** Field type or method return type, as written in source. */
  type?: string;
  visibility: "public" | "protected" | "private";
  static?: boolean;
  abstract?: boolean;
};

export type UnitApi = {
  /** "class" box, a "function" signature, or an object literal's "members". */
  shape: "class" | "function" | "object";
  members: ApiMember[];
  /** Local name of the superclass (`class A extends B` → "B"). */
  extends?: string;
  /** Local names of implemented interfaces. */
  implements?: string[];
  abstract?: boolean;
};

export type UnitKind =
  | "component" // React component (returns JSX)
  | "class" // TS/JS class
  | "function" // standalone function / hook
  | "other"; // module-level object / instance (e.g. `const app = express()`)

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
  /**
   * Names used by module-level statements that belong to no unit (e.g.
   * `bootstrap()`, `createRoot(…).render(<App />)`, `app.listen()`). Only
   * consumed when the entry file has no unit of its own and a synthetic root
   * unit is built for it (see analyzer.ensureRootUnit).
   */
  moduleUsed?: Set<string>;
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

/** "react" = React app (JSX components); "node" = plain JS/TS (library, CLI, server). */
export type ProjectKind = "react" | "node";

export type ProjectInfo = {
  repoRoot: string;
  srcRoot: string;
  /** Absolute path to the "root" entry file (best-effort; "" when none found). */
  rootFile: string;
  /** Name of the root unit (component / main function / etc.). */
  rootName: string;
  docsDir: string;
  /** "js" | "ts" */
  language: string;
  /** Display name of the framework detected (e.g. "React (Vite)", "Express"). */
  framework: string;
  kind: ProjectKind;
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
  /** Spec coverage — present only when includeSpecs is enabled. */
  specs?: SpecSummary;
};

// ─── specs ─────────────────────────────────────────────────────────────────

/** One analyzed spec/test file. */
export type SpecFile = {
  /** Absolute path of the spec file. */
  file: string;
  /** Test case titles, suite-prefixed ("UserService › returns users"). */
  tests: string[];
  /** First-party units the spec imports (resolved to their defining file). */
  targets: Array<{ file: string; name: string }>;
  /** First-party source files imported by the spec but outside the analyzed graph. */
  outsideGraph: string[];
};

export type SpecSummary = {
  files: number;
  tests: number;
  /** Units exercised by at least one spec / total units in the graph. */
  coveredUnits: number;
  totalUnits: number;
};

// ─── onboarding ────────────────────────────────────────────────────────────

export type OnboardingContext = {
  projectInfo: Omit<ProjectInfo, "kind"> & {
    /** Multi-root mode: the configured roots (repo-relative folders/files). */
    roots?: string[];
  };
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
  /** Spec coverage — present only when includeSpecs is enabled. */
  specs?: SpecSummary;
};
