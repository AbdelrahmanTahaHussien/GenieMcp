/**
 * file-cache.ts — process-lifetime caches that make repeated tool calls cheap.
 *
 * The MCP server is long-lived, but every tool call used to re-read and
 * re-parse the whole reachable source graph from scratch (measured: ~200ms warm
 * and 6.5s+ cold per call on a 280-file app; 37s for a full crawl). Two caches
 * fix that:
 *
 *  1. Parsed-file cache: absolute path (+ analyze-options variant) → FileInfo,
 *     invalidated by mtime/size. A repeat call re-parses only files that
 *     actually changed.
 *  2. Import-resolution memo: candidate base path → resolved file (or null).
 *     `resolveFsLike` probes up to 12 `existsSync` candidates per import
 *     specifier — the dominant IO cost on slow filesystems (OneDrive). The memo
 *     is cleared whenever any cached file is observed changed/removed, so
 *     layout changes re-probe.
 *
 * Correctness note: cached FileInfo objects are shared across runs.
 * `resolveLazyEdges` mutates them (adds into `used`/`lazyUsed` Sets and
 * set-if-absent into `imports`), which is idempotent — verified by test.
 */

import { statSync } from "node:fs";
import type { FileInfo } from "./types.js";
import type { AnalyzeOptions } from "./react-analyzer.js";

type Entry = { mtimeMs: number; size: number; info: FileInfo };

const parsedFiles = new Map<string, Entry>();
const resolveMemo = new Map<string, string | null>();

function cacheKey(file: string, opts?: AnalyzeOptions): string {
  // styledComponents / projectKind change which units + edges are captured →
  // separate variants.
  return `${file}::${opts?.styledComponents ? 1 : 0}::${opts?.projectKind ?? "react"}`;
}

/** Return the cached FileInfo when the file is unchanged on disk, else null. */
export function getCachedFileInfo(file: string, opts?: AnalyzeOptions): FileInfo | null {
  const key = cacheKey(file, opts);
  const entry = parsedFiles.get(key);
  if (!entry) return null;
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(file);
  } catch {
    // File disappeared — drop it and re-probe import resolution.
    parsedFiles.delete(key);
    resolveMemo.clear();
    return null;
  }
  if (st.mtimeMs !== entry.mtimeMs || st.size !== entry.size) {
    parsedFiles.delete(key);
    resolveMemo.clear();
    return null;
  }
  return entry.info;
}

export function storeFileInfo(file: string, opts: AnalyzeOptions | undefined, info: FileInfo): void {
  try {
    const st = statSync(file);
    parsedFiles.set(cacheKey(file, opts), { mtimeMs: st.mtimeMs, size: st.size, info });
  } catch {
    /* unstatable → don't cache */
  }
}

/** Memoize an import-resolution probe (base path → resolved file or null). */
export function memoizedResolve(base: string, compute: () => string | null): string | null {
  const hit = resolveMemo.get(base);
  if (hit !== undefined || resolveMemo.has(base)) return hit ?? null;
  const result = compute();
  resolveMemo.set(base, result);
  return result;
}

/** Wipe both caches (tests, or explicit refresh). */
export function clearFileCache(): void {
  parsedFiles.clear();
  resolveMemo.clear();
}

export function fileCacheStats(): { parsedFiles: number; resolveMemo: number } {
  return { parsedFiles: parsedFiles.size, resolveMemo: resolveMemo.size };
}
