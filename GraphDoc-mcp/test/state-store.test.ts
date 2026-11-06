import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readState,
  writeState,
  writeDocsEntry,
  writeDocsEntries,
  setManualUses,
  recordAnalyze,
  recordModule,
  relDocPathFor,
  isRealDoc,
  docsMapFromState,
  manualEdgesFromState,
  manualTreeFromState,
  nameIndexFromState,
  statePath,
} from "../dist/state-store.js";

let docsDir: string;

beforeEach(async () => {
  docsDir = await mkdtemp(join(tmpdir(), "graphdoc-state-"));
});
afterEach(async () => {
  await rm(docsDir, { recursive: true, force: true });
});

describe("state-store round-trip", () => {
  it("returns an empty state when the file does not exist", async () => {
    const s = await readState(docsDir);
    expect(s.units).toEqual({});
    expect(s.analyze).toEqual({
      rootFile: null,
      rootName: null,
      styledComponents: false,
      includeSpecs: false,
    });
  });

  it("writeDocsEntry persists docs and preserves existing manualUses", async () => {
    await setManualUses(docsDir, "App.md", ["RechargePage"], "src/App.tsx");
    await writeDocsEntry(docsDir, "App.md", {
      source: "src/App.tsx",
      docs: "The root.",
    });
    const s = await readState(docsDir);
    expect(s.units["App.md"]).toEqual({
      source: "src/App.tsx",
      docs: "The root.",
      manualUses: ["RechargePage"],
    });
  });

  it("writeDocsEntries batches many units in one write", async () => {
    await writeDocsEntries(docsDir, [
      { relDocPath: "a/B.md", source: "src/a/B.tsx", docs: "B" },
      { relDocPath: "C.md", source: "src/C.tsx", docs: "C" },
    ]);
    const s = await readState(docsDir);
    expect(Object.keys(s.units).sort()).toEqual(["C.md", "a/B.md"]);
  });

  it("setManualUses with an empty list prunes a links-only entry", async () => {
    await setManualUses(docsDir, "App.md", ["X"], "src/App.tsx");
    await setManualUses(docsDir, "App.md", []);
    const s = await readState(docsDir);
    expect(s.units["App.md"]).toBeUndefined();
  });

  it("setManualUses with empty list keeps an entry that still has docs", async () => {
    await writeDocsEntry(docsDir, "App.md", {
      source: "src/App.tsx",
      docs: "doc",
    });
    await setManualUses(docsDir, "App.md", ["X"]);
    await setManualUses(docsDir, "App.md", []);
    const s = await readState(docsDir);
    expect(s.units["App.md"]).toEqual({ source: "src/App.tsx", docs: "doc" });
  });

  it("writes sorted, stable JSON", async () => {
    await writeDocsEntries(docsDir, [
      { relDocPath: "z.md", source: "src/z.tsx", docs: "z" },
      { relDocPath: "a.md", source: "src/a.tsx", docs: "a" },
    ]);
    const raw = await readFile(statePath(docsDir), "utf8");
    expect(raw.indexOf('"a.md"')).toBeLessThan(raw.indexOf('"z.md"'));
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("recordAnalyze stores generate settings", async () => {
    await recordAnalyze(docsDir, {
      rootFile: "src/App.tsx",
      rootName: "App",
      styledComponents: true,
    });
    expect((await readState(docsDir)).analyze).toEqual({
      rootFile: "src/App.tsx",
      rootName: "App",
      styledComponents: true,
      includeSpecs: false,
    });
  });

  it("recordAnalyze persists the sourceRoot offset and round-trips it", async () => {
    await recordAnalyze(
      docsDir,
      { rootFile: "src/App.tsx", rootName: "App", styledComponents: false },
      "../../jawwy-webportal/react-app",
    );
    expect((await readState(docsDir)).sourceRoot).toBe(
      "../../jawwy-webportal/react-app",
    );
  });

  it("recordModule appends modules (with optional outDir) and dedups by unitName+file", async () => {
    await recordModule(docsDir, {
      unitName: "Payment",
      file: "src/.../Payment.tsx",
    });
    await recordModule(docsDir, {
      unitName: "RechargeManager",
      file: "src/.../RechargeManagerV2.tsx",
      outDir: "modules/RechargeManagerV2",
    });
    await recordModule(docsDir, {
      unitName: "Payment",
      file: "src/.../Payment.tsx",
      styledComponents: true,
    }); // update, not dup
    const mods = (await readState(docsDir)).modules;
    expect(mods).toHaveLength(2);
    expect(mods.find((m) => m.unitName === "Payment")?.styledComponents).toBe(
      true,
    );
    expect(mods.find((m) => m.unitName === "RechargeManager")?.outDir).toBe(
      "modules/RechargeManagerV2",
    );
  });

  it("throws on corrupt JSON rather than silently wiping it", async () => {
    await writeState(docsDir, {
      version: 1,
      analyze: { rootFile: null, rootName: null, styledComponents: false },
      modules: [],
      onboard: {},
      units: {},
    });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(statePath(docsDir), "{ not json");
    await expect(readState(docsDir)).rejects.toThrow(/not valid JSON/);
  });
});

describe("derived views for the regeneration read-path", () => {
  it("docsMapFromState skips placeholder bodies", () => {
    const state = {
      version: 1,
      analyze: { rootFile: null, rootName: null, styledComponents: false },
      units: {
        "Real.md": { source: "src/Real.tsx", docs: "Real description" },
        "Empty.md": {
          source: "src/Empty.tsx",
          docs: "> _Add a description here. ...",
        },
      },
    };
    const m = docsMapFromState(state as any);
    expect(m.get("Real.md")).toBe("Real description");
    expect(m.has("Empty.md")).toBe(false);
  });

  it("manualEdges / manualTree / nameIndex derive from units", () => {
    const state = {
      version: 1,
      analyze: { rootFile: null, rootName: null, styledComponents: false },
      units: {
        "App.md": {
          source: "src/App.tsx",
          docs: "x",
          manualUses: ["RechargePage", "CheckoutPageV2"],
        },
        "ui/Button.md": { source: "src/ui/Button/Button.tsx", docs: "y" },
      },
    };
    const { edges, ownByPath } = manualEdgesFromState(state as any);
    expect(edges).toContainEqual({ from: "App", to: "RechargePage" });
    expect(ownByPath.get("App.md")).toEqual(["RechargePage", "CheckoutPageV2"]);

    expect(manualTreeFromState(state as any).get("App")).toEqual([
      "RechargePage",
      "CheckoutPageV2",
    ]);

    const idx = nameIndexFromState(state as any, "/repo");
    expect(idx.get("Button")?.replace(/\\/g, "/")).toBe(
      "/repo/src/ui/Button/Button.tsx",
    );
  });
});

describe("helpers", () => {
  it("isRealDoc distinguishes real text from the placeholder", () => {
    expect(isRealDoc("hello")).toBe(true);
    expect(isRealDoc(undefined)).toBe(false);
    expect(isRealDoc("> _Add a description here. preserved._")).toBe(false);
  });

  it("relDocPathFor derives the doc-page key from a source file + unit name", () => {
    const rel = relDocPathFor(
      "/proj/docs",
      "/proj/src",
      "/proj/src/components/ui/Button/Button.tsx",
      "Button",
    );
    expect(rel.replace(/\\/g, "/")).toBe("components/ui/Button/Button.md");
  });
});
