import { describe, it, expect } from "vitest";
import {
  resolveExported,
  buildGraphData,
  computeDisplayNames,
  wikiLinkFor,
  safeMermaidIdent,
  escapeMdCell,
  capOutput,
  categoryFor,
} from "../dist/graph-core.js";
import { buildTree } from "../dist/analyzer.js";
import type { FileInfo, UnitInfo } from "../dist/types.js";

// ── tiny in-memory cache builders ────────────────────────────────────────────

function unit(used: string[] = []): UnitInfo {
  return { used: new Set(used), description: null, kind: "component" };
}

function file(partial: Partial<FileInfo>): FileInfo {
  return {
    imports: partial.imports ?? new Map(),
    units: partial.units ?? new Map(),
    defaultExport: partial.defaultExport ?? null,
    language: partial.language ?? "ts",
    reExports: partial.reExports ?? new Map(),
    wildcardReExports: partial.wildcardReExports ?? [],
    pendingLazy: partial.pendingLazy ?? [],
  };
}

describe("resolveExported", () => {
  it("follows `export { default as X } from` barrel re-exports", () => {
    const cache = new Map<string, FileInfo>([
      [
        "/Button.tsx",
        file({ units: new Map([["Button", unit()]]), defaultExport: "Button" }),
      ],
      [
        "/index.ts",
        file({
          reExports: new Map([
            ["Button", { file: "/Button.tsx", importedName: "default" }],
          ]),
        }),
      ],
    ]);
    // The regression that started the whole audit: barrel must resolve.
    expect(resolveExported("/index.ts", "Button", cache)).toEqual({
      file: "/Button.tsx",
      name: "Button",
    });
  });

  it("follows `export *` wildcard barrels", () => {
    const cache = new Map<string, FileInfo>([
      ["/Card.tsx", file({ units: new Map([["Card", unit()]]) })],
      ["/index.ts", file({ wildcardReExports: ["/Card.tsx"] })],
    ]);
    expect(resolveExported("/index.ts", "Card", cache)).toEqual({
      file: "/Card.tsx",
      name: "Card",
    });
  });

  it("resolves default exports", () => {
    const cache = new Map<string, FileInfo>([
      [
        "/App.tsx",
        file({ units: new Map([["App", unit()]]), defaultExport: "App" }),
      ],
    ]);
    expect(resolveExported("/App.tsx", "default", cache)).toEqual({
      file: "/App.tsx",
      name: "App",
    });
  });

  it("returns null (no infinite loop) on cyclic barrels", () => {
    const cache = new Map<string, FileInfo>([
      ["/a.ts", file({ wildcardReExports: ["/b.ts"] })],
      ["/b.ts", file({ wildcardReExports: ["/a.ts"] })],
    ]);
    expect(resolveExported("/a.ts", "Nope", cache)).toBeNull();
  });
});

describe("buildGraphData", () => {
  it("resolves a barrel edge end-to-end", () => {
    const cache = new Map<string, FileInfo>([
      [
        "/App.tsx",
        file({
          units: new Map([["App", unit(["Button"])]]),
          imports: new Map([
            ["Button", { file: "/index.ts", importedName: "Button" }],
          ]),
        }),
      ],
      [
        "/index.ts",
        file({
          reExports: new Map([
            ["Button", { file: "/Button.tsx", importedName: "default" }],
          ]),
        }),
      ],
      [
        "/Button.tsx",
        file({ units: new Map([["Button", unit()]]), defaultExport: "Button" }),
      ],
    ]);
    const { edges } = buildGraphData(cache, "/");
    expect(edges).toContainEqual({ parent: "App", child: "Button" });
  });

  it("keeps colliding units as DISTINCT nodes with disambiguated display names", () => {
    const cache = new Map<string, FileInfo>([
      ["/a/Button.tsx", file({ units: new Map([["Button", unit()]]) })],
      ["/b/Button.tsx", file({ units: new Map([["Button", unit()]]) })],
    ]);
    const { nodes, collisions } = buildGraphData(cache, "/");
    const display = nodes
      .filter((n) => n.name === "Button")
      .map((n) => n.displayName)
      .sort();
    expect(display).toEqual(["a/Button", "b/Button"]); // two distinct nodes, not one
    expect(nodes.every((n) => n.name !== "Button" || n.colliding)).toBe(true);
    expect(collisions).toEqual([
      { name: "Button", files: ["/a/Button.tsx", "/b/Button.tsx"] },
    ]);
  });

  it("points an edge at the SPECIFIC colliding variant that was imported", () => {
    const cache = new Map<string, FileInfo>([
      [
        "/App.tsx",
        file({
          units: new Map([["App", unit(["Button"])]]),
          imports: new Map([
            ["Button", { file: "/ui-v2/Button.tsx", importedName: "default" }],
          ]),
        }),
      ],
      [
        "/ui/Button.tsx",
        file({ units: new Map([["Button", unit()]]), defaultExport: "Button" }),
      ],
      [
        "/ui-v2/Button.tsx",
        file({ units: new Map([["Button", unit()]]), defaultExport: "Button" }),
      ],
    ]);
    const { edges } = buildGraphData(cache, "/");
    expect(edges).toContainEqual({ parent: "App", child: "ui-v2/Button" });
    expect(edges).not.toContainEqual({ parent: "App", child: "ui/Button" });
  });

  it("is deterministic: canonical node picks the first file by sorted path", () => {
    const build = () =>
      buildGraphData(
        new Map<string, FileInfo>([
          ["/z/Button.tsx", file({ units: new Map([["Button", unit()]]) })],
          ["/a/Button.tsx", file({ units: new Map([["Button", unit()]]) })],
        ]),
        "/",
      );
    expect(build().nodes.find((n) => n.name === "Button")!.file).toBe(
      "/a/Button.tsx",
    );
    expect(build().nodes.find((n) => n.name === "Button")!.file).toBe(
      "/a/Button.tsx",
    );
  });
});

describe("formatting helpers", () => {
  it("safeMermaidIdent strips unsafe chars and collapses underscores", () => {
    expect(safeMermaidIdent("Foo.Bar/Baz")).toBe("Foo_Bar_Baz");
    expect(safeMermaidIdent("a--b")).toBe("a_b");
  });

  it("escapeMdCell escapes pipes and backslashes", () => {
    expect(escapeMdCell("a|b")).toBe("a\\|b");
    expect(escapeMdCell("a\\b")).toBe("a\\\\b");
  });

  it("capOutput truncates with a notice and stays under the limit", () => {
    const big = "x".repeat(1000);
    const out = capOutput(big, 200, "do X");
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out).toContain("truncated");
    expect(out).toContain("do X");
  });

  it("capOutput leaves small text untouched", () => {
    expect(capOutput("hello", 200)).toBe("hello");
  });

  it("categoryFor maps known folders", () => {
    expect(categoryFor("/repo/src/components/Button.tsx", "/repo/src")).toBe(
      "Components",
    );
    expect(categoryFor("/repo/src/App.tsx", "/repo/src")).toBe("Root");
  });
});

describe("same-name disambiguation", () => {
  it("computeDisplayNames strips common head+tail to the minimal discriminator", () => {
    const cache = new Map<string, FileInfo>([
      [
        "/components/ui/Button/Button.tsx",
        file({ units: new Map([["Button", unit()]]) }),
      ],
      [
        "/components/ui-v2/Button/Button.tsx",
        file({ units: new Map([["Button", unit()]]) }),
      ],
      ["/Typography.tsx", file({ units: new Map([["Typography", unit()]]) })],
    ]);
    const dn = computeDisplayNames(cache, "/");
    expect(dn.get("/components/ui/Button/Button.tsx::Button")).toBe(
      "ui/Button",
    );
    expect(dn.get("/components/ui-v2/Button/Button.tsx::Button")).toBe(
      "ui-v2/Button",
    );
    expect(dn.get("/Typography.tsx::Typography")).toBe("Typography"); // unique → bare
  });

  it("wikiLinkFor is bare for unique names, path-qualified for collisions", () => {
    expect(
      wikiLinkFor(
        {
          name: "Typography",
          displayName: "Typography",
          file: "/x/Typography.tsx",
          colliding: false,
        },
        "/",
      ),
    ).toBe("[[Typography]]");
    expect(
      wikiLinkFor(
        {
          name: "Button",
          displayName: "ui/Button",
          file: "/components/ui/Button/Button.tsx",
          colliding: true,
        },
        "/",
      ),
    ).toBe("[[src/components/ui/Button/Button\\|ui/Button]]");
  });

  it("wikiLinkFor targets the UNIT-named page, not the source file basename", () => {
    // File `RechargeManagerV2.tsx` whose component is `RechargeManager`: the doc
    // page is `…/RechargeManager.md` (unit name), so the link must point there,
    // not at a nonexistent `RechargeManagerV2` page (which dangles in Obsidian).
    expect(
      wikiLinkFor(
        {
          name: "RechargeManager",
          displayName: "RechargePageV2/RechargeManager",
          file: "/components/pages/RechargePage/RechargePageV2/RechargeManagerV2.tsx",
          colliding: true,
        },
        "/",
      ),
    ).toBe(
      "[[src/components/pages/RechargePage/RechargePageV2/RechargeManager\\|RechargePageV2/RechargeManager]]",
    );
  });
});

describe("buildTree", () => {
  // Cache: Root --(manual)--> Mid, and Mid uses two same-named `Mgr` units that
  // live in different folders (v1/Mgr, v2/Mgr). This mirrors App --(manual)-->
  // RechargePage with its two lazy RechargeManager variants.
  const cache = new Map<string, FileInfo>([
    [
      "/Root.tsx",
      file({ units: new Map([["Root", unit([])]]), defaultExport: "Root" }),
    ],
    [
      "/Mid.tsx",
      file({
        units: new Map([["Mid", unit(["Mgr", "Mgr@@/v2/Mgr.tsx"])]]),
        imports: new Map([
          ["Mgr", { file: "/v1/Mgr.tsx", importedName: "default" }],
          [
            "Mgr@@/v2/Mgr.tsx",
            { file: "/v2/Mgr.tsx", importedName: "default" },
          ],
        ]),
        defaultExport: "Mid",
      }),
    ],
    [
      "/v1/Mgr.tsx",
      file({ units: new Map([["Mgr", unit([])]]), defaultExport: "Mgr" }),
    ],
    [
      "/v2/Mgr.tsx",
      file({ units: new Map([["Mgr", unit([])]]), defaultExport: "Mgr" }),
    ],
  ]);

  it("forwards display-name disambiguation into manual-link subtrees", async () => {
    const displayNames = computeDisplayNames(cache, "/");
    const manual = {
      edges: new Map([["Root", ["Mid"]]]),
      nameToFile: new Map([["Mid", "/Mid.tsx"]]),
    };
    const tree = await buildTree(
      "/Root.tsx",
      "Root",
      new Set(),
      cache,
      manual,
      displayNames,
    );
    // The two same-named units under the manually-linked Mid must NOT collapse —
    // they keep their path-qualified labels (regression: manual recursion used to
    // drop `displayNames`, so both fell back to the bare `Mgr` and merged).
    expect(Object.keys(tree.Mid).sort()).toEqual(["v1/Mgr", "v2/Mgr"]);
  });
});
