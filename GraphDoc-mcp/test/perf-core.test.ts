import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectProject } from "../dist/detect-project.js";
import { loadPathAliases } from "../dist/tsconfig-paths.js";
import { buildCache, subsetReachableFrom } from "../dist/analyzer.js";
import { buildGraphData } from "../dist/graph-core.js";
import { clearFileCache, fileCacheStats } from "../dist/file-cache.js";
import { extractPropsFromSource } from "../dist/extract-props.js";
import { emitMatrix, MATRIX_GRID_MAX_CELLS } from "../dist/emit-matrix.js";
import { writeDocsEntry, readState } from "../dist/state-store.js";
import type { FileInfo, UnitInfo } from "../dist/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "sample-app");

beforeEach(() => clearFileCache());
afterEach(() => clearFileCache());

describe("A1 — session file-cache", () => {
  let proj: string;
  beforeEach(async () => {
    proj = await mkdtemp(join(tmpdir(), "graphdoc-cache-"));
    await mkdir(join(proj, "src"), { recursive: true });
    await writeFile(
      join(proj, "package.json"),
      JSON.stringify({ name: "t", dependencies: { react: "18.0.0" } }),
    );
    await writeFile(
      join(proj, "src", "App.tsx"),
      "export default function App() { return <div/>; }\n",
    );
  });
  afterEach(async () => rm(proj, { recursive: true, force: true }));

  it("reuses the parsed FileInfo across buildCache calls (identity hit)", async () => {
    const srcRoot = join(proj, "src");
    const rootFile = join(srcRoot, "App.tsx");
    const c1 = await buildCache(srcRoot, rootFile);
    const c2 = await buildCache(srcRoot, rootFile);
    // Same object instance ⇒ served from the session cache, not re-parsed.
    expect(c2.get(rootFile)).toBe(c1.get(rootFile));
    expect(fileCacheStats().parsedFiles).toBeGreaterThan(0);
  });

  it("invalidates on file change (mtime/size) and re-parses", async () => {
    const srcRoot = join(proj, "src");
    const rootFile = join(srcRoot, "App.tsx");
    const c1 = await buildCache(srcRoot, rootFile);
    expect([...c1.get(rootFile)!.units.keys()]).toEqual(["App"]);

    await writeFile(
      rootFile,
      "export function Extra() { return <span/>; }\nexport default function App() { return <Extra/>; }\n",
    );
    const c2 = await buildCache(srcRoot, rootFile);
    expect(c2.get(rootFile)).not.toBe(c1.get(rootFile));
    expect([...c2.get(rootFile)!.units.keys()].sort()).toEqual([
      "App",
      "Extra",
    ]);
  });

  it("cached FileInfo reuse keeps the graph stable (resolveLazyEdges idempotent)", async () => {
    const d = detectProject(fixture);
    const aliases = loadPathAliases(d.repoRoot);
    const edgeKey = (e: { parent: string; child: string }) =>
      `${e.parent}→${e.child}`;

    const fresh = await buildCache(d.srcRoot, d.rootFile, aliases);
    const freshEdges = buildGraphData(fresh, d.srcRoot)
      .edges.map(edgeKey)
      .sort();

    // Second run hits the session cache and mutates the SAME FileInfo objects
    // via resolveLazyEdges — the graph must not change or duplicate.
    const cached = await buildCache(d.srcRoot, d.rootFile, aliases);
    const cachedEdges = buildGraphData(cached, d.srcRoot)
      .edges.map(edgeKey)
      .sort();

    expect(cachedEdges).toEqual(freshEdges);
  });
});

describe("A2 — subsetReachableFrom", () => {
  it("matches a scoped buildCache from the same entry file", async () => {
    const d = detectProject(fixture);
    const aliases = loadPathAliases(d.repoRoot);
    const full = await buildCache(d.srcRoot, undefined, aliases);

    const subset = subsetReachableFrom(full, d.rootFile);
    const scoped = await buildCache(d.srcRoot, d.rootFile, aliases);

    expect([...subset.keys()].sort()).toEqual([...scoped.keys()].sort());
    // Shares the objects (no re-parse).
    expect(subset.get(d.rootFile)).toBe(full.get(d.rootFile));
  });
});

describe("A4 — props captured during analysis", () => {
  it("unit.props matches extract-props on the fixture Button", async () => {
    const d = detectProject(fixture);
    const aliases = loadPathAliases(d.repoRoot);
    const cache = await buildCache(d.srcRoot, d.rootFile, aliases);
    const buttonFile = join(
      d.srcRoot,
      "components",
      "ui",
      "Button",
      "Button.tsx",
    );
    const fromAnalyzer = cache.get(buttonFile)?.units.get("Button")?.props;
    const fromExtract = await extractPropsFromSource(buttonFile, "Button");
    expect(fromAnalyzer?.slice().sort()).toEqual(fromExtract.slice().sort());
    expect(fromAnalyzer?.slice().sort()).toEqual(["label", "onClick"]);
  });
});

describe("D1 — Matrix grid cap", () => {
  const mkUnit = (used: string[]): UnitInfo => ({
    used: new Set(used),
    description: null,
    kind: "component",
  });

  const mkFile = (
    name: string,
    used: string[],
    imports: Array<[string, string]>,
  ): FileInfo => ({
    imports: new Map(
      imports.map(([n, f]) => [n, { file: f, importedName: n }]),
    ),
    units: new Map([[name, mkUnit(used)]]),
    defaultExport: name,
    language: "ts",
    reExports: new Map(),
    wildcardReExports: [],
    pendingLazy: [],
  });

  it("emits the grid for small graphs and omits it above the cap", async () => {
    const out = await mkdtemp(join(tmpdir(), "graphdoc-matrix-"));
    try {
      // Small synthetic graph → grid present.
      const small = new Map<string, FileInfo>();
      const childFile = "/x/src/Child.tsx";
      small.set(childFile, mkFile("Child", [], []));
      small.set(
        "/x/src/Parent.tsx",
        mkFile("Parent", ["Child"], [["Child", childFile]]),
      );
      await emitMatrix({ cache: small, srcRoot: "/x/src", docsDir: out });
      const smallMd = await readFile(join(out, "Matrix.md"), "utf8");
      expect(smallMd).toContain("| **Parent** |");
      expect(smallMd).not.toContain("Grid omitted");

      // Big synthetic graph: parents × children above the cap → grid omitted.
      const parents = 200;
      const children = Math.ceil(MATRIX_GRID_MAX_CELLS / parents) + 5;
      const big = new Map<string, FileInfo>();
      const childNames: string[] = [];
      for (let c = 0; c < children; c++) {
        const name = `C${c}`;
        childNames.push(name);
        big.set(`/x/src/kids/${name}.tsx`, mkFile(name, [], []));
      }
      for (let p = 0; p < parents; p++) {
        big.set(
          `/x/src/parents/P${p}.tsx`,
          mkFile(
            `P${p}`,
            childNames,
            childNames.map((n) => [n, `/x/src/kids/${n}.tsx`]),
          ),
        );
      }
      await emitMatrix({ cache: big, srcRoot: "/x/src", docsDir: out });
      const bigMd = await readFile(join(out, "Matrix.md"), "utf8");
      expect(bigMd).toContain("Grid omitted");
      // Leaderboard + edge list still present.
      expect(bigMd).toContain("Reuse leaderboard");
      expect(bigMd).toContain("Edge list");
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});

describe("B1 — state write serialization", () => {
  it("20 concurrent writeDocsEntry calls all land", async () => {
    const docsDir = await mkdtemp(join(tmpdir(), "graphdoc-lock-"));
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          writeDocsEntry(docsDir, `U${i}.md`, {
            source: `src/U${i}.tsx`,
            docs: `doc ${i}`,
          }),
        ),
      );
      const state = await readState(docsDir);
      expect(Object.keys(state.units)).toHaveLength(20);
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  });
});
