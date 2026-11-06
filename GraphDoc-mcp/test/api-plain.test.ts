import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { detectProject } from "../dist/detect-project.js";
import { analyze } from "../dist/analyzer.js";

/** Api.md for plain JS/TS projects: classes, objects, module functions. */
describe("Api.md for plain JS/TS projects", () => {
  it("renders classes with members, inheritance, objects and per-file function modules", async () => {
    const dir = await mkdtemp(join(tmpdir(), "graphdoc-api-"));
    const docsDir = join(dir, "docs");
    try {
      await mkdir(join(dir, "src"));
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({ name: "api", main: "src/index.ts" }),
      );
      await writeFile(join(dir, "tsconfig.json"), "{}");
      await writeFile(
        join(dir, "src", "base.ts"),
        `export abstract class Base {\n  protected abstract readonly path: string;\n  constructor(protected readonly page: Page) {}\n  static create(): Base | undefined { return undefined; }\n}\n`,
      );
      await writeFile(
        join(dir, "src", "repo.ts"),
        `export class Repo { find(id: string): Item | undefined { return undefined; } }\n`,
      );
      await writeFile(
        join(dir, "src", "login.ts"),
        `import { Base } from "./base";\nimport { Repo } from "./repo";\n` +
          `export class Login extends Base {\n  protected readonly path = "/login";\n  #secret = 1;\n` +
          `  constructor(page: Page, private readonly repo = new Repo()) { super(page); }\n` +
          `  async login(user: User, opts = {}, ...rest: string[]): Promise<Map<string, User>> { this.repo.find(user.id); return new Map(); }\n` +
          `  pick(kind: "a" | "b") {}\n}\n`,
      );
      await writeFile(
        join(dir, "src", "util.ts"),
        `export function slug(s: string): string { return s; }\nexport const twice = (n: number) => n * 2;\n` +
          `export const config = { url: "x", load() { return slug("a"); } };\n`,
      );
      await writeFile(
        join(dir, "src", "index.ts"),
        `import { Login } from "./login";\nimport { twice, config } from "./util";\nnew Login(null as any);\ntwice(config.load().length);\n`,
      );
      const d = detectProject(dir);
      await analyze(dir, { ...d, docsDir, projectKind: d.kind });
      const api = await readFile(join(docsDir, "Api.md"), "utf8");

      expect(api).toContain("# API");
      // Abstract class: abstract field, constructor-declared field, static method.
      expect(api).toContain("<<abstract>>");
      expect(api).toContain("#string path*");
      expect(api).toContain("#Page page");
      expect(api).toContain("+create()$ Base"); // `| undefined` dropped
      // Subclass: literal-typed field, private #field, ctor default → type,
      // optional/rest params, generics as ~T~, literal unions collapse to …
      expect(api).toContain("#string path");
      expect(api).toContain("-number secret");
      expect(api).toContain("-Repo repo");
      expect(api).toContain(
        "+login(user: User, opts?, ...rest: string[]) Promise~Map~string, User~~",
      );
      expect(api).toContain("+pick(kind: …)");
      expect(api).toContain("Base <|-- Login");
      expect(api).toContain("Login --> Repo");
      expect(api).not.toContain("Login --> Base"); // drawn as extends only
      // Object literal + functions grouped per file (label keeps the extension).
      expect(api).toMatch(
        /class config\["config"\] \{\n\s+<<object>>\n\s+\+url\n\s+\+load\(\)/,
      );
      expect(api).toMatch(
        /class mod_util_ts\["util\.ts"\] \{\n\s+<<module>>\n\s+\+slug\(s: string\) string\n\s+\+twice\(n: number\)/,
      );

      // Per-unit page shows signatures instead of "no props detected".
      const page = await readFile(join(docsDir, "src", "Login.md"), "utf8");
      expect(page).toContain("## API");
      expect(page).toContain("*extends `Base`*");
      expect(page).toContain(
        "- `login(user: User, opts?, ...rest: string[]): Promise<Map<string, User>>`",
      );
      expect(page).not.toContain("## Props");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
