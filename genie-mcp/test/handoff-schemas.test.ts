import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { handoffNames, handoffSchemas } from "../dist/genie/handoff-schemas.js";

async function fixture(name: string): Promise<unknown> {
  const raw = await readFile(new URL(`./fixtures/handoffs/${name}.json`, import.meta.url), "utf8");
  return JSON.parse(raw);
}

describe("handoff schemas", () => {
  it.each(handoffNames)("accepts the real %s.json fixture", async (name) => {
    expect(handoffSchemas[name].safeParse(await fixture(name)).success).toBe(true);
  });

  it("requires the real plan core fields and preserves extras", async () => {
    const plan = await fixture("plan") as Record<string, unknown>;
    const parsed = handoffSchemas.plan.parse({ ...plan, customNote: "retained" });
    expect(parsed.customNote).toBe("retained");
    expect(handoffSchemas.plan.safeParse({ feature: "missing timestamp" }).success).toBe(false);
  });

  it("accepts optional schemaVersion without requiring it", async () => {
    const plan = await fixture("plan") as Record<string, unknown>;
    expect(handoffSchemas.plan.parse({ ...plan, schemaVersion: 1 }).schemaVersion).toBe(1);
  });

  it("requires the real run-report summary while allowing optional top-level failures", async () => {
    const report = await fixture("run-report") as Record<string, unknown>;
    const { summary: _summary, ...incomplete } = report;
    expect(handoffSchemas["run-report"].safeParse(incomplete).success).toBe(false);
    expect(handoffSchemas["run-report"].safeParse({ ...report, failures: [] }).success).toBe(true);
  });
});