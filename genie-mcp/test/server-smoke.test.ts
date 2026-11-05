import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

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
      const [tools, prompts, resources, resourceTemplates] = await Promise.all([
        client.listTools(),
        client.listPrompts(),
        client.listResources(),
        client.listResourceTemplates(),
      ]);
      const toolNames = tools.tools.map((tool) => tool.name);
      expect(toolNames).toHaveLength(22);
      for (const name of [
        "genie_get_config", "genie_analyze", "genie_read_handoff",
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

      const skill = await client.readResource({ uri: "skill://explorer" });
      expect(skill.contents[0]).toMatchObject({ uri: "skill://explorer" });
      expect((skill.contents[0] as { text: string }).text).toContain("# Explorer");

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
      expect(await readFile(path.join(workspace, "agents", "handoff", "run-report.html"), "utf8")).toContain("KAN-19.home.spec.ts");

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
      expect(tools.tools).toHaveLength(6);
      expect(tools.tools.every((tool) => tool.name.startsWith("genie_"))).toBe(true);
    } finally {
      await client.close();
      await transport.close();
    }
  });
});