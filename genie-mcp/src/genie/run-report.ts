import type { z } from "zod";
import type { handoffSchemas } from "./handoff-schemas.js";

type RunReport = z.infer<(typeof handoffSchemas)["run-report"]>;
type RunHistory = z.infer<(typeof handoffSchemas)["run-history"]>;

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

function chart(
  items: Array<{ passed: number; failed: number; label: string; success?: boolean }>,
  attempts: boolean,
): string {
  if (items.length < 2) return "";
  const width = 900;
  const height = 160;
  const padX = 40;
  const padY = 18;
  const points = items.map((item, index) => {
    const pct = item.passed / Math.max(item.passed + item.failed, 1) * 100;
    return {
      ...item,
      pct,
      x: (padX + index * (width - padX * 2) / (items.length - 1)).toFixed(1),
      y: (padY + (100 - pct) / 100 * (height - padY * 2)).toFixed(1),
      color: attempts ? item.success ? "var(--green)" : "var(--red)" : "var(--blue)",
    };
  });
  const grid = [0, 50, 100].map((pct) => {
    const y = padY + (100 - pct) / 100 * (height - padY * 2);
    return `<line x1="${padX}" y1="${y.toFixed(1)}" x2="${width - padX}" y2="${y.toFixed(1)}" stroke="#1f2937" stroke-width="1" stroke-dasharray="4,4"/>
<text x="${padX - 4}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="var(--muted)" font-size="10">${pct}%</text>`;
  }).join("");
  return `
      <h2>${attempts ? "Self-Healing Progress (This Run)" : `Run Trend (Last ${items.length})`}</h2>
      <div class="trend-card">
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="160" role="img" aria-label="${attempts ? "Pass-rate progress across attempts" : "Pass-rate trend across recent runs"}">
          <line x1="${padX}" y1="${padY}" x2="${padX}" y2="${height - padY}" stroke="#334155" stroke-width="1"/>
          <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="#334155" stroke-width="1"/>
          ${grid}
          <polyline fill="none" stroke="var(--blue)" stroke-width="2.5"${attempts ? ' stroke-dasharray="6,3"' : ""} points="${points.map((point) => `${point.x},${point.y}`).join(" ")}"/>
          ${points.map((point) =>
            `${attempts ? `<text x="${point.x}" y="${(Number(point.y) - 9).toFixed(1)}" text-anchor="middle" fill="${point.color}" font-size="11" font-weight="600">${point.pct.toFixed(0)}%</text>` : ""}
<circle cx="${point.x}" cy="${point.y}" r="${attempts ? 5 : 4}" fill="${point.color}" stroke="var(--bg)" stroke-width="1.5"><title>${attempts ? `Attempt ${esc(point.label)}: ` : ""}${point.pct.toFixed(1)}% (${point.passed} passed, ${point.failed} failed)</title></circle>
<text x="${point.x}" y="${height - 3}" text-anchor="middle" fill="var(--muted)" font-size="${attempts ? 11 : 10}">${esc(point.label)}</text>`,
          ).join("")}
        </svg>
      </div>`;
}

export function renderRunReport(report: RunReport, history: RunHistory = []): string {
  const total = report.summary.passed + report.summary.failed;
  const failureList = (failures: RunReport["attempts"][number]["failures"]) =>
    failures.map((failure) =>
      `<li><span class="fix-type ${esc(failure.category)}">${esc(failure.category)}</span>` +
      `<span><strong>${esc(failure.testTitle)}</strong><br/><code style="font-size:.8rem;color:var(--muted)">${esc(failure.errorMessage)}</code></span></li>`,
    ).join("");
  const attemptRows = report.attempts.map((attempt) => {
    const count = attempt.passed + attempt.failed;
    const pct = count > 0 ? Math.round(attempt.passed / count * 100) : 0;
    const categories = Object.entries(attempt.categories)
      .filter(([, value]) => value > 0)
      .map(([name, value]) => `${esc(name)}=${value}`).join(", ");
    return `<tr>
        <td>${attempt.attempt}</td><td>${attempt.passed}</td><td>${attempt.failed}</td>
        <td>${(attempt.durationMs / 1000).toFixed(1)}s</td>
        <td><div class="bar-container">
          <div class="bar green" style="width:${count > 0 ? attempt.passed / count * 120 : 0}px"></div>
          <div class="bar red" style="width:${count > 0 ? attempt.failed / count * 120 : 0}px"></div>
          <span style="color:var(--muted);font-size:.8rem">${pct}%</span>
        </div></td>
        <td>${categories || "—"}</td>
      </tr>`;
  }).join("\n");
  const attemptDetails = report.attempts.map((attempt) => {
    const fixes = attempt.fixesApplied.length
      ? `<p style="color:var(--muted);font-size:.8rem;margin:.5rem 0 .25rem">Fixes applied before this attempt:</p><ul class="fix-list">${attempt.fixesApplied.map((fix) =>
        `<li><span class="fix-type ${esc(fix.type)}">${esc(fix.type)}</span><span>${fix.file ? `<code style="font-size:.8rem">${esc(fix.file)}</code> — ` : ""}${esc(fix.description)}</span></li>`,
      ).join("")}</ul>`
      : "";
    return `<details class="attempt-detail" ${attempt.success ? "" : "open"}>
  <summary style="cursor:pointer;padding:.6rem 1rem;background:var(--card);border-radius:.5rem;display:flex;align-items:center;gap:.75rem;list-style:none">
    <span style="font-weight:700">Attempt ${attempt.attempt}</span>
    <span class="badge" style="background:${attempt.success ? "var(--green)" : "var(--red)"};color:${attempt.success ? "#000" : "#fff"}">${attempt.success ? "PASS" : "FAIL"}</span>
    <span style="color:var(--muted);font-size:.85rem">passed=${attempt.passed} failed=${attempt.failed} ${(attempt.durationMs / 1000).toFixed(1)}s</span>
  </summary>
  <div style="padding:.75rem 1rem 1rem;border:1px solid #334155;border-top:none;border-radius:0 0 .5rem .5rem;margin-bottom:.5rem">
    ${fixes}
    ${attempt.failures.length ? `<ul class="fix-list">${failureList(attempt.failures)}</ul>` : '<p style="color:var(--muted);font-size:.85rem">No failures.</p>'}
  </div>
</details>`;
  }).join("\n");
  const categoryRows = Object.entries(report.summary.categories)
    .map(([name, value]) => `<tr><td>${esc(name)}</td><td>${value}</td></tr>`).join("\n");
  const finalFailures = failureList(report.failures ?? []);
  const progress = chart(report.attempts.map((attempt) => ({
    ...attempt,
    label: `A${attempt.attempt}`,
  })), true);
  const trend = chart(history.slice(-10).map((run) => ({
    ...run,
    label: run.finishedAt.slice(5, 10),
  })), false);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Run Report — ${esc(report.spec)}</title>
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
    <h1>Run Report — ${esc(report.spec)}</h1>
    <span class="badge ${report.success ? "pass" : "fail"}">${report.success ? "ALL PASSED" : "FAILURES"}</span>
  </header>
  <div class="meta">
    <span>Spec: <strong>${esc(report.spec)}</strong></span>
    <span>Date: <strong>${esc(report.finishedAt.slice(0, 10))}</strong></span>
    <span>Attempts: <strong>${report.attempts.length}</strong></span>
  </div>
  ${progress}${trend}
  <div class="cards">
    <div class="card"><div class="num" style="color:var(--green)">${report.summary.passed}</div><div class="label">Passed</div></div>
    <div class="card"><div class="num" style="color:var(--red)">${report.summary.failed}</div><div class="label">Failed</div></div>
    <div class="card"><div class="num">${total}</div><div class="label">Total</div></div>
    <div class="card"><div class="num">${report.attempts.length}</div><div class="label">Attempts</div></div>
  </div>
  <h2>Attempt History</h2>
  <table>
    <thead><tr><th>#</th><th>Passed</th><th>Failed</th><th>Duration</th><th>Progress</th><th>Categories</th></tr></thead>
    <tbody>${attemptRows}</tbody>
  </table>
  <h2>Attempt Details</h2>
  <div style="margin-bottom:2rem">${attemptDetails}</div>
  ${categoryRows ? `<h2>Failure Categories</h2><table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>${categoryRows}</tbody></table>` : ""}
  ${finalFailures ? `<h2>Final Failures</h2><ul class="fix-list">${finalFailures}</ul>` : ""}
  <footer>Generated by QA Teammate Orchestrator</footer>
</div>
</body>
</html>`;
}
