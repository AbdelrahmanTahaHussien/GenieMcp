import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertWritable } from "../dist/genie/fsGuard.js";
import { configureLoggerWrites, saveJSON } from "../dist/genie/engine/logger.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "genie-guard-"));
  await Promise.all([
    mkdir(path.join(root, "tests")),
    mkdir(path.join(root, "tests-evil")),
    mkdir(path.join(root, "outside")),
  ]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("assertWritable", () => {
  it("allows a target contained by an allowed directory", async () => {
    const target = await assertWritable("tests/home.spec.ts", ["tests"], root);
    expect(target).toBe(path.join(root, "tests", "home.spec.ts"));
  });

  it("rejects parent traversal", async () => {
    await expect(
      assertWritable("tests/../outside/escape.ts", ["tests"], root),
    ).rejects.toThrow(/outside allowed folders/);
  });

  it("rejects absolute paths outside the allowed directory", async () => {
    await expect(
      assertWritable(path.join(root, "outside", "escape.ts"), ["tests"], root),
    ).rejects.toThrow(/outside allowed folders/);
  });

  it("rejects sibling-prefix directories", async () => {
    await expect(
      assertWritable("tests-evil/escape.ts", ["tests"], root),
    ).rejects.toThrow(/outside allowed folders/);
  });

  it("rejects a symlink whose target escapes the allowed directory", async () => {
    const link = path.join(root, "tests", "outside-link");
    await symlink(
      path.join(root, "outside"),
      link,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      assertWritable("tests/outside-link/escape.ts", ["tests"], root),
    ).rejects.toThrow(/symlink escapes/);
  });

  it("keeps Genie logger writes within configured test and handoff roots", async () => {
    configureLoggerWrites(root, ["tests", "agents/handoff"]);
    await saveJSON("tests/generated.json", { ok: true });
    expect(await readFile(path.join(root, "tests", "generated.json"), "utf8")).toContain('"ok": true');
    await expect(saveJSON("outside/blocked.json", {})).rejects.toThrow(/outside allowed folders/);
  });
});