/**
 * extract-props.ts — pull a component's prop names straight from its TypeScript
 * `*Props` interface / type alias in source. This is the ground-truth source of
 * props, independent of any generated docs folder, so emitters and tools can
 * populate API views without depending on `**Props**` lists having been written
 * into per-unit pages first.
 */

import { readFile } from "node:fs/promises";
import { parseSync } from "oxc-parser";

/** Depth-first walk over an oxc AST, calling `fn` for every node with a type. */
export function walkAst(
  node: unknown,
  fn: (n: Record<string, unknown>) => void,
): void {
  if (!node || typeof node !== "object") return;
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string") fn(n);
  for (const k of Object.keys(n)) {
    const v = n[k];
    if (Array.isArray(v)) for (const x of v) walkAst(x, fn);
    else if (v && typeof v === "object") walkAst(v, fn);
  }
}

/**
 * Extract the prop names declared in `<unitName>Props` (or a bare `Props`)
 * interface/type-alias inside `file`. Returns [] if the file can't be read or
 * parsed, or has no matching props declaration.
 */
export async function extractPropsFromSource(
  file: string,
  unitName: string,
): Promise<string[]> {
  let source: string;
  try {
    source = await readFile(file, "utf8");
  } catch {
    return [];
  }

  let parsed: ReturnType<typeof parseSync>;
  try {
    parsed = parseSync(file, source);
  } catch {
    return [];
  }

  const props: string[] = [];
  const targetNames = new Set([`${unitName}Props`, "Props"]);

  walkAst(parsed.program, (n) => {
    let members: Record<string, unknown>[] | null = null;

    if (n.type === "TSInterfaceDeclaration") {
      const name = (n.id as Record<string, unknown>)?.name as string;
      if (targetNames.has(name)) {
        members =
          ((n.body as Record<string, unknown>)?.body as Record<
            string,
            unknown
          >[]) ?? [];
      }
    }

    if (n.type === "TSTypeAliasDeclaration") {
      const name = (n.id as Record<string, unknown>)?.name as string;
      if (targetNames.has(name)) {
        const ann = n.typeAnnotation as Record<string, unknown>;
        if (ann?.type === "TSTypeLiteral") {
          members = (ann.members as Record<string, unknown>[]) ?? [];
        }
      }
    }

    if (!members) return;
    for (const m of members) {
      if (m.type === "TSPropertySignature") {
        const key = m.key as Record<string, unknown>;
        if (key?.type === "Identifier") props.push(key.name as string);
      }
    }
  });

  return props;
}
