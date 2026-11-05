import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { detectProject } from "../dist/graphdoc/detect-project.js";
import { loadPathAliases } from "../dist/graphdoc/tsconfig-paths.js";
import { analyze, buildCache, ensureRootUnit } from "../dist/graphdoc/analyzer.js";
import { buildGraphData } from "../dist/graphdoc/graph-core.js";
import { collectSpecs, isSpecFile } from "../dist/graphdoc/spec-analyzer.js";
import { configureGraphdocWrites } from "../dist/graphdoc/write-guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "node-app");

async function graphFor(dir: string) {
  const d = detectProject(dir);
  const aliases = loadPathAliases(d.repoRoot);
  const cache = await buildCache(d.srcRoot, d.rootFile, aliases, {
    projectKind: d.kind,
  });
  ensureRootUnit(cache, d.rootFile, d.rootName);
  const { nodes, edges } = buildGraphData(cache, d.srcRoot);
  const has = (parent: string, child: string) =>
    edges.some((e) => e.parent === parent && e.child === child);
  return { d, cache, aliases, nodes, edges, has };
}

describe("plain JS/TS (non-React) projects", () => {
  it("detects a non-React project and maps package.json main back to source", () => {
    const d = detectProject(fixture);
    expect(d.kind).toBe("node");
    expect(d.framework).toBe("Express");
    expect(d.language).toBe("ts");
    // main: dist/index.js → src/index.ts
    expect(d.rootFile).toBe(join(fixture, "src", "index.ts"));
    expect(d.rootName).toBe("Index");
  });

  it("builds the root → dependencies graph from module-level wiring and references", async () => {
    const { has } = await graphFor(fixture);
    // Synthetic entry root: module-level `app` instance + `connectDb()` call.
    expect(has("Index", "app")).toBe(true);
    expect(has("Index", "connectDb")).toBe(true);
    // `app.use('/users', userRouter)` — reference, not a call.
    expect(has("app", "userRouter")).toBe(true);
    // `userRouter.get('/', requireAuth, getUsers)` at module level.
    expect(has("userRouter", "getUsers")).toBe(true);
    expect(has("userRouter", "createUser")).toBe(true);
    expect(has("userRouter", "requireAuth")).toBe(true);
    // Through a private instance (`const service = new UserService()`).
    expect(has("getUsers", "UserService")).toBe(true);
    expect(has("UserService", "db")).toBe(true);
  });

  it("understands CommonJS require / module.exports / exports.x", async () => {
    const { has } = await graphFor(fixture);
    expect(has("requireAuth", "verifyToken")).toBe(true);
  });

  it("promotes instances exported after the fact (module.exports = { x })", async () => {
    const dir = await mkdtemp(join(tmpdir(), "graphdoc-cjs-"));
    try {
      await mkdir(join(dir, "src"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "cjs", main: "src/index.js" }),
      );
      await writeFile(
        join(dir, "src", "index.js"),
        `const { logger } = require("./logger");\nlogger.info("up");\n`,
      );
      await writeFile(
        join(dir, "src", "logger.js"),
        `function log(m) { console.log(m); }\nconst logger = { info: (m) => log(m) };\nmodule.exports = { logger };\n`,
      );
      const { d, has } = await graphFor(dir);
      expect(d.framework).toBe("Node.js (JavaScript)");
      expect(has("Index", "logger")).toBe(true);
      expect(has("logger", "log")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps spec files out of the graph", async () => {
    const { cache } = await graphFor(fixture);
    expect([...cache.keys()].some(isSpecFile)).toBe(false);
  });

  it("maps spec files to the units they import, with test titles", async () => {
    const { d, cache, aliases } = await graphFor(fixture);
    const specs = await collectSpecs({
      repoRoot: d.repoRoot,
      docsDir: d.docsDir,
      cache,
      aliases,
    });
    const byName = (n: string) => specs.find((s) => s.file.endsWith(n))!;
    expect(specs).toHaveLength(2);
    expect(byName("userService.spec.ts").targets.map((t) => t.name)).toEqual([
      "UserService",
    ]);
    expect(byName("userService.spec.ts").tests).toEqual([
      "UserService › lists users",
      "UserService › create › returns the created user",
    ]);
    expect(byName("userController.test.ts").targets.map((t) => t.name)).toEqual(
      ["getUsers"],
    );
  });

  it("includeSpecs emits Tested by sections + Tests.md, and removes Tests.md when off", async () => {
    const d = detectProject(fixture);
    const docsDir = await mkdtemp(join(tmpdir(), "graphdoc-node-"));
    configureGraphdocWrites({ root: docsDir, graphdocDir: docsDir });
    try {
      const opts = {
        srcRoot: d.srcRoot,
        rootFile: d.rootFile,
        rootName: d.rootName,
        docsDir,
        repoRoot: d.repoRoot,
        framework: d.framework,
        language: d.language,
        projectKind: d.kind,
      };
      const res = await analyze(fixture, { ...opts, includeSpecs: true });
      expect(res.specs).toMatchObject({ files: 2, tests: 3 });

      const page = (await readFile(
        join(docsDir, "src", "services", "UserService.md"),
        "utf8",
      )).replace(/\\/g, "/");
      expect(page).toContain("testedBy:\n  - test/userService.spec.ts");
      expect(page).toContain("## Tested by");
      expect(page).toContain(
        "  - UserService › create › returns the created user",
      );

      const tests = (await readFile(join(docsDir, "Tests.md"), "utf8")).replace(/\\/g, "/");
      expect(tests).toContain("## Untested units");
      expect(tests).toContain("[[createUser]]"); // no spec imports it
      expect(tests).toContain("### test/userService.spec.ts");

      // Specs appear in every tree/graph, connected to the units they import.
      expect(res.treeText).toMatch(/UserService\n.*db\n.*🧪 userService\.spec/);
      const tree = await readFile(join(docsDir, "Tree.md"), "utf8");
      expect(tree).toContain("🧪 userController.test");
      const graph = await readFile(join(docsDir, "Graph.md"), "utf8");
      expect(graph).toContain('spec_userService_spec["🧪 userService.spec"]');
      expect(graph).toContain("spec_userService_spec -.-> UserService");
      const specPage = await readFile(
        join(docsDir, "specs", "test", "userService.spec.md"),
        "utf8",
      );
      expect(specPage).toContain("- [[UserService]]");
      expect(page).toContain("🧪 [[userService.spec]]");

      const off = await analyze(fixture, { ...opts, includeSpecs: false });
      expect(off.specs).toBeUndefined();
      expect(existsSync(join(docsDir, "Tests.md"))).toBe(false);
      expect(existsSync(join(docsDir, "specs"))).toBe(false);
      expect(await readFile(join(docsDir, "Graph.md"), "utf8")).not.toContain(
        "🧪",
      );
      const pageOff = await readFile(
        join(docsDir, "src", "services", "UserService.md"),
        "utf8",
      );
      expect(pageOff).not.toContain("## Tested by");
    } finally {
      await rm(docsDir, { recursive: true, force: true });
    }
  });

  it("counts extends/implements as edges and reads Playwright test.describe suites", async () => {
    const dir = await mkdtemp(join(tmpdir(), "graphdoc-pom-"));
    try {
      await mkdir(join(dir, "src", "pages"), { recursive: true });
      await mkdir(join(dir, "tests"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "pom" }),
      );
      await writeFile(join(dir, "tsconfig.json"), "{}");
      await writeFile(
        join(dir, "src", "pages", "BasePage.ts"),
        `export interface Navigable { goto(): void }\nexport class BasePage { goto() {} }\n`,
      );
      await writeFile(
        join(dir, "src", "pages", "LoginPage.ts"),
        `import { BasePage } from "./BasePage";\nexport class LoginPage extends BasePage {}\n`,
      );
      await writeFile(
        join(dir, "tests", "login.spec.ts"),
        `import { test } from "@playwright/test";\nimport { LoginPage } from "../src/pages/LoginPage";\n` +
          `test.describe("Login", () => {\n  test.beforeEach(async () => {});\n` +
          `  test("signs in", async () => { await test.step("type", async () => {}); void LoginPage; });\n` +
          `  test.describe.serial("lockout", () => { test.only("locks after 3 tries", () => {}); });\n});\n`,
      );
      const d = detectProject(dir);
      const aliases = loadPathAliases(d.repoRoot);
      const files = [join(dir, "src", "pages", "LoginPage.ts")];
      const cache = await buildCache(d.srcRoot, files[0], aliases, {
        projectKind: d.kind,
      });
      const { edges } = buildGraphData(cache, d.srcRoot);
      expect(edges).toContainEqual({ parent: "LoginPage", child: "BasePage" });

      const [spec] = await collectSpecs({
        repoRoot: d.repoRoot,
        docsDir: d.docsDir,
        cache,
        aliases,
      });
      expect(spec.tests).toEqual([
        "Login › signs in",
        "Login › lockout › locks after 3 tries",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("roots a library barrel entry at its exports and resolves NodeNext .js specifiers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "graphdoc-lib-"));
    try {
      await mkdir(join(dir, "src"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "lib", exports: { ".": "./dist/index.js" } }),
      );
      await writeFile(join(dir, "tsconfig.json"), "{}");
      await writeFile(
        join(dir, "src", "index.ts"),
        `export * from "./math.js";\nexport { format } from "./format.js";\n`,
      );
      await writeFile(
        join(dir, "src", "math.ts"),
        `import { round } from "./format.js";\nexport function add(a: number, b: number) { return round(a + b); }\n`,
      );
      await writeFile(
        join(dir, "src", "format.ts"),
        `export function round(n: number) { return Math.round(n); }\nexport const format = (n: number) => String(round(n));\n`,
      );
      const { d, has } = await graphFor(dir);
      expect(d.framework).toBe("Node.js (TypeScript)");
      expect(has("Index", "add")).toBe(true);
      expect(has("Index", "format")).toBe(true);
      expect(has("add", "round")).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
