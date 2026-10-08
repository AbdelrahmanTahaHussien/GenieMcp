import * as readline from 'readline';
import fs from "fs";
import path from "path";
import { runCommand, CommandResult } from "../agents/engine/cli";
import { saveJSON, saveHTML } from "./engine/logger";
import { analyzeRun, RunSummary, FailureCategory } from "./engine/analyze";

interface CliArgs {
  action?: string;
  spec?: string;
  feature?: string;
  maxRetries?: number;
  lastFailed?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (const a of argv.slice(2)) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) continue;
    const [, k, v] = m;
    if (k === "last-failed") out.lastFailed = true;
    else if (k === "max-retries") out.maxRetries = parseInt(v || "3", 10);
    else (out as Record<string, string | undefined>)[k] = v ?? "true";
  }
  return out;
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((res) => rl.question(q, res));

const INFRA_BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 240_000];

async function explore(feature: string) {
  console.log(`\n🔍 Exploring repo for feature: ${feature}...`);
  console.log(`\n👉 Run in Copilot:\n@workspace agents/explorer.md\nFeature: ${feature}\n`);
  saveJSON("agents/handoff/plan.json", { feature, createdAt: new Date().toISOString() });
}

async function generate(feature: string) {
  console.log(`\n🧪 Run in Copilot:\n@workspace agents/generator.md\nUse plan.json to generate test for: ${feature}\n`);
  saveJSON("agents/handoff/changeset.json", { feature, createdAt: new Date().toISOString() });
}

function describeCategories(cats: Record<FailureCategory, number>): string {
  return Object.entries(cats)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(", ");
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

interface ExecuteOptions {
  spec: string;
  maxRetries?: number;
  lastFailed?: boolean;
}

interface AttemptRecord {
  attempt: number;
  success: boolean;
  durationMs: number;
  passed: number;
  failed: number;
  categories: Record<string, number>;
  failures: Array<{ testTitle: string; category: string; errorMessage: string }>;
  fixesApplied: Array<{ type: string; file?: string; description: string }>;
}

interface NormalizedHandoff {
  success: boolean;
  spec: string;
  finishedAt: string;
  attempts: AttemptRecord[];
  summary: { passed: number; failed: number; categories: Record<string, number> } | null;
  failures: Array<{ testTitle: string; category: string; errorMessage: string }>;
}

interface RunHistoryItem {
  finishedAt: string;
  spec: string;
  passed: number;
  failed: number;
  attempts: number;
  success: boolean;
}

function handoffPath(fileName: string): string {
  return path.join(process.cwd(), "agents", "handoff", fileName);
}

function normalizeHandoff(raw: Record<string, unknown>, fallbackSpec = "unknown.spec.ts"): NormalizedHandoff {
  const spec = typeof raw.spec === "string" ? raw.spec : fallbackSpec;
  const finishedAt = typeof raw.finishedAt === "string" ? raw.finishedAt : new Date().toISOString();

  if (Array.isArray(raw.attempts)) {
    const attempts = raw.attempts as AttemptRecord[];
    const summary =
      (raw.summary as { passed: number; failed: number; categories: Record<string, number> } | null) ?? null;
    const failures =
      (raw.failures as Array<{ testTitle: string; category: string; errorMessage: string }>) ?? [];
    const success = typeof raw.success === "boolean" ? raw.success : (summary?.failed ?? 0) === 0;
    return { success, spec, finishedAt, attempts, summary, failures };
  }

  // Back-compat for older/manual run-report.json shape.
  const finalResults =
    (raw.finalResults as { passed?: number; failed?: number; total?: number } | undefined) ?? {};
  const passed =
    typeof finalResults.passed === "number"
      ? finalResults.passed
      : typeof raw.passed === "number"
      ? raw.passed
      : 0;
  const failed =
    typeof finalResults.failed === "number"
      ? finalResults.failed
      : typeof raw.failed === "number"
      ? raw.failed
      : 0;
  const categories =
    (raw.failureCategories as Record<string, number> | undefined) ?? {
      infrastructure: 0,
      translation: 0,
      assertion: 0,
      locator: 0,
      navigation: 0,
      unknown: 0,
    };
  const success = typeof raw.passed === "boolean" ? raw.passed : failed === 0;
  const attemptsCount = typeof raw.attempts === "number" ? raw.attempts : 1;
  const attempts: AttemptRecord[] = [
    {
      attempt: attemptsCount,
      success,
      durationMs: 0,
      passed,
      failed,
      categories,
      failures: [],
      fixesApplied: [],
    },
  ];

  return {
    success,
    spec,
    finishedAt,
    attempts,
    summary: { passed, failed, categories },
    failures: [],
  };
}

function loadRunHistory(): RunHistoryItem[] {
  const file = handoffPath("run-history.json");
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed as RunHistoryItem[];
  } catch {
    return [];
  }
}

function updateRunHistory(h: NormalizedHandoff): RunHistoryItem[] {
  const history = loadRunHistory();
  const item: RunHistoryItem = {
    finishedAt: h.finishedAt,
    spec: h.spec,
    passed: h.summary?.passed ?? 0,
    failed: h.summary?.failed ?? 0,
    attempts: h.attempts.length,
    success: h.success,
  };

  const last = history[history.length - 1];
  const isDuplicate =
    !!last &&
    last.finishedAt === item.finishedAt &&
    last.spec === item.spec &&
    last.passed === item.passed &&
    last.failed === item.failed;

  const nextHistory = isDuplicate ? history : [...history, item].slice(-30);
  saveJSON("agents/handoff/run-history.json", nextHistory);
  return nextHistory;
}

function buildReportHTML(
  handoff: NormalizedHandoff,
  spec: string,
  runHistory: RunHistoryItem[]
): string {
  const h = handoff;

  const total = (h.summary?.passed ?? 0) + (h.summary?.failed ?? 0);
  const statusBadge = h.success
    ? '<span class="badge pass">ALL PASSED</span>'
    : '<span class="badge fail">FAILURES</span>';

  const attemptRows = h.attempts
    .map((a) => {
      const t = a.passed + a.failed;
      const pct = t > 0 ? Math.round((a.passed / t) * 100) : 0;
      const pBar = t > 0 ? `width:calc(${a.passed}/${t}*120px)` : "width:0";
      const fBar = t > 0 ? `width:calc(${a.failed}/${t}*120px)` : "width:0";
      const cats = Object.entries(a.categories)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}=${n}`)
        .join(", ");
      return `<tr>
        <td>${a.attempt}</td><td>${a.passed}</td><td>${a.failed}</td>
        <td>${(a.durationMs / 1000).toFixed(1)}s</td>
        <td><div class="bar-container">
          <div class="bar green" style="${pBar}"></div>
          <div class="bar red" style="${fBar}"></div>
          <span style="color:var(--muted);font-size:.8rem">${pct}%</span>
        </div></td>
        <td>${cats || "—"}</td>
      </tr>`;
    })
    .join("\n");

  // Per-attempt expandable detail blocks
  const attemptDetails = h.attempts
    .map((a) => {
      const statusColor = a.success ? "var(--green)" : "var(--red)";
      const statusLabel = a.success ? "PASS" : "FAIL";

      const failureItems =
        a.failures && a.failures.length > 0
          ? `<ul class="fix-list">` +
            a.failures
              .map(
                (f) =>
                  `<li><span class="fix-type ${f.category}">${esc(f.category)}</span>` +
                  `<span><strong>${esc(f.testTitle)}</strong><br/><code style="font-size:.8rem;color:var(--muted)">${esc(f.errorMessage).slice(0, 300)}</code></span></li>`
              )
              .join("") +
            `</ul>`
          : `<p style="color:var(--muted);font-size:.85rem">No failures.</p>`;

      const fixItems =
        a.fixesApplied && a.fixesApplied.length > 0
          ? `<p style="color:var(--muted);font-size:.8rem;margin:.5rem 0 .25rem">Fixes applied before this attempt:</p><ul class="fix-list">` +
            a.fixesApplied
              .map(
                (fx) =>
                  `<li><span class="fix-type ${fx.type}">${esc(fx.type)}</span>` +
                  `<span>${fx.file ? `<code style="font-size:.8rem">${esc(fx.file)}</code> — ` : ""}${esc(fx.description)}</span></li>`
              )
              .join("") +
            `</ul>`
          : "";

      return `<details class="attempt-detail" ${a.success ? "" : "open"}>
  <summary style="cursor:pointer;padding:.6rem 1rem;background:var(--card);border-radius:.5rem;display:flex;align-items:center;gap:.75rem;list-style:none">
    <span style="font-weight:700">Attempt ${a.attempt}</span>
    <span class="badge" style="background:${statusColor};color:${a.success ? "#000" : "#fff"}">${statusLabel}</span>
    <span style="color:var(--muted);font-size:.85rem">passed=${a.passed} failed=${a.failed} ${(a.durationMs / 1000).toFixed(1)}s</span>
  </summary>
  <div style="padding:.75rem 1rem 1rem;border:1px solid #334155;border-top:none;border-radius:0 0 .5rem .5rem;margin-bottom:.5rem">
    ${fixItems}
    ${failureItems}
  </div>
</details>`;
    })
    .join("\n");

  const catRows = h.summary
    ? Object.entries(h.summary.categories)
        .map(([k, n]) => `<tr><td>${k}</td><td>${n}</td></tr>`)
        .join("\n")
    : "";

  const failureItems = h.failures
    .map(
      (f) =>
        `<li><span class="fix-type ${f.category}">${f.category}</span>` +
        `<span><strong>${esc(f.testTitle)}</strong><br/>${esc(f.errorMessage).slice(0, 200)}</span></li>`
    )
    .join("\n");

  const trend = runHistory.slice(-10);
  const trendGraph = buildTrendGraph(trend, h.attempts);

  function buildAttemptProgressSvg(attempts: AttemptRecord[]): string {
    if (attempts.length < 2) return "";

    const width = 900;
    const height = 160;
    const padX = 40;
    const padY = 18;
    const graphW = width - padX * 2;
    const graphH = height - padY * 2;

    const points = attempts.map((a, i) => {
      const denom = Math.max(a.passed + a.failed, 1);
      const pct = (a.passed / denom) * 100;
      const x = attempts.length === 1 ? padX + graphW / 2 : padX + (i * graphW) / (attempts.length - 1);
      const y = padY + ((100 - pct) / 100) * graphH;
      const color = a.success ? "var(--green)" : "var(--red)";
      return { x, y, pct, color, label: `A${a.attempt}`, passed: a.passed, failed: a.failed };
    });

    const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

    // Y-axis gridlines at 0%, 50%, 100%
    const gridLines = [0, 50, 100]
      .map((pct) => {
        const y = padY + ((100 - pct) / 100) * graphH;
        return `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${y.toFixed(1)}" stroke="#1f2937" stroke-width="1" stroke-dasharray="4,4"/>
<text x="${(padX - 4).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10">${pct}%</text>`;
      })
      .join("");

    const circles = points
      .map(
        (p) =>
          `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="${p.color}" stroke="var(--bg)" stroke-width="1.5">` +
          `<title>Attempt ${p.label}: ${p.pct.toFixed(1)}% (${p.passed} passed, ${p.failed} failed)</title></circle>`
      )
      .join("");

    const labels = points
      .map(
        (p) =>
          `<text x="${p.x.toFixed(1)}" y="${(height - 3).toFixed(1)}" text-anchor="middle" fill="var(--muted)" font-size="11">${p.label}</text>`
      )
      .join("");

    const pctLabels = points
      .map(
        (p) =>
          `<text x="${p.x.toFixed(1)}" y="${(p.y - 9).toFixed(1)}" text-anchor="middle" fill="${p.color}" font-size="11" font-weight="600">${p.pct.toFixed(0)}%</text>`
      )
      .join("");

    return `
      <h2>Self-Healing Progress (This Run)</h2>
      <div class="trend-card">
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="160" role="img" aria-label="Pass-rate progress across attempts">
          <line x1="${padX}" y1="${padY}" x2="${padX}" y2="${height - padY}" stroke="#334155" stroke-width="1"/>
          <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="#334155" stroke-width="1"/>
          ${gridLines}
          <polyline fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-dasharray="6,3" points="${polyline}"/>
          ${pctLabels}
          ${circles}
          ${labels}
        </svg>
      </div>`;
  }

  function buildTrendGraph(items: RunHistoryItem[], currentAttempts: AttemptRecord[]): string {
    const attemptChart = buildAttemptProgressSvg(currentAttempts);

    if (items.length < 2) {
      // Cross-run trend is meaningless with 1 point; show only per-attempt chart
      return attemptChart;
    }

    const width = 900;
    const height = 160;
    const padX = 40;
    const padY = 18;
    const graphW = width - padX * 2;
    const graphH = height - padY * 2;

    const points = items.map((r, i) => {
      const denom = Math.max(r.passed + r.failed, 1);
      const pct = (r.passed / denom) * 100;
      const x = padX + (i * graphW) / (items.length - 1);
      const y = padY + ((100 - pct) / 100) * graphH;
      return { x, y, pct, label: r.finishedAt.slice(5, 10) };
    });

    const gridLines = [0, 50, 100]
      .map((pct) => {
        const y = padY + ((100 - pct) / 100) * graphH;
        return `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${y.toFixed(1)}" stroke="#1f2937" stroke-width="1" stroke-dasharray="4,4"/>
<text x="${(padX - 4).toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10">${pct}%</text>`;
      })
      .join("");

    const polyline = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const circles = points
      .map(
        (p) =>
          `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4" fill="var(--blue)" stroke="var(--bg)" stroke-width="1.5"><title>${p.pct.toFixed(1)}%</title></circle>`
      )
      .join("");
    const labels = points
      .map(
        (p) =>
          `<text x="${p.x.toFixed(1)}" y="${(height - 3).toFixed(1)}" text-anchor="middle" fill="var(--muted)" font-size="10">${p.label}</text>`
      )
      .join("");

    const crossRunChart = `
      <h2>Run Trend (Last ${items.length})</h2>
      <div class="trend-card">
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="160" role="img" aria-label="Pass-rate trend across recent runs">
          <line x1="${padX}" y1="${padY}" x2="${padX}" y2="${height - padY}" stroke="#334155" stroke-width="1"/>
          <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="#334155" stroke-width="1"/>
          ${gridLines}
          <polyline fill="none" stroke="var(--blue)" stroke-width="2.5" points="${polyline}"/>
          ${circles}
          ${labels}
        </svg>
      </div>`;

    return attemptChart + crossRunChart;
  }

  function esc(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Run Report — ${esc(spec)}</title>
  <style>
    :root{--green:#22c55e;--red:#ef4444;--amber:#f59e0b;--blue:#3b82f6;--bg:#0f172a;--card:#1e293b;--text:#e2e8f0;--muted:#94a3b8}
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);padding:2rem}
    .container{max-width:960px;margin:0 auto}
    header{display:flex;align-items:center;justify-content:space-between;margin-bottom:2rem}
    h1{font-size:1.5rem}
    .badge{display:inline-block;padding:.25rem .75rem;border-radius:999px;font-size:.8rem;font-weight:600}
    .badge.pass{background:var(--green);color:#000}.badge.fail{background:var(--red);color:#fff}
    .meta{color:var(--muted);font-size:.85rem;margin-bottom:2rem}.meta span{margin-right:1.5rem}
    .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2rem}
    .card{background:var(--card);border-radius:.75rem;padding:1.25rem;text-align:center}
    .card .num{font-size:2rem;font-weight:700}.card .label{color:var(--muted);font-size:.8rem;margin-top:.25rem}
    h2{font-size:1.15rem;margin-bottom:1rem;border-bottom:1px solid #334155;padding-bottom:.5rem}
    table{width:100%;border-collapse:collapse;margin-bottom:2rem}
    th,td{padding:.6rem .8rem;text-align:left;border-bottom:1px solid #334155;font-size:.9rem}
    th{color:var(--muted);font-weight:600;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}
    .bar-container{display:flex;align-items:center;gap:.5rem}
    .bar{height:8px;border-radius:4px}.bar.green{background:var(--green)}.bar.red{background:var(--red)}
    .fix-list{list-style:none;margin-bottom:2rem}
    .fix-list li{background:var(--card);border-radius:.5rem;padding:.8rem 1rem;margin-bottom:.5rem;display:flex;gap:.75rem;align-items:flex-start}
    .fix-type{display:inline-block;padding:.15rem .5rem;border-radius:4px;font-size:.75rem;font-weight:600;text-transform:uppercase;flex-shrink:0}
    .fix-type.locator{background:#7c3aed33;color:#a78bfa}.fix-type.assertion{background:#f59e0b33;color:#fbbf24}
    .fix-type.infrastructure{background:#3b82f633;color:#60a5fa}.fix-type.translation{background:#06b6d433;color:#22d3ee}
    .fix-type.navigation{background:#ec489933;color:#f472b6}.fix-type.unknown{background:#64748b33;color:#94a3b8}
    .trend-card{background:var(--card);border-radius:.75rem;padding:.75rem;margin-bottom:2rem;border:1px solid #334155}
    footer{color:var(--muted);font-size:.75rem;text-align:center;margin-top:3rem}
  </style>
</head>
<body>
<div class="container">
  <header>
    <h1>Run Report — ${esc(spec)}</h1>
    ${statusBadge}
  </header>
  <div class="meta">
    <span>Spec: <strong>${esc(spec)}</strong></span>
    <span>Date: <strong>${h.finishedAt?.slice(0, 10) ?? "—"}</strong></span>
    <span>Attempts: <strong>${h.attempts.length}</strong></span>
  </div>
  ${trendGraph}
  <div class="cards">
    <div class="card"><div class="num" style="color:var(--green)">${h.summary?.passed ?? 0}</div><div class="label">Passed</div></div>
    <div class="card"><div class="num" style="color:var(--red)">${h.summary?.failed ?? 0}</div><div class="label">Failed</div></div>
    <div class="card"><div class="num">${total}</div><div class="label">Total</div></div>
    <div class="card"><div class="num">${h.attempts.length}</div><div class="label">Attempts</div></div>
  </div>
  <h2>Attempt History</h2>
  <table>
    <thead><tr><th>#</th><th>Passed</th><th>Failed</th><th>Duration</th><th>Progress</th><th>Categories</th></tr></thead>
    <tbody>${attemptRows}</tbody>
  </table>
  <h2>Attempt Details</h2>
  <div style="margin-bottom:2rem">${attemptDetails}</div>
  ${catRows ? `<h2>Failure Categories</h2><table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${catRows}</tbody></table>` : ""}
  ${failureItems ? `<h2>Final Failures</h2><ul class="fix-list">${failureItems}</ul>` : ""}
  <footer>Generated by QA Teammate Orchestrator</footer>
</div>
</body>
</html>`;
}

async function execute({ spec, maxRetries = 3, lastFailed = false }: ExecuteOptions) {
  console.log(`\n▶️ Running ${spec}${lastFailed ? " (last-failed only)" : ""}`);

  let attempt = 0;
  let infraAttempts = 0;
  let lastResult: CommandResult | null = null;
  let lastSummary: RunSummary | null = null;
  const history: AttemptRecord[] = [];

  // Load any fixes that were applied before this invocation (written by fixer agent).
  function loadPendingFixes(): Array<{ type: string; file?: string; description: string }> {
    const fixFile = handoffPath("fixes.json");
    if (!fs.existsSync(fixFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(fixFile, "utf8")) as unknown;
      if (Array.isArray(parsed)) {
        fs.unlinkSync(fixFile); // consume once
        return parsed as Array<{ type: string; file?: string; description: string }>;
      }
    } catch { /* ignore */ }
    return [];
  }

  while (attempt < maxRetries) {
    attempt++;
    const fixesApplied = attempt > 1 ? loadPendingFixes() : [];

    // Always run only Chromium unless the spec overrides via an env var.
    const browserProject = process.env.PLAYWRIGHT_BROWSER_PROJECT || "chromium";
    const cmd =
      `npx playwright test ${spec} --project=${browserProject} --reporter=line` +
      (lastFailed && attempt > 1 ? " --last-failed" : "");

    console.log(`\n── Attempt ${attempt}/${maxRetries} ─────────────────────────────`);
    console.log(`$ ${cmd}\n`);

    lastResult = await runCommand(cmd);
    lastSummary = analyzeRun(lastResult.combined);

    history.push({
      attempt,
      success: lastResult.success,
      durationMs: lastResult.durationMs,
      categories: lastSummary.categories,
      failed: lastSummary.failed,
      passed: lastSummary.passed,
      failures: lastSummary.failures.map((f) => ({
        testTitle: f.testTitle,
        category: f.category,
        errorMessage: f.errorMessage,
      })),
      fixesApplied,
    });

    console.log(
      `\n📊 Attempt ${attempt} result: ${lastResult.success ? "PASS" : "FAIL"} ` +
        `(passed=${lastSummary.passed} failed=${lastSummary.failed}) ` +
        `categories: ${describeCategories(lastSummary.categories) || "n/a"} ` +
        `[${(lastResult.durationMs / 1000).toFixed(1)}s]`
    );

    if (lastResult.success) break;

    if (lastSummary.allInfrastructure) {
      infraAttempts++;
      const backoff = INFRA_BACKOFF_MS[Math.min(infraAttempts - 1, INFRA_BACKOFF_MS.length - 1)];
      console.log(
        `\n🌐 All failures look infrastructure/navigation related. ` +
          `Backing off ${(backoff / 1000) | 0}s before retry...`
      );
      await sleep(backoff);
      // For infra failures, retry the full set, not just last-failed.
      lastFailed = false;
      continue;
    }

    // Non-infra failures: write failures.json for the fixer agent, then continue
    // the retry loop up to maxRetries (do NOT stop early).
    if (attempt < maxRetries) {
      saveJSON("agents/handoff/failures.json", {
        spec,
        generatedAt: new Date().toISOString(),
        attempt,
        failures: lastSummary.failures,
      });
      console.log(
        `\n📝 Attempt ${attempt} failures written to agents/handoff/failures.json.`
      );
      console.log(
        `👉 Apply fixes for these failures (Copilot: @workspace agents/executor.md → Apply fixes from failures.json), ` +
          `then write applied fixes to agents/handoff/fixes.json, then the next attempt will run automatically.`
      );
      console.log(`\n── Continuing to attempt ${attempt + 1}/${maxRetries}... ─────────`);
    }
  }

  const handoff = {
    spec,
    finishedAt: new Date().toISOString(),
    success: lastResult?.success ?? false,
    exitCode: lastResult?.exitCode ?? null,
    attempts: history,
    summary: lastSummary
      ? {
          passed: lastSummary.passed,
          failed: lastSummary.failed,
          categories: lastSummary.categories,
          allInfrastructure: lastSummary.allInfrastructure,
        }
      : null,
    failures: lastSummary?.failures ?? [],
  };

  saveJSON("agents/handoff/run-report.json", handoff);
  const normalized = normalizeHandoff(handoff as Record<string, unknown>, spec);
  const runHistory = updateRunHistory(normalized);
  saveHTML("agents/handoff/run-report.html", buildReportHTML(normalized, spec, runHistory));

  if (!handoff.success && handoff.failures.length > 0) {
    saveJSON("agents/handoff/failures.json", {
      spec,
      generatedAt: new Date().toISOString(),
      attempt: history.length,
      failures: handoff.failures,
    });
    console.log(
      `\n📝 Wrote ${handoff.failures.length} structured failure(s) to ` +
        `agents/handoff/failures.json — max retries (${maxRetries}) reached.`
    );
    console.log(`\n👉 Next step in Copilot:`);
    console.log(`@workspace agents/executor.md`);
    console.log(`Apply fixes for failures listed in agents/handoff/failures.json`);
  } else if (handoff.success) {
    console.log(`\n✅ All tests passed on attempt ${history.length}.`);
  }
}

function ensureMandatoryRunReportHTML(): void {
  try {
    const reportFile = handoffPath("run-report.json");
    if (!fs.existsSync(reportFile)) return;

    const raw = JSON.parse(fs.readFileSync(reportFile, "utf8")) as Record<string, unknown>;
    const spec = typeof raw.spec === "string" ? raw.spec : "unknown.spec.ts";
    const normalized = normalizeHandoff(raw, spec);
    const runHistory = updateRunHistory(normalized);
    saveHTML("agents/handoff/run-report.html", buildReportHTML(normalized, spec, runHistory));
  } catch (err) {
    console.error("Failed to generate mandatory run-report.html:", err);
  }
}

async function interactiveMenu() {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    console.log(`\n── QA Teammate — Autonomous QA Orchestrator ──`);
    console.log(`1) Explore repo (analyze feature / requirement)`);
    console.log(`2) List tests`);
    console.log(`3) Generate test`);
    console.log(`4) Execute + self-heal`);
    console.log(`5) Full pipeline (explore → generate → execute)`);
    console.log(`6) Re-run last failed`);
    console.log(`0) Quit`);

    const action = (await ask("Choose action: ")).trim();

    if (action === "0" || action === "q") break;
    if (action === "1") {
      const feature = (await ask("Feature / Jira ticket / requirement: ")).trim();
      await explore(feature);
    } else if (action === "3") {
      const feature = (await ask("Feature / Jira ticket / requirement: ")).trim();
      await generate(feature);
    } else if (action === "4") {
      const spec = (await ask("Spec path: ")).trim();
      const retriesStr = (await ask("Max retries (default 3): ")).trim();
      const maxRetries = retriesStr ? parseInt(retriesStr, 10) : 3;
      await execute({ spec, maxRetries });
    } else if (action === "5") {
      const feature = (await ask("Feature / Jira ticket / requirement: ")).trim();
      await explore(feature);
      await generate(feature);
      const spec = (await ask("Spec path to execute (or press Enter to skip): ")).trim();
      if (spec) await execute({ spec });
    } else if (action === "6") {
      const spec = (await ask("Spec path: ")).trim();
      await execute({ spec, lastFailed: true });
    } else {
      console.log("Unknown action.");
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);

  // Non-interactive mode if --action is provided
  if (args.action) {
    const feature = args.feature || "unspecified";
    if (args.action === "explore") await explore(feature);
    else if (args.action === "generate") await generate(feature);
    else if (args.action === "execute") {
      if (!args.spec) {
        console.error("--spec is required for --action=execute");
        process.exitCode = 2;
      } else {
        await execute({
          spec: args.spec,
          maxRetries: args.maxRetries ?? 3,
          lastFailed: !!args.lastFailed,
        });
      }
    } else if (args.action === "pipeline") {
      if (!args.spec) {
        console.error("--spec is required for --action=pipeline");
        process.exitCode = 2;
      } else {
        await explore(feature);
        await generate(feature);
        await execute({ spec: args.spec });
      }
    } else {
      console.error(`Unknown --action=${args.action}`);
      process.exitCode = 2;
    }
    rl.close();
    return;
  }

  await interactiveMenu();
  rl.close();
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => {
    // Mandatory exit task: always regenerate run-report.html from latest run-report.json.
    ensureMandatoryRunReportHTML();
  });
