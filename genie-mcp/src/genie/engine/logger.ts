import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertWritable } from "../fsGuard.js";

let writeContext: { root: string; allowedDirectories: string[] } | undefined;

export function configureLoggerWrites(root: string, allowedDirectories: string[]): void {
  writeContext = { root: path.resolve(root), allowedDirectories };
}

async function safeWritePath(filePath: string): Promise<string> {
  if (!writeContext) throw new Error("Genie logger write guard has not been configured.");
  const target = await assertWritable(filePath, writeContext.allowedDirectories, writeContext.root);
  const parent = await assertWritable(path.dirname(target), writeContext.allowedDirectories, writeContext.root);
  await mkdir(parent, { recursive: true });
  return assertWritable(target, writeContext.allowedDirectories, writeContext.root);
}

export async function saveJSON(filePath: string, data: unknown): Promise<void> {
  const absPath = await safeWritePath(filePath);
  await writeFile(absPath, JSON.stringify(data, null, 2), "utf8");
  console.error(`Saved JSON: ${absPath}`);
}

export async function saveHTML(filePath: string, html: string): Promise<void> {
  const absPath = await safeWritePath(filePath);
  await writeFile(absPath, html, "utf8");
  console.error(`Saved HTML: ${absPath}`);
}