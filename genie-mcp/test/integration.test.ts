import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectProject } from "../dist/graphdoc/detect-project.js";
import { loadPathAliases } from "../dist/graphdoc/tsconfig-paths.js";
import { buildCache } from "../dist/graphdoc/analyzer.js";
import { buildGraphData } from "../dist/graphdoc/graph-core.js";
import { emitFolderDocs } from "../dist/graphdoc/emit-folder-docs.js";
import { writeState, writeDocsEntry } from "../dist/graphdoc/state-store.js";
import { configureGraphdocWrites } from "../dist/graphdoc/write-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "sample-app");

describe("end-to-end on a fixture project", () => {
  it("detects the project", () => {
    const d = detectProject(fixture);
    expect(d.framework).toContain("React");
    expect(d.rootName).toBe("App");
  });

  it("resolves barrel + alias + dynamic-import edges and disambiguates collisions", async () => {
    const d = detectProject(fixture);
    const aliases = loadPathAliases(d.repoRoot);
    const cache = await buildCache(d.srcRoot, d.rootFile, aliases);
    const { nodes, edges, collisions } = buildGraphData(cache, d.srcRoot);
    const has = (parent: string, child: string) =>
      edges.some((e) => e.parent === parent && e.child === child);

    // Barrel re-export through a tsconfig path alias (@components), now to the
    // disambiguated `ui/Button` — the regression that motivated this effort.
    expect(has("App", "ui/Button")).toBe(true);
    // The directly-imported design-2.0 variant is its own distinct node.
    expect(has("App", "ui-v2/Button")).toBe(true);
    // Lazily-loaded page reached only via dynamic import().
    expect(has("App", "LazyPage")).toBe(true);
    // Two distinct Button nodes (not one merged), and the collision is reported.
    expect(
      nodes
        .filter((n) => n.name === "Button")
        .map((n) => n.displayName)
        .sort(),
    ).toEqual(["ui-v2/Button", "ui/Button"]);
    expect(
      collisions.some((c) => c.name === "Button" && c.files.length === 2),
    ).toBe(true);

    // Two same-named components reached ONLY via lazy() dynamic import must not
    // collapse into one edge — each keeps its own path-qualified node.
    expect(has("App", "v1/RechargeManager")).toBe(true);
    expect(has("App", "v2/RechargeManager")).toBe(true);
    expect(
      nodes
        .filter((n) => n.name === "RechargeManager")
        .map((n) => n.displayName)
        .sort(),
    ).toEqual(["v1/RechargeManager", "v2/RechargeManager"]);
  });

  it("restores DOCS blocks + manual links from graphdoc.json on a fresh clone (no docs/src on disk)", async () => {
    const d = detectProject(fixture);
    const aliases = loadPathAliases(d.repoRoot);
    const cache = await buildCache(d.srcRoot, d.rootFile, aliases);

    const docsDir = await mkdtemp(join(tmpdir(), "graphdoc-regen-"));
    configureGraphdocWrites({ root: docsDir, graphdocDir: docsDir });
    try {
      // Only the committed graphdoc.json exists — docs/src does not (simulating a clone).
      await writeState(docsDir, {
        version: 1,
        analyze: { rootFile: null, rootName: null, styledComponents: false },
        modules: [],
        onboard: {},
        units: {
          "App.md": {
            source: "src/App.tsx",
            docs: "Restored description for App.",
            manualUses: ["LazyPage"],
          },
        },
      });

      await emitFolderDocs({
        cache,
        srcRoot: d.srcRoot,
        docsDir,
        repoRoot: d.repoRoot,
        rebuild: true,
      });

      // Every page gets an auto Props section (from source) by default — no
      // document_unit needed. Button has `ButtonProps { label, onClick? }`.
      const buttonPage = await readFile(
        join(docsDir, "src", "components", "ui", "Button", "Button.md"),
        "utf8",
      );
      expect(buttonPage).toContain("## Props");
      expect(buttonPage).toContain("`label`");
      expect(buttonPage).toContain("`onClick()`"); // on* rendered as a callback

      const appPage = await readFile(join(docsDir, "src", "App.md"), "utf8");
      // DOCS block restored from JSON, not the placeholder.
      expect(appPage).toContain("Restored description for App.");
      expect(appPage).not.toContain("_Add a description here");
      // Manual link restored: frontmatter + rendered bullet.
      expect(appPage).toMatch(/manualUses:\n\s*-\s*LazyPage/);
      expect(appPage).toContain("*(manual)*");
      expect(appPage).toContain("LazyPage");
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  });

  it("targeted materialize (document_unit style) rewrites only the changed page", async () => {
    const d = detectProject(fixture);
    const aliases = loadPathAliases(d.repoRoot);
    const cache = await buildCache(d.srcRoot, d.rootFile, aliases);
    const docsDir = await mkdtemp(join(tmpdir(), "graphdoc-only-"));
    configureGraphdocWrites({ root: docsDir, graphdocDir: docsDir });
    try {
      // Full emit once.
      await emitFolderDocs({
        cache,
        srcRoot: d.srcRoot,
        docsDir,
        repoRoot: d.repoRoot,
        rebuild: true,
      });
      const appPath = join(docsDir, "src", "App.md");
      const otherPath = join(
        docsDir,
        "src",
        "components",
        "ui",
        "Button",
        "Button.md",
      );
      const otherBefore = await readFile(otherPath, "utf8");

      // Document ONE unit in JSON, then materialize ONLY its page.
      await writeDocsEntry(docsDir, "App.md", {
        source: "src/App.tsx",
        docs: "Freshly documented App.",
      });
      await emitFolderDocs({
        cache,
        srcRoot: d.srcRoot,
        docsDir,
        repoRoot: d.repoRoot,
        only: new Set(["App.md"]),
      });

      // Target page updated…
      expect(await readFile(appPath, "utf8")).toContain(
        "Freshly documented App.",
      );
      // …and a different page left byte-for-byte untouched.
      expect(await readFile(otherPath, "utf8")).toBe(otherBefore);
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  });
});
