import fs from "fs";
import path from "path";

export function saveJSON(filePath: string, data: unknown) {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(data, null, 2), "utf8");

  console.log(`Saved JSON: ${absPath}`);
}

export function saveHTML(filePath: string, html: string) {
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, html, "utf8");

  console.log(`Saved HTML: ${absPath}`);
}