import { mkdir as fsMkdir, rm as fsRm, writeFile as fsWriteFile } from "node:fs/promises";
import path from "node:path";
import { assertWritable } from "../genie/fsGuard.js";

type WriteContext = { root: string; graphdocDir: string };
let writeContext: WriteContext | undefined;

export function configureGraphdocWrites(context: WriteContext): void {
  writeContext = {
    root: path.resolve(context.root),
    graphdocDir: path.resolve(context.graphdocDir),
  };
}

async function guardedPath(target: string): Promise<string> {
  if (!writeContext) throw new Error("GraphDoc write guard has not been configured.");
  return assertWritable(target, [writeContext.graphdocDir], writeContext.root);
}

export async function graphdocWriteFile(
  target: string,
  data: string | NodeJS.ArrayBufferView,
  options?: Parameters<typeof fsWriteFile>[2],
): Promise<void> {
  await fsWriteFile(await guardedPath(target), data, options);
}

export async function graphdocMkdir(
  target: string,
  options?: Parameters<typeof fsMkdir>[1],
): Promise<string | undefined> {
  return fsMkdir(await guardedPath(target), options);
}

export async function graphdocRm(
  target: string,
  options?: Parameters<typeof fsRm>[1],
): Promise<void> {
  await fsRm(await guardedPath(target), options);
}

