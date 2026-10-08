/**
 * Parse Playwright `--reporter=line` output into structured failure records
 * and classify each by category so the orchestrator can choose retry vs. fix.
 */

export type FailureCategory =
  | "infrastructure"
  | "translation"
  | "assertion"
  | "locator"
  | "navigation"
  | "unknown";

export interface FailureRecord {
  index: number;
  testTitle: string;
  stepTitle?: string;
  errorMessage: string;
  category: FailureCategory;
  location?: { file: string; line: number };
  rawBlock: string;
}

export interface RunSummary {
  passed: number;
  failed: number;
  total?: number;
  failures: FailureRecord[];
  categories: Record<FailureCategory, number>;
  // True if ALL failures are infrastructure (safe to blind-retry)
  allInfrastructure: boolean;
}

const INFRA_PATTERNS: RegExp[] = [
  /OAuth2ClientCredentialsGrant/i,
  /apiRequestContext\.(post|get|put|delete):\s*Timeout/i,
  /getAccessToken/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i,
  /socket hang up/i,
  /net::ERR_/i,
  /503 Service Unavailable|502 Bad Gateway|504 Gateway/i,
];

const NAVIGATION_PATTERNS: RegExp[] = [
  /page\.goto:.*Timeout/i,
  /navigation to ".+" failed/i,
  /waiting for navigation/i,
];

const TRANSLATION_PATTERNS: RegExp[] = [
  /toHaveText[\s\S]*Expected string:[\s\S]*Received string:/i,
];

const LOCATOR_PATTERNS: RegExp[] = [
  /toBeVisible\(\)/i,
  /toBeHidden\(\)/i,
  /toBeEnabled\(\)/i,
  /toBeDisabled\(\)/i,
  /locator resolved to/i,
  /element\(s\) not found/i,
];

const ASSERTION_PATTERNS: RegExp[] = [
  /Error: expect\(/i,
  /AssertionError/i,
  /toEqual|toBe|toContain|toMatch/i,
];

function classify(block: string): FailureCategory {
  if (INFRA_PATTERNS.some((r) => r.test(block))) return "infrastructure";
  if (NAVIGATION_PATTERNS.some((r) => r.test(block))) return "navigation";
  if (TRANSLATION_PATTERNS.some((r) => r.test(block))) return "translation";
  if (LOCATOR_PATTERNS.some((r) => r.test(block))) return "locator";
  if (ASSERTION_PATTERNS.some((r) => r.test(block))) return "assertion";
  return "unknown";
}

/**
 * Strip ANSI color/control codes that Playwright's line reporter emits.
 */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Split the raw output into per-failure blocks based on the "N) " marker
 * Playwright's line reporter uses at the start of each failure section.
 */
function splitFailureBlocks(output: string): { header: string; body: string }[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  const blocks: { header: string; body: string }[] = [];
  let current: { header: string; body: string } | null = null;

  // Allow any leading whitespace before the "N)" marker.
  const headerRe = /^\s*(\d+)\)\s+(.+)$/;

  for (const line of lines) {
    const m = line.match(headerRe);
    // Heuristic: a header line must contain something that looks like a
    // Playwright test path (›) to avoid false positives like "1) Explore repo".
    if (m && line.includes("›")) {
      if (current) blocks.push(current);
      current = { header: m[2], body: line + "\n" };
    } else if (current) {
      // Stop when we hit the trailing summary section
      if (/^\s*\d+ (failed|passed|flaky|skipped)\s*$/.test(line)) {
        blocks.push(current);
        current = null;
      } else {
        current.body += line + "\n";
      }
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

function extractErrorMessage(body: string): string {
  // First "Error:" / "TimeoutError:" line, plus the immediate next non-empty line.
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^(Error|TimeoutError|AssertionError):/i.test(l)) {
      const next = (lines[i + 1] || "").trim();
      return next ? `${l} ${next}` : l;
    }
  }
  // Fallback: first non-empty line after the header
  for (const l of lines.slice(1)) {
    if (l.trim()) return l.trim();
  }
  return "";
}

function extractLocation(body: string): { file: string; line: number } | undefined {
  // Match either "at C:\path\file.ts:LINE" or "..\path\file.ts:LINE"
  const re = /(?:at\s+)?([A-Za-z]:\\[^\s:]+\.ts|\.\.[\\/][^\s:]+\.ts|tests[\\/][^\s:]+\.ts):(\d+)/;
  const m = body.match(re);
  if (m) return { file: m[1], line: parseInt(m[2], 10) };
  return undefined;
}

function extractStep(header: string): string | undefined {
  // Header is e.g. "[NL_Tests] › tests\... › suite › test › step name"
  const parts = header.split("›").map((s) => s.trim());
  if (parts.length >= 2) return parts[parts.length - 1];
  return undefined;
}

export function analyzeRun(output: string): RunSummary {
  const clean = stripAnsi(output);
  const blocks = splitFailureBlocks(clean);
  const failures: FailureRecord[] = blocks.map((b, i) => {
    const category = classify(b.body);
    return {
      index: i + 1,
      testTitle: b.header.replace(/\s+/g, " ").trim(),
      stepTitle: extractStep(b.header),
      errorMessage: extractErrorMessage(b.body),
      category,
      location: extractLocation(b.body),
      rawBlock: b.body.slice(0, 4000),
    };
  });

  // Summary counters from Playwright trailing lines
  const passedMatch = clean.match(/(\d+)\s+passed/);
  const failedMatch = clean.match(/(\d+)\s+failed/);
  const passed = passedMatch ? parseInt(passedMatch[1], 10) : 0;
  const failed = failedMatch ? parseInt(failedMatch[1], 10) : failures.length;

  const categories: Record<FailureCategory, number> = {
    infrastructure: 0,
    translation: 0,
    assertion: 0,
    locator: 0,
    navigation: 0,
    unknown: 0,
  };
  for (const f of failures) categories[f.category]++;

  const allInfrastructure =
    failures.length > 0 && failures.every((f) => f.category === "infrastructure" || f.category === "navigation");

  return {
    passed,
    failed,
    total: passed + failed || undefined,
    failures,
    categories,
    allInfrastructure,
  };
}
