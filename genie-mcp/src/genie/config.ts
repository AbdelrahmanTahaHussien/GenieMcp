import { z } from "zod";
import { readFile } from "node:fs/promises";
import path from "node:path";

const relativeDirectory = z.string().min(1).refine(
  (value) => !path.isAbsolute(value) && !path.win32.isAbsolute(value),
  "Directory paths must be relative to the workspace root.",
);

export const genieConfigSchema = z.object({
  testDir: relativeDirectory,
  handoffDir: relativeDirectory,
  graphdocDir: relativeDirectory.optional(),
  baseUrl: z.string().url().optional(),
  conventions: z.record(z.string()).optional().default({}),
}).passthrough();

export type GenieConfig = z.infer<typeof genieConfigSchema>;

export async function loadConfig(root: string): Promise<GenieConfig> {
  const raw = await readFile(path.join(root, "genie.config.json"), "utf8");
  const config = genieConfigSchema.parse(JSON.parse(raw));
  return { ...config, graphdocDir: config.graphdocDir ?? "docs" };
}

export function resolveConfigDirectory(root: string, value: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, value);
  const relative = path.relative(resolvedRoot, resolved);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Configured directory escapes workspace root: ${value}`);
  }
  return resolved;
}