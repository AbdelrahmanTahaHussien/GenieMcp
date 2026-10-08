import { spawn } from "child_process";

export interface CommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  combined: string;
  durationMs: number;
}

/**
 * Run a shell command with live-streamed stdout/stderr.
 * On Windows uses cmd.exe; otherwise /bin/sh. Both streams are echoed
 * to this process's stdio in real time and captured for inspection.
 */
export function runCommand(command: string, cwd = process.cwd()): Promise<CommandResult> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const shell = isWindows ? process.env.ComSpec || "cmd.exe" : "/bin/sh";
    const args = isWindows ? ["/d", "/s", "/c", command] : ["-c", command];

    const start = Date.now();
    const child = spawn(shell, args, { cwd, env: process.env, windowsHide: true });

    let stdout = "";
    let stderr = "";
    let combined = "";

    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stdout += text;
      combined += text;
      process.stdout.write(text);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      combined += text;
      process.stderr.write(text);
    });

    child.on("error", (err) => {
      const text = `\n[runCommand error] ${err.message}\n`;
      stderr += text;
      combined += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      resolve({
        success: code === 0,
        exitCode: code,
        stdout,
        stderr,
        combined,
        durationMs: Date.now() - start,
      });
    });
  });
}
