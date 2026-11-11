import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { handoffSchemas } from "../dist/genie/handoff-schemas.js";
import { renderRunReport } from "../dist/genie/run-report.js";

async function fixture() {
  const raw = await readFile(new URL("./fixtures/handoffs/run-report.json", import.meta.url), "utf8");
  return handoffSchemas["run-report"].parse(JSON.parse(raw));
}

describe("telemetry report", () => {
  it("preserves the original dashboard styling and sections", async () => {
    const report = await fixture();
    const html = renderRunReport(report);
    const original = await readFile(new URL("../../agents/handoff/run-report.html", import.meta.url), "utf8");
    const style = (value: string) => value.match(/<style>([\s\S]*?)<\/style>/)?.[1].trim();
    expect(style(html)).toBeTruthy();
    expect(style(html)).toBe(style(original));
    for (const section of [
      "Self-Healing Progress (This Run)",
      "Attempt History",
      "Attempt Details",
      "Fixes applied before this attempt:",
      "Scoped siteName locator",
      'aria-label="Pass-rate progress across attempts"',
      'class="cards"',
      'class="attempt-detail" open',
      "87%",
      "100%",
      "22.3s",
      "23.3s",
    ]) expect(html).toContain(section);
    expect(html.indexOf("Attempt 1</span>")).toBeLessThan(html.indexOf("Attempt 2</span>"));
  });

  it("is deterministic and does not change the supplied report or history", async () => {
    const report = await fixture();
    const history = [{
      finishedAt: report.finishedAt,
      spec: report.spec,
      passed: 15,
      failed: 0,
      attempts: 2,
      success: true,
    }];
    const before = JSON.stringify({ report, history });
    expect(renderRunReport(report, history)).toBe(renderRunReport(report, history));
    expect(JSON.stringify({ report, history })).toBe(before);
  });

  it("uses only the last ten supplied history entries for the run trend", async () => {
    const report = await fixture();
    const history = Array.from({ length: 12 }, (_, index) => ({
      finishedAt: `2026-06-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      spec: report.spec,
      passed: index,
      failed: 12 - index,
      attempts: 1,
      success: false,
    }));
    const html = renderRunReport(report, history);
    expect(html).toContain("Run Trend (Last 10)");
    expect(html).toContain(">06-03</text>");
    expect(html).toContain(">06-12</text>");
    expect(html).not.toContain(">06-01</text>");
    expect(html).not.toContain(">06-02</text>");
  });

  it("omits charts without enough data instead of inventing points", async () => {
    const report = await fixture();
    report.attempts = report.attempts.slice(0, 1);
    const html = renderRunReport(report);
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("Run Trend");
    expect(html).not.toContain("Final Failures");
    expect(html).toContain('class="badge pass">ALL PASSED');
  });

  it("renders final failures and categories and escapes all user text", async () => {
    const report = await fixture();
    report.spec = '<script>alert("spec")</script>';
    report.success = false;
    report.summary.categories = { '<img src=x onerror="bad">': 2 };
    report.failures = [{
      testTitle: "<script>bad</script>",
      category: "assertion",
      errorMessage: '<img src=x onerror="bad">',
    }];
    report.attempts[1].fixesApplied = [{
      type: 'locator" onclick="bad',
      file: "<script>file</script>",
      description: "<script>description</script>",
    }];
    const html = renderRunReport(report);
    expect(html).toContain("Final Failures");
    expect(html).toContain("Failure Categories");
    expect(html).toContain('class="badge fail">FAILURES');
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;bad&quot;&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).not.toContain('" onclick="bad');
  });
});
