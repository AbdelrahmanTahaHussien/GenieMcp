#!/usr/bin/env node
// Combined AutoMateGenie + GraphDoc MCP server (skeleton).
// Usage: genie-mcp --root <workspaceFolder> [--modules graphdoc,genie]

import fs from "node:fs/promises";
import path from "node:path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
// import { registerGraphdocTools } from "./graphdoc/index.js"; // existing GraphDoc code, moved here

// ---------- args & config ----------
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const ROOT = path.resolve(arg("root", process.cwd())!);
const MODULES = (arg("modules", "graphdoc,genie") as string).split(",");

type GenieConfig = {
  testDir: string; // e.g. "tests"
  handoffDir: string; // e.g. "agents/handoff"
  baseUrl?: string;
  conventions?: Record<string, string>;
};

async function loadConfig(): Promise<GenieConfig> {
  const raw = await fs.readFile(path.join(ROOT, "genie.config.json"), "utf8");
  return JSON.parse(raw) as GenieConfig;
}

// ---------- fsGuard: writes only inside allowed dirs ----------
function assertWritable(target: string, allowed: string[]) {
  const abs = path.resolve(ROOT, target);
  const ok = allowed.some((d) => {
    const base = path.resolve(ROOT, d);
    return abs === base || abs.startsWith(base + path.sep);
  });
  if (!ok) throw new Error(`fsGuard: write outside allowed folders: ${target}`);
  return abs;
}

// ---------- handoff schemas (replace with the real ones) ----------
const HANDOFF = ["plan", "changeset", "run-history", "run-report"] as const;
const handoffSchemas: Record<(typeof HANDOFF)[number], z.ZodTypeAny> = {
  plan: z.object({}).passthrough(),
  changeset: z.object({}).passthrough(),
  "run-history": z.object({}).passthrough(),
  "run-report": z.object({}).passthrough(),
};

const text = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
});

async function main() {
  const cfg = await loadConfig();
  const server = new McpServer({ name: "genie-mcp", version: "0.1.0" });

  // ---------- GraphDoc module ----------
  if (MODULES.includes("graphdoc")) {
    // registerGraphdocTools(server, { root: ROOT, cfg });
  }

  // ---------- Genie module ----------
  if (MODULES.includes("genie")) {
    server.registerTool(
      "genie_get_config",
      { title: "Get genie config", description: "Return genie.config.json for this repo.", inputSchema: {} },
      async () => text(cfg),
    );

    server.registerTool(
      "genie_analyze",
      {
        title: "Analyze repo",
        description: "Run the engine analysis (from agents/engine/analyze.ts) and return findings.",
        inputSchema: { scope: z.array(z.string()).optional().describe("Paths to limit analysis to") },
      },
      async ({ scope }) => {
        // const result = await analyze({ root: ROOT, cfg, scope });
        return text({ todo: "wire analyze.ts here", scope });
      },
    );

    server.registerTool(
      "genie_read_handoff",
      {
        title: "Read handoff file",
        description: "Read plan, changeset, run-history or run-report.",
        inputSchema: { name: z.enum(HANDOFF) },
      },
      async ({ name }) => {
        const file = path.join(ROOT, cfg.handoffDir, `${name}.json`);
        return text(await fs.readFile(file, "utf8"));
      },
    );

    server.registerTool(
      "genie_write_handoff",
      {
        title: "Write handoff file",
        description: "Validate and write a handoff file inside the handoff folder.",
        inputSchema: { name: z.enum(HANDOFF), data: z.record(z.any()) },
      },
      async ({ name, data }) => {
        const parsed = handoffSchemas[name].parse(data);
        const file = assertWritable(path.join(cfg.handoffDir, `${name}.json`), [cfg.handoffDir]);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, JSON.stringify(parsed, null, 2));
        return text({ written: path.relative(ROOT, file) });
      },
    );

    server.registerTool(
      "genie_write_test_file",
      {
        title: "Write test file",
        description: "Write a generated test file; only allowed inside the configured test folder.",
        inputSchema: { relativePath: z.string(), content: z.string() },
      },
      async ({ relativePath, content }) => {
        const file = assertWritable(path.join(cfg.testDir, relativePath), [cfg.testDir]);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, content);
        return text({ written: path.relative(ROOT, file) });
      },
    );

    server.registerTool(
      "genie_run_report",
      {
        title: "Build run report",
        description: "Generate run-report.json/html from run-history.",
        inputSchema: { format: z.enum(["json", "html", "both"]).default("both") },
      },
      async ({ format }) => text({ todo: "wire report generator", format }),
    );

    // ---------- Prompts (slash commands in VS Code chat) ----------
    const promptsDir = path.join(import.meta.dirname, "..", "prompts");
    for (const name of ["orchestrator", "explorer", "generator", "executor"]) {
      server.registerPrompt(
        `genie_${name}`,
        {
          title: `Genie ${name}`,
          description: `AutoMateGenie ${name} instructions`,
          argsSchema: { task: z.string().optional() },
        },
        async ({ task }) => {
          const body = await fs.readFile(path.join(promptsDir, `${name}.md`), "utf8");
          return {
            messages: [
              { role: "user" as const, content: { type: "text" as const, text: task ? `${body}\n\nTask: ${task}` : body } },
            ],
          };
        },
      );
    }

    // ---------- Resources (skills + instructions) ----------
    const skillsDir = path.join(import.meta.dirname, "..", "skills");
    server.registerResource(
      "skills",
      new ResourceTemplate("skill://{name}", {
        list: async () => ({
          resources: (await fs.readdir(skillsDir)).map((f) => ({
            uri: `skill://${f.replace(/\.md$/, "")}`,
            name: f.replace(/\.md$/, ""),
          })),
        }),
      }),
      { title: "Genie skills", description: "executor, explorer, generator, import-graph, test-design" },
      async (uri, { name }) => ({
        contents: [{ uri: uri.href, text: await fs.readFile(path.join(skillsDir, `${name}.md`), "utf8") }],
      }),
    );
  }

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
