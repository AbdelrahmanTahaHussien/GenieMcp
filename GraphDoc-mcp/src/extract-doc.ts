type Comment = {
  type: "Line" | "Block";
  value: string;
  start: number;
  end: number;
};

/**
 * Tooling pragmas (coverage/linter/compiler directives) are not documentation —
 * they just happen to sit immediately above a declaration. Skip them when
 * choosing a unit's leading comment so e.g. `/* istanbul ignore file *​/` never
 * becomes a unit's "description".
 */
const PRAGMA_RE =
  /^\s*(istanbul\s+ignore|c8\s+ignore|v8\s+ignore|eslint-disable|eslint-enable|prettier-ignore|@ts-(ignore|expect-error|nocheck)|tslint:|biome-ignore|@flow\b|@jsx\b|@license|@preserve|@vite-ignore|webpackChunkName)/i;

function isPragma(value: string): boolean {
  return PRAGMA_RE.test(value);
}

function clean(raw: string, isBlock: boolean): string {
  if (!isBlock) return raw.trim();
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trimEnd());
  while (lines.length && lines[0].trim() === "") lines.shift();
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join(" ").trim();
}

export function getLeadingComment(
  comments: Comment[],
  source: string,
  stmtStart: number,
): string | null {
  // Comments before the statement, closest last.
  const before = comments
    .filter((c) => c.end <= stmtStart)
    .sort((a, b) => a.end - b.end);

  // Walk upward from the statement: skip contiguous pragma comments, returning
  // the first real doc comment. A real comment above a pragma is still picked up
  // (the gap between it and the statement is only whitespace + pragmas).
  let boundary = stmtStart;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (!/^\s*$/.test(source.slice(c.end, boundary))) break; // not contiguous
    if (isPragma(c.value)) {
      boundary = c.start; // consume the pragma, keep looking above it
      continue;
    }
    const value = clean(c.value, c.type === "Block");
    return value || null;
  }
  return null;
}
