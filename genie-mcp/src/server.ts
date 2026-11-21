#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerGraphdocTools } from "./graphdoc/index.js";
import { analyzeRun } from "./genie/engine/analyze.js";
import { loadConfig, resolveConfigDirectory } from "./genie/config.js";
import { assertWritable } from "./genie/fsGuard.js";
import { handoffNames, handoffSchemas, type HandoffName } from "./genie/handoff-schemas.js";
import { configureLoggerWrites } from "./genie/engine/logger.js";
import { renderRunReport } from "./genie/run-report.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const promptNames = ["orchestrator", "explorer", "generator", "executor"] as const;
const skillNames = ["executor", "explorer", "generator", "import-graph", "test-design"] as const;
const PLAYWRIGHT_CONFIG_FILES = [
  "playwright.config.ts",
  "playwright.config.mts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cts",
];

function argument(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  return process.argv[index + 1];
}

function selectedModules(value: string | undefined): Set<string> {
  const modules = new Set((value ?? "graphdoc,genie").split(",").map((item) => item.trim()).filter(Boolean));
  const invalid = [...modules].filter((item) => !["graphdoc", "genie"].includes(item));
  if (invalid.length) throw new Error(`Unknown module(s): ${invalid.join(", ")}`);
  return modules;
}

function text(value: unknown) {
  return {
    content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  };
}

function errorText(error: unknown) {
  return {
    content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
    isError: true,
  };
}

async function main(): Promise<void> {
  const root = path.resolve(argument("root", process.cwd())!);
  const modules = selectedModules(argument("modules"));
  const config = await loadConfig(root);
  const testDir = resolveConfigDirectory(root, config.testDir);
  const handoffDir = resolveConfigDirectory(root, config.handoffDir);
  const graphdocDir = resolveConfigDirectory(root, config.graphdocDir!);
  configureLoggerWrites(root, [testDir, handoffDir]);
  const server = new McpServer(
    { name: "genie-mcp", version: "0.1.0" },
    modules.has("genie")
      ? { instructions: "For any request to create, generate or update Playwright tests from test cases, call genie_orchestrator first and follow its result exactly. Use GraphDoc tools to find relevant code before reading files." }
      : {},
  );

  if (modules.has("graphdoc")) {
    registerGraphdocTools(server, { root, graphdocDir });
  }

  if (modules.has("genie")) {
    const promptsDir = path.join(PACKAGE_ROOT, "prompts");
    const skillsDir = path.join(PACKAGE_ROOT, "skills");

    server.registerTool(
      "genie_get_instructions",
      {
        title: "Get Genie instructions",
        description: "Return named Genie instruction guidance.",
        inputSchema: { name: z.enum(["best-practices"]) },
      },
      async ({ name }) => text(await fs.readFile(path.join(skillsDir, `${name}.md`), "utf8")),
    );

    server.registerTool(
      "genie_orchestrator",
      {
        title: "Genie orchestrator",
        description: "Call this FIRST for any request to create, generate or update Playwright tests from test cases (plain language or Gherkin). Returns the complete QA workflow (Explorer, Generator, Executor) with your inputs filled in. Follow the returned steps exactly.",
        inputSchema: {
          testCases: z.string().trim().min(1).describe("Test cases in plain language or Gherkin."),
          siteUrl: z.string().trim().min(1).optional().describe("Application URL; defaults to baseUrl in genie.config.json."),
          jiraTicket: z.string().trim().min(1).optional().describe("Optional Jira ticket for supporting context."),
        },
      },
      async ({ testCases, siteUrl, jiraTicket }) => {
        const effectiveSiteUrl = siteUrl ?? config.baseUrl;
        const [template, ...guidance] = await Promise.all([
          fs.readFile(path.join(promptsDir, "orchestrator.md"), "utf8"),
          ...skillNames.map((name) => fs.readFile(path.join(skillsDir, `${name}.md`), "utf8")),
        ]);
        const workspaceEntries = await fs.readdir(root);
        const playwrightGuidance = workspaceEntries.some((entry) => PLAYWRIGHT_CONFIG_FILES.includes(entry))
          ? await fs.readFile(path.join(skillsDir, "best-practices.md"), "utf8")
          : undefined;
        return text([
          "WORKFLOW STARTED. Follow every stage in order. Run GraphDoc first. Ask for clarification instead of guessing missing details.",
          template,
          `## Supplied inputs\n${JSON.stringify({ testCases, siteUrl: effectiveSiteUrl, ...(jiraTicket ? { jiraTicket } : {}) }, null, 2)}`,
          ...(!effectiveSiteUrl
            ? ["No site URL was supplied. Use the existing project configuration if applicable, and ask for clarification if a URL is needed and cannot be determined."]
            : []),
          ...(playwrightGuidance ? ["## Playwright best-practice instructions", playwrightGuidance] : []),
          "## Stage guidance\nThe following guidance is included for clients that cannot read MCP resources.",
          ...guidance,
        ].join("\n\n"));
      },
    );

    server.registerTool(
      "genie_get_config",
      { title: "Get Genie config", description: "Return genie.config.json for this workspace.", inputSchema: {} },
      async () => text(config),
    );

    server.registerTool(
      "genie_analyze",
      {
        title: "Analyze Playwright output",
        description: "Classify failures in Playwright line-reporter output using the AutoMateGenie engine.",
        inputSchema: {
          output: z.string().describe("Captured Playwright --reporter=line output."),
          scope: z.array(z.string()).optional().describe("Optional repository paths associated with the run."),
        },
      },
      async ({ output, scope }) => text({ ...analyzeRun(output), scope: scope ?? [] }),
    );

    server.registerTool(
      "genie_read_handoff",
      {
        title: "Read handoff",
        description: "Return raw handoff content and any schema validation warnings.",
        inputSchema: { name: z.enum(handoffNames as [HandoffName, ...HandoffName[]]) },
      },
      async ({ name }) => {
        const file = path.join(handoffDir, `${name}.json`);
        try {
          const raw = await fs.readFile(file, "utf8");
          let data: unknown;
          try {
            data = JSON.parse(raw);
          } catch (error) {
            return text({ name, raw, validationWarnings: [`Invalid JSON: ${String(error)}`] });
          }
          const validation = handoffSchemas[name].safeParse(data);
          return text({
            name,
            raw,
            validationWarnings: validation.success ? [] : validation.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
          });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return text({ name, raw: null, validationWarnings: [`Handoff file not found: ${file}`] });
          }
          return errorText(error);
        }
      },
    );

    server.registerTool(
      "genie_write_handoff",
      {
        title: "Write handoff",
        description: "Validate and write one of the four handoff JSON files inside the configured handoff directory.",
        inputSchema: { name: z.enum(handoffNames as [HandoffName, ...HandoffName[]]), data: z.unknown() },
      },
      async ({ name, data }) => {
        const parsed = handoffSchemas[name].parse(data);
        const target = await assertWritable(path.join(handoffDir, `${name}.json`), [handoffDir], root);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await assertWritable(target, [handoffDir], root);
        await fs.writeFile(target, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
        return text({ written: path.relative(root, target) });
      },
    );

    server.registerTool(
      "genie_write_test_file",
      {
        title: "Write test file",
        description: "Write generated test content strictly inside the configured test directory.",
        inputSchema: { relativePath: z.string().min(1), content: z.string() },
      },
      async ({ relativePath, content }) => {
        if (path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
          throw new Error("Test file path must be relative to testDir.");
        }
        const target = await assertWritable(path.resolve(testDir, relativePath), [testDir], root);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await assertWritable(target, [testDir], root);
        await fs.writeFile(target, content, "utf8");
        return text({ written: path.relative(root, target) });
      },
    );

    server.registerTool(
      "genie_run_report",
      {
        title: "Render run report",
        description: "Render deterministic HTML from run-report.json; the JSON remains the source of truth.",
        inputSchema: { format: z.enum(["json", "html", "both"]).default("both") },
      },
      async ({ format }) => {
        const jsonPath = path.join(handoffDir, "run-report.json");
        const raw = await fs.readFile(jsonPath, "utf8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const validation = handoffSchemas["run-report"].safeParse(parsed);
        if (!validation.success) {
          throw new Error(`run-report.json is invalid: ${validation.error.issues.map((issue) => issue.message).join("; ")}`);
        }
        if (format !== "json") {
          let history: z.infer<(typeof handoffSchemas)["run-history"]> = [];
          try {
            const historyRaw = await fs.readFile(path.join(handoffDir, "run-history.json"), "utf8");
            history = handoffSchemas["run-history"].parse(JSON.parse(historyRaw));
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
              throw error;
            }
          }
          const html = renderRunReport(validation.data, history);
          const htmlPath = await assertWritable(path.join(handoffDir, "run-report.html"), [handoffDir], root);
          await fs.writeFile(htmlPath, html, "utf8");
        }
        if (format === "json") return text({ json: validation.data });
        if (format === "html") return text({ written: path.relative(root, path.join(handoffDir, "run-report.html")) });
        return text({ json: validation.data, htmlWritten: path.relative(root, path.join(handoffDir, "run-report.html")) });
      },
    );

    for (const name of promptNames) {
      server.registerPrompt(
        `genie_${name}`,
        {
          title: `Genie ${name}`,
          description: `AutoMateGenie ${name} workflow instructions.`,
          argsSchema: { task: z.string().optional() },
        },
        async ({ task }) => {
          const body = await fs.readFile(path.join(promptsDir, `${name}.md`), "utf8");
          return {
            messages: [{ role: "user" as const, content: { type: "text" as const, text: task ? `${body}\n\nTask: ${task}` : body } }],
          };
        },
      );
    }

    server.registerResource(
      "skills",
      new ResourceTemplate("skill://{name}", {
        list: async () => ({
          resources: skillNames.map((name) => ({ uri: `skill://${name}`, name })),
        }),
      }),
      { title: "Genie skills", description: "Explorer, test design, import graph, generator, and executor guidance." },
      async (uri, { name }) => {
        const skill = String(name);
        if (!skillNames.includes(skill as typeof skillNames[number])) throw new Error(`Unknown skill: ${skill}`);
        return { contents: [{ uri: uri.href, text: await fs.readFile(path.join(skillsDir, `${skill}.md`), "utf8") }] };
      },
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});