import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { detectProject } from "../dist/detect-project.js";
import { analyze, rootsLabel } from "../dist/analyzer.js";
import { buildGraphData } from "../dist/graph-core.js";
import { readState } from "../dist/state-store.js";

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

  it("works end to end through the MCP tools and persists roots", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "graphdoc-roots-mcp-"));
    const client = new Client({ name: "test", version: "0" });
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return (r.content as Array<{ text: string }>)[0].text;
    };
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(here, "..", "dist", "index.js")],
          stderr: "ignore",
        }),
      );
      // No entry + no roots → a helpful error, not a crash.
      expect(
        await call("generate_graphdoc", { workDir: fixture, outDir }),
      ).toMatch(/roots=\["src\/pages"\]/);

      const gen = await call("generate_graphdoc", {
        workDir: fixture,
        outDir,
        roots: [join(fixture, "src", "pages")], // absolute → stored repo-relative
        includeSpecs: true,
      });
      expect(gen).toContain("Roots    : src/pages");
      expect((await readState(outDir)).analyze.roots).toEqual(["src/pages"]);
      const onboarding = await readFile(join(outDir, "ONBOARDING.md"), "utf8");
      expect(onboarding).toContain("independent roots");

      // Other tools reuse the stored roots.
      const tree = await call("get_tree", { workDir: fixture, outDir });
      expect(tree).toMatch(/^pages$/m);
      expect(tree).toContain("CheckoutPage");
      expect(tree).toContain("🧪 HomePage.test");

      // [] without an entry keeps failing (and keeps the stored roots)…
      expect(
        await call("analyze_project", { workDir: fixture, outDir, roots: [] }),
      ).toMatch(/Could not find an entry file/);
      expect((await readState(outDir)).analyze.roots).toEqual(["src/pages"]);
      // …while [] + an explicit rootFile switches back to single-entry mode.
      await call("analyze_project", {
        workDir: fixture,
        outDir,
        roots: [],
        rootFile: join(fixture, "src", "pages", "HomePage.tsx"),
      });
      expect((await readState(outDir)).analyze.roots).toBeUndefined();
    } finally {
      await client.close();
      await rm(outDir, { recursive: true, force: true });
    }
  }, 20_000);
});
