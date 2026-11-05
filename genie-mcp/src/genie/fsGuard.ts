import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function canonicalizeNearestExisting(candidate: string): Promise<string> {
  let existing = path.resolve(candidate);
  while (true) {
    try {
      await lstat(existing);
      const actual = await realpath(existing);
      const suffix = path.relative(existing, path.resolve(candidate));
      return path.resolve(actual, suffix);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
    }
  }
}

export async function assertWritable(
  target: string,
  allowedDirectories: string[],
  root: string,
): Promise<string> {
  const absoluteTarget = path.resolve(root, target);
  const absoluteRoots = allowedDirectories.map((directory) =>
    path.resolve(root, directory),
  );
  const allowedRoot = absoluteRoots.find((directory) =>
    isWithin(directory, absoluteTarget),
  );
  if (!allowedRoot) {
    throw new Error(`fsGuard: write outside allowed folders: ${target}`);
  }

  const [canonicalRoot, canonicalTarget] = await Promise.all([
    canonicalizeNearestExisting(allowedRoot),
    canonicalizeNearestExisting(absoluteTarget),
  ]);
  if (!isWithin(canonicalRoot, canonicalTarget)) {
    throw new Error(`fsGuard: symlink escapes allowed folders: ${target}`);
  }
  return absoluteTarget;
}