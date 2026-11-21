import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { handoffSchemas } from "../dist/genie/handoff-schemas.js";

const serverPath = fileURLToPath(new URL("../dist/server.js", import.meta.url));
let workspace: string | undefined;

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
});

describe("genie-mcp stdio server", () => {
  it("lists tools, prompts, and skills and serves genie_get_config", async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "genie-smoke-"));
    await Promise.all([
      mkdir(path.join(workspace, "tests")),
      mkdir(path.join(workspace, "agents", "handoff"), { recursive: true }),
      mkdir(path.join(workspace, "docs")),
      mkdir(path.join(workspace, "src")),
    ]);
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "smoke-app", dependencies: { react: "18.0.0" } }),
    );
    await writeFile(
      path.join(workspace, "src", "App.jsx"),
      "export default function App() { return <main>Smoke</main>; }",
    );
    await writeFile(
      path.join(workspace, "genie.config.json"),
      JSON.stringify({ testDir: "tests", handoffDir: "agents/handoff", baseUrl: "http://localhost:5173" }),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--root", workspace],
      cwd: path.dirname(serverPath),
      stderr: "pipe",
    });
    const client = new Client({ name: "genie-mcp-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toBe(
        "For any request to create, generate or update Playwright tests from test cases, call genie_orchestrator first and follow its result exactly. Use GraphDoc tools to find relevant code before reading files.",
      );
      const [tools, prompts, resources, resourceTemplates] = await Promise.all([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
        client.listResourceTemplates(),
      ]);
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toHaveLength(24);
      for (const name of [
        "genie_orchestrator", "genie_get_config", "genie_get_instructions", "genie_analyze", "genie_read_handoff",
        "genie_write_handoff", "genie_write_test_file", "genie_run_report",
        "detect_project", "analyze_project", "onboard", "get_tree", "get_graph",
        "get_unit", "query_docs", "generate_graphdoc", "read_unit_source",
        "document_unit", "link_units", "unlink_units", "document_all_units",
        "generate_module_graphdoc", "sync", "export_doc_state",
      ]) expect(toolNames).toContain(name);
      expect(prompts.prompts.map((prompt) => prompt.name)).toEqual([
        "genie_orchestrator",
        "genie_explorer",
        "genie_generator",
        "genie_executor",
      ]);
      expect(resources.resources.map((resource) => resource.uri)).toContain("skill://explorer");
      expect(resourceTemplates.resourceTemplates.map((resource) => resource.uriTemplate)).toContain("skill://{name}");

      const orchestrator = await client.callTool({
        name: "genie_orchestrator",
        arguments: { testCases: "Given a customer\nWhen they sign in\nThen the account is shown" },
      });
      expect(orchestrator.isError).not.toBe(true);
      const workflow = (orchestrator as { content: Array<{ text: string }> }).content[0].text;
      const template = await readFile(new URL("../prompts/orchestrator.md", import.meta.url), "utf8");
      const bestPractices = await readFile(new URL("../skills/best-practices.md", import.meta.url), "utf8");
      expect(workflow.startsWith("WORKFLOW STARTED. Follow every stage in order. Run GraphDoc first. Ask for clarification instead of guessing missing details.")).toBe(true);
      expect(workflow).toContain(template);
      expect(workflow).not.toContain(bestPractices);
      expect(workflow).toContain('"testCases": "Given a customer\\nWhen they sign in\\nThen the account is shown"');
      expect(workflow).toContain('"siteUrl": "http://localhost:5173"');
      for (const name of ["explorer", "test-design", "import-graph", "generator", "executor"]) {
        expect(workflow).toContain(await readFile(new URL(`../skills/${name}.md`, import.meta.url), "utf8"));
      }

      const prompt = await client.getPrompt({ name: "genie_orchestrator", arguments: { task: "Check login" } });
      expect(prompt.messages[0].content).toMatchObject({ type: "text", text: `${template}\n\nTask: Check login` });

      const overridden = await client.callTool({
        name: "genie_orchestrator",
        arguments: { testCases: "Check login", siteUrl: "https://example.test", jiraTicket: "KAN-123" },
      });
      const overriddenText = (overridden as { content: Array<{ text: string }> }).content[0].text;
      expect(overridden.isError).not.toBe(true);
      expect(overriddenText).toContain('"siteUrl": "https://example.test"');
      expect(overriddenText).toContain('"jiraTicket": "KAN-123"');

      const skill = await client.readResource({ uri: "skill://explorer" });
      expect(skill.contents[0]).toMatchObject({ uri: "skill://explorer" });
      expect((skill.contents[0] as { text: string }).text).toContain("# Explorer");

      const instructions = await client.callTool({
        name: "genie_get_instructions",
        arguments: { name: "best-practices" },
      });
      expect((instructions as { content: Array<{ text: string }> }).content[0].text).toBe(bestPractices);

      await writeFile(path.join(workspace, "playwright.config.ts"), "export default {};");
      const playwrightOrchestrator = await client.callTool({
        name: "genie_orchestrator",
        arguments: { testCases: "Check login" },
      });
      expect(playwrightOrchestrator.isError).not.toBe(true);
      expect((playwrightOrchestrator as { content: Array<{ text: string }> }).content[0].text).toContain(bestPractices);

      const config = await client.callTool({ name: "genie_get_config", arguments: {} });
      const configContent = (config as { content: Array<{ text: string }> }).content;
      const response = JSON.parse(configContent[0].text);
      expect(response).toMatchObject({ testDir: "tests", handoffDir: "agents/handoff", graphdocDir: "docs" });

      const validPlan = { feature: "smoke", createdAt: new Date().toISOString() };
      const writePlan = await client.callTool({ name: "genie_write_handoff", arguments: { name: "plan", data: validPlan } });
      expect(writePlan.isError).not.toBe(true);
      const readPlan = await client.callTool({ name: "genie_read_handoff", arguments: { name: "plan" } });
      const readPlanContent = (readPlan as { content: Array<{ text: string }> }).content;
      const planResponse = JSON.parse(readPlanContent[0].text);
      expect(planResponse.validationWarnings).toEqual([]);

      const invalidWrite = await client.callTool({ name: "genie_write_handoff", arguments: { name: "plan", data: { feature: "missing timestamp" } } });
      expect(invalidWrite.isError).toBe(true);
      await writeFile(path.join(workspace, "agents", "handoff", "plan.json"), '{"feature":"invalid"}');
      const lenientRead = await client.callTool({ name: "genie_read_handoff", arguments: { name: "plan" } });
      const lenientContent = (lenientRead as { content: Array<{ text: string }> }).content;
      const lenientResponse = JSON.parse(lenientContent[0].text);
      expect(lenientResponse.raw).toContain('"feature"');
      expect(lenientResponse.validationWarnings.length).toBeGreaterThan(0);

      const testWrite = await client.callTool({
        name: "genie_write_test_file",
        arguments: { relativePath: "home.spec.ts", content: "test('smoke', () => {});" },
      });
      expect(testWrite.isError).not.toBe(true);
      expect(await readFile(path.join(workspace, "tests", "home.spec.ts"), "utf8")).toContain("smoke");
      const traversalWrite = await client.callTool({
        name: "genie_write_test_file",
        arguments: { relativePath: "../escape.spec.ts", content: "escape" },
      });
      expect(traversalWrite.isError).toBe(true);

      const report = await readFile(new URL("./fixtures/handoffs/run-report.json", import.meta.url), "utf8");
      await writeFile(path.join(workspace, "agents", "handoff", "run-report.json"), report);
      const rendered = await client.callTool({ name: "genie_run_report", arguments: { format: "both" } });
      expect(rendered.isError).not.toBe(true);
      const reportPath = path.join(workspace, "agents", "handoff", "run-report.html");
      const telemetry = await readFile(reportPath, "utf8");
      expect(telemetry).toContain("KAN-19.home.spec.ts");
      expect(telemetry).toContain("Self-Healing Progress (This Run)");
      expect(telemetry).toContain('class="cards"');
      expect(telemetry).toContain("Scoped siteName locator");
      expect(telemetry).not.toContain("Run Trend");
      const history = await readFile(new URL("./fixtures/handoffs/run-history.json", import.meta.url), "utf8");
      const historyData = handoffSchemas["run-history"].parse(JSON.parse(history));
      await writeFile(path.join(workspace, "agents", "handoff", "run-history.json"), JSON.stringify([...historyData, ...historyData]));
      const htmlOnly = await client.callTool({ name: "genie_run_report", arguments: { format: "html" } });
      expect(htmlOnly.isError).not.toBe(true);
      expect(await readFile(reportPath, "utf8")).toContain("Run Trend (Last 2)");
      await writeFile(path.join(workspace, "agents", "handoff", "run-history.json"), "invalid json");
      const invalidHistory = await client.callTool({ name: "genie_run_report", arguments: { format: "html" } });
      expect(invalidHistory.isError).toBe(true);
      const jsonOnly = await client.callTool({ name: "genie_run_report", arguments: { format: "json" } });
      expect(jsonOnly.isError).not.toBe(true);
      expect(await readFile(path.join(workspace, "agents", "handoff", "run-report.json"), "utf8")).toBe(report);

      const outsideDocs = path.join(workspace, "outside-docs");
      await mkdir(outsideDocs);
      const blockedGraphdocWrite = await client.callTool({
        name: "analyze_project",
        arguments: { workDir: workspace, outDir: outsideDocs },
      });
      expect(blockedGraphdocWrite.isError).toBe(true);
      const generatedDocs = await client.callTool({ name: "analyze_project", arguments: { workDir: workspace } });
      expect(generatedDocs.isError).not.toBe(true);
      expect(await readFile(path.join(workspace, "docs", "Graph.md"), "utf8")).toContain("Component Dependency Graph");
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("starts with only the requested module enabled", async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "genie-modules-"));
    await mkdir(path.join(workspace, "tests"));
    await mkdir(path.join(workspace, "agents", "handoff"), { recursive: true });
    await writeFile(path.join(workspace, "genie.config.json"), JSON.stringify({ testDir: "tests", handoffDir: "agents/handoff" }));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--root", workspace, "--modules", "genie"],
      cwd: path.dirname(serverPath),
      stderr: "pipe",
    });
    const client = new Client({ name: "genie-module-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools).toHaveLength(8);
      expect(tools.tools.every((tool) => tool.name.startsWith("genie_"))).toBe(true);
      const missingUrl = await client.callTool({
        name: "genie_orchestrator",
        arguments: { testCases: "Check login" },
      });
      expect(missingUrl.isError).not.toBe(true);
      const noUrlWorkflow = (missingUrl as { content: Array<{ text: string }> }).content[0].text;
      expect(noUrlWorkflow).toContain('"testCases": "Check login"');
      expect(noUrlWorkflow).toContain("No site URL was supplied.");
      expect(noUrlWorkflow).toContain("ask for clarification if a URL is needed and cannot be determined");
      const withUrl = await client.callTool({
        name: "genie_orchestrator",
        arguments: { testCases: "Check login", siteUrl: "https://example.test" },
      });
      expect(withUrl.isError).not.toBe(true);
      const missingCases = await client.callTool({
        name: "genie_orchestrator",
        arguments: { siteUrl: "https://example.test" },
      });
      expect(missingCases.isError).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("detects a plain JS/TS Playwright POM repo and emits spec coverage through MCP", async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "genie-node-pom-"));
    const plainRoot = path.join(workspace, "plain-app");
    await Promise.all([
      mkdir(path.join(workspace, "tests")),
      mkdir(path.join(workspace, "agents", "handoff"), { recursive: true }),
      mkdir(path.join(workspace, "docs")),
      mkdir(path.join(plainRoot, "src", "pages"), { recursive: true }),
      mkdir(path.join(plainRoot, "tests"), { recursive: true }),
    ]);
    await writeFile(path.join(workspace, "genie.config.json"), JSON.stringify({ testDir: "tests", handoffDir: "agents/handoff", graphdocDir: "docs" }));
    await writeFile(path.join(plainRoot, "package.json"), JSON.stringify({ name: "plain-pom", main: "dist/index.js" }));
    await writeFile(path.join(plainRoot, "tsconfig.json"), "{}");
    await writeFile(path.join(plainRoot, "src", "index.ts"), 'import { LoginPage } from "./pages/LoginPage.js"; export { LoginPage };');
    await writeFile(path.join(plainRoot, "src", "pages", "LoginPage.ts"), "export class LoginPage { async goto() {} }");
    await writeFile(
      path.join(plainRoot, "tests", "login.spec.ts"),
      'import { test } from "@playwright/test"; import { LoginPage } from "../src/pages/LoginPage.js"; test.describe("Login", () => { test("opens", async () => { void LoginPage; }); });',
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--root", workspace],
      cwd: path.dirname(serverPath),
      stderr: "pipe",
    });
    const client = new Client({ name: "genie-node-pom-smoke", version: "0.0.0" });
    try {
      await client.connect(transport);
      const detection = await client.callTool({ name: "detect_project", arguments: { workDir: plainRoot } });
      const detectionText = (detection as { content: Array<{ text: string }> }).content[0].text;
      expect(detectionText).toContain("Node.js (TypeScript)");

      const analysis = await client.callTool({ name: "analyze_project", arguments: { workDir: plainRoot, includeSpecs: true } });
      expect(analysis.isError).not.toBe(true);
      const testsMarkdown = (await readFile(path.join(workspace, "docs", "Tests.md"), "utf8")).replace(/\\/g, "/");
      expect(testsMarkdown).toContain("login.spec.ts");
      const page = (await readFile(path.join(workspace, "docs", "src", "pages", "LoginPage.md"), "utf8")).replace(/\\/g, "/");
      expect(page).toContain("## Tested by");
      expect(page).toContain("LoginPage");
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it("automatically analyzes Playwright POM folders without GraphDoc overrides", async () => {
    workspace = await mkdtemp(path.join(tmpdir(), "genie-playwright-auto-roots-"));
    await Promise.all(
      ["pages", "apis", "fixtures", "data", "utils", "tests", "agents/handoff"].map((name) =>
        mkdir(path.join(workspace!, name), { recursive: true }),
      ),
    );
    await mkdir(path.join(workspace, "docs"));
    await writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        name: "playwright-pom",
        devDependencies: { "@playwright/test": "^1.0.0" },
      }),
    );
    await writeFile(path.join(workspace, "genie.config.json"), JSON.stringify({
      testDir: "tests",
      handoffDir: "agents/handoff",
    }));
    await writeFile(
      path.join(workspace, "pages", "LoginPage.ts"),
      "export class LoginPage { async open() {} }\n",
    );
    await writeFile(
      path.join(workspace, "apis", "login.ts"),
      "export function login() { return true; }\n",
    );
    await writeFile(
      path.join(workspace, "tests", "login.spec.ts"),
      'import { test } from "@playwright/test"; import { LoginPage } from "../pages/LoginPage"; test("opens", () => { void LoginPage; });\n',
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--root", workspace],
      cwd: path.dirname(serverPath),
      stderr: "pipe",
    });
    const client = new Client({ name: "genie-playwright-auto-roots", version: "0.0.0" });
    try {
      await client.connect(transport);
      const detection = await client.callTool({
        name: "detect_project",
        arguments: { workDir: workspace },
      });
      const detectionText = (detection as { content: Array<{ text: string }> }).content[0].text;
      expect(detectionText).toContain("roots     : pages, apis, fixtures, data, utils (auto-detected)");
      expect(detectionText).toContain("specs     : enabled by default");

      const analysis = await client.callTool({
        name: "analyze_project",
        arguments: { workDir: workspace },
      });
      expect(analysis.isError).not.toBe(true);
      expect(await readFile(path.join(workspace, "docs", "Tests.md"), "utf8")).toContain("login.spec.ts");
      expect(await readFile(path.join(workspace, "docs", "src", "pages", "LoginPage.md"), "utf8")).toContain("Tested by");
      const state = JSON.parse(await readFile(path.join(workspace, "docs", "graphdoc.json"), "utf8"));
      expect(state.analyze.roots).toEqual(["pages", "apis", "fixtures", "data", "utils"]);
      expect(state.analyze.includeSpecs).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  });
});