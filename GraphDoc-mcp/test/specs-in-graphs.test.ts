import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { attachSpecsToTree } from "../dist/analyzer.js";
import { emitGraph } from "../dist/emit-graph.js";
import { specNames } from "../dist/spec-analyzer.js";
import { writeState } from "../dist/state-store.js";
import type { FileInfo, SpecFile, UnitInfo } from "../dist/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "node-app");
const repo = "/repo";

/** One file defining `names`, each using the next (a chain). */
function cacheOf(file: string, names: string[]): Map<string, FileInfo> {
  const units = new Map<string, UnitInfo>(
    names.map((n, i) => [
      n,
      {
        used: new Set(names[i + 1] ? [names[i + 1]] : []),
        description: null,
        kind: "function",
      },
    ]),
  );
  return new Map([
    [
      file,
      {
        imports: new Map(),
        units,
        defaultExport: null,
        language: "ts",
        reExports: new Map(),
        wildcardReExports: [],
        pendingLazy: [],
      },
    ],
  ]);
}

const spec = (file: string, targets: Array<[string, string]>): SpecFile => ({
  file,
  tests: ["t"],
  targets: targets.map(([f, name]) => ({ file: f, name })),
  outsideGraph: [],
});

describe("specs in trees and graphs", () => {
  it("keeps same-basename specs apart with path-qualified names and links", () => {
    const names = specNames(
      [
        spec(`${repo}/src/a/index.test.ts`, []),
        spec(`${repo}/src/b/index.test.ts`, []),
        spec(`${repo}/tests/Unique.spec.ts`, []),
      ],
      repo,
    );
    expect(names.get(`${repo}/src/a/index.test.ts`)).toEqual({
      name: "src/a/index.test",
      link: "[[specs/src/a/index.test\\|src/a/index.test]]",
      page: "specs/src/a/index.test.md",
    });
    expect(names.get(`${repo}/src/b/index.test.ts`)!.name).toBe(
      "src/b/index.test",
    );
    expect(names.get(`${repo}/tests/Unique.spec.ts`)).toEqual({
      name: "Unique.spec",
      link: "[[Unique.spec]]",
      page: "specs/tests/Unique.spec.md",
    });
  });

  it("hangs spec leaves under every occurrence of a tested unit, root included", () => {
    const file = `${repo}/src/m.ts`;
    const cache = cacheOf(file, ["Root", "A", "B"]);
    const tree = { Root: { A: { B: {} }, B: {} } };
    attachSpecsToTree(tree, cache, `${repo}/src`, repo, [
      spec(`${repo}/tests/root.spec.ts`, [[file, "Root"]]),
      spec(`${repo}/tests/b.spec.ts`, [[file, "B"]]),
      spec(`${repo}/tests/b2.spec.ts`, [
        [file, "B"],
        [file, "B"],
      ]),
    ]);
    expect(tree).toEqual({
      Root: {
        A: { B: { "🧪 b.spec": {}, "🧪 b2.spec": {} } },
        B: { "🧪 b.spec": {}, "🧪 b2.spec": {} },
        "🧪 root.spec": {},
      },
    });
  });

  it("gives specs their own diagram when the graph is split by category", async () => {
    const file = `${repo}/src/m.ts`;
    const names = Array.from({ length: 160 }, (_, i) => `U${i}`);
    const docsDir = await mkdtemp(join(tmpdir(), "graphdoc-split-"));
    try {
      await emitGraph({
        cache: cacheOf(file, names),
        srcRoot: `${repo}/src`,
        docsDir,
        repoRoot: repo,
        specs: [spec(`${repo}/tests/u.spec.ts`, [[file, "U7"]])],
      });
      const md = await readFile(join(docsDir, "Graph.md"), "utf8");
      expect(md).toContain("split by category");
      expect(md).toContain("## 🧪 Tests (1 spec files, 1 edges)");
      expect(md).toContain("spec_u_spec -.-> U7");
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  });

  it("get_tree tool shows spec leaves when includeSpecs is set in graphdoc.json", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "graphdoc-gettree-"));
    const client = new Client({ name: "test", version: "0" });
    try {
      const call = async () => {
        const r = await client.callTool({
          name: "get_tree",
          arguments: { workDir: fixture, outDir },
        });
        return (r.content as Array<{ text: string }>)[0].text;
      };
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [join(here, "..", "dist", "index.js")],
          stderr: "ignore",
        }),
      );

      expect(await call()).not.toContain("🧪"); // off by default

      await writeState(outDir, {
        version: 1,
        analyze: {
          rootFile: null,
          rootName: null,
          styledComponents: false,
          includeSpecs: true,
        },
        modules: [],
        onboard: {},
        units: {},
      });
      const text = await call();
      expect(text).toMatch(/UserService\n.*db\n.*🧪 userService\.spec/);
      expect(text).toContain("🧪 userController.test");
    } finally {
      await client.close();
      await rm(outDir, { recursive: true, force: true });
    }
  }, 20_000);
});
