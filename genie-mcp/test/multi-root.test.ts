import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectProject } from "../dist/graphdoc/detect-project.js";
import { analyze, rootsLabel } from "../dist/graphdoc/analyzer.js";
import { buildGraphData } from "../dist/graphdoc/graph-core.js";
import { configureGraphdocWrites } from "../dist/graphdoc/write-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "pages-app");

describe("multi-root mode (folder of independent roots, no entry point)", () => {
  it("detects a project without an entry file instead of failing", () => {
    const d = detectProject(fixture);
    expect(d.framework).toContain("React");
    expect(d.rootFile).toBe("");
  });

  it("labels the tree root after the root folders", () => {
    expect(rootsLabel(["src/pages"])).toBe("pages");
    expect(rootsLabel(["src/pages/", "src/jobs"])).toBe("pages + jobs");
  });

  it("documents every page as its own root in one doc set, with specs attached", async () => {
    const d = detectProject(fixture);
    const docsDir = await mkdtemp(join(tmpdir(), "graphdoc-roots-"));
    configureGraphdocWrites({ root: docsDir, graphdocDir: docsDir });
    try {
      const res = await analyze(fixture, {
        ...d,
        rootName: "pages",
        docsDir,
        projectKind: d.kind,
        roots: ["src/pages"],
        includeSpecs: true,
      });
      const tree = res.tree.pages;
      // Every file directly in pages/ is a root — NotFoundPage too, although
      // CartPage renders it (it shows up under CartPage as well). In the
      // checkout/ subfolder, CheckoutSummary is imported by CheckoutPage → nested.
      expect(Object.keys(tree).sort()).toEqual([
        "CartPage",
        "CheckoutPage",
        "HomePage",
        "NotFoundPage",
      ]);
      expect(tree.CartPage).toHaveProperty("NotFoundPage");
      expect(Object.keys(tree.CheckoutPage)).toContain("CheckoutSummary");
      expect(tree.CheckoutPage.CheckoutSummary).toHaveProperty("Button");
      // Specs hang off the pages they import.
      expect(tree.HomePage).toHaveProperty(["🧪 HomePage.test"]);
      expect(tree.CartPage).toHaveProperty(["🧪 CartPage.spec"]);
      expect(tree.CheckoutPage).toHaveProperty(["🧪 CartPage.spec"]);
      expect(res.specs).toMatchObject({ files: 2, tests: 3 });

      // No artificial hub: the label is not a unit and pages share no parent.
      const { nodes, edges } = buildGraphData(res.cache, d.srcRoot);
      expect(nodes.some((n) => n.name === "pages")).toBe(false);
      expect(edges.some((e) => e.child === "HomePage")).toBe(false);

      expect(await readFile(join(docsDir, "Tree.md"), "utf8")).toContain(
        "root((pages))",
      );
      expect(
        await readFile(join(docsDir, "src", "pages", "HomePage.md"), "utf8"),
      ).toContain("🧪 [[HomePage.test]]");
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  });

});
