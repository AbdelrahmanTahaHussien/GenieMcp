#!/usr/bin/env node
/**
 * scripts/auto-configure.js — OPT-IN editor MCP configurator.
 *
 * SECURITY NOTE: this used to run automatically on `npm install` (postinstall)
 * and silently rewrote GLOBAL editor configs (~/.cursor/mcp.json, Claude
 * Desktop, Windsurf) with a blind JSON merge and no backup. That is a
 * supply-chain hazard, so it is now:
 *   - never run on install (no postinstall hook),
 *   - explicit only: `npx graphdoc-mcp --setup` (or `npm run setup`),
 *   - project-scoped by default (.mcp.json + .vscode/mcp.json in cwd),
 *   - global configs touched ONLY with `--global`,
 *   - always backs up an existing file before writing,
 *   - never clobbers a file whose existing contents aren't valid JSON.
 *
 * Exposes `runSetup({ global, cwd, stamp })` so the compiled server can invoke
 * the same logic when started with `--setup`.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";

const PKG_NAME = "graphdoc-mcp";

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(here, "..", "dist", "index.js");
// "node" (from PATH), NOT process.execPath: execPath bakes the CURRENT user's
// absolute node binary (e.g. ~/.nvm/versions/node/vX/bin/node) into a config
// that may be committed and shared — it breaks on every other machine.
const serverEntry = { command: "node", args: [SERVER_ENTRY] };

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return { ok: true, data: {} };
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (e) {
    return { ok: false, data: null, error: e };
  }
}

function backup(filePath, stamp) {
  if (!fs.existsSync(filePath)) return null;
  const bak = `${filePath}.bak.${stamp}`;
  fs.copyFileSync(filePath, bak);
  return bak;
}

/**
 * Merge the server entry into one config file. Returns a result record and
 * never throws — a single bad target should not abort the rest.
 */
function patchConfig(filePath, rootKey, serverValue, stamp) {
  const existing = readJsonSafe(filePath);
  if (!existing.ok) {
    return {
      file: filePath,
      status: "skipped",
      reason: "existing file is not valid JSON — left untouched",
    };
  }
  const config = existing.data ?? {};
  config[rootKey] = config[rootKey] ?? {};
  config[rootKey][PKG_NAME] = serverValue;

  const bak = backup(filePath, stamp);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n");
  return { file: filePath, status: "configured", backup: bak };
}

function claudeDesktopConfigPath() {
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "Claude",
      "claude_desktop_config.json",
    );
  if (process.platform === "win32")
    return path.join(
      process.env.APPDATA ?? os.homedir(),
      "Claude",
      "claude_desktop_config.json",
    );
  return path.join(
    os.homedir(),
    ".config",
    "Claude",
    "claude_desktop_config.json",
  );
}

/**
 * @param {{ global?: boolean, cwd?: string, stamp?: string }} opts
 * @returns {{ configured: object[], skipped: object[] }}
 */
export function runSetup(opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  const stamp = opts.stamp ?? `${Date.now()}`;
  const results = [];

  // ── project-scoped (safe defaults, written into the current project) ───────
  results.push(
    patchConfig(path.join(cwd, ".mcp.json"), "mcpServers", serverEntry, stamp),
  ); // Claude Code
  results.push(
    patchConfig(
      path.join(cwd, ".vscode", "mcp.json"),
      "servers",
      { type: "stdio", ...serverEntry },
      stamp,
    ),
  ); // VS Code

  // ── global (opt-in only; touch a global file only if its dir already exists)─
  if (opts.global) {
    const cursorDir = path.join(os.homedir(), ".cursor");
    if (fs.existsSync(cursorDir))
      results.push(
        patchConfig(
          path.join(cursorDir, "mcp.json"),
          "mcpServers",
          serverEntry,
          stamp,
        ),
      );

    const windsurfDir = path.join(os.homedir(), ".codeium", "windsurf");
    if (fs.existsSync(windsurfDir))
      results.push(
        patchConfig(
          path.join(windsurfDir, "mcp_config.json"),
          "mcpServers",
          serverEntry,
          stamp,
        ),
      );

    const desktop = claudeDesktopConfigPath();
    if (fs.existsSync(desktop))
      results.push(patchConfig(desktop, "mcpServers", serverEntry, stamp));
  }

  const configured = results.filter((r) => r.status === "configured");
  const skipped = results.filter((r) => r.status !== "configured");

  console.log("\n🔧 graphdoc-mcp — editor setup");
  for (const r of configured)
    console.log(
      `   ✅ ${r.file}${r.backup ? `  (backup: ${path.basename(r.backup)})` : ""}`,
    );
  for (const r of skipped) console.log(`   ⏭  ${r.file} — ${r.reason}`);
  if (!opts.global)
    console.log(
      `\n   Project-scoped only. Re-run with --global to also configure Cursor / Windsurf / Claude Desktop.`,
    );
  console.log(`\n   Restart your editor to load the MCP server.\n`);

  return { configured, skipped };
}

// ── CLI entry (only when run directly, never on import) ───────────────────────
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      `graphdoc-mcp setup\n\n` +
        `  npx graphdoc-mcp --setup            configure this project (.mcp.json, .vscode/mcp.json)\n` +
        `  npx graphdoc-mcp --setup --global   also configure Cursor / Windsurf / Claude Desktop\n`,
    );
  } else {
    runSetup({ global: args.includes("--global") });
  }
}
