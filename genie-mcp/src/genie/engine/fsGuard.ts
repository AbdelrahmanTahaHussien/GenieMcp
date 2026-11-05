import path from "path";

export function isSafePath(filePath: string) {
  const normalized = path.normalize(filePath);

  return (
    normalized.startsWith("tests") ||
    normalized.startsWith("data")
  );
}

export function preventNewDataFile(filePath: string, exists: boolean) {
  if (filePath.startsWith("data") && !exists) {
    throw new Error("❌ Creating new translation files is NOT allowed.");
  }
}