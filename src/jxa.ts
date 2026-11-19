import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../jxa/mail.js");

export type Runner = (op: string, args: Record<string, unknown>) => Promise<unknown>;

/** Run one Mail operation through osascript. Args travel as argv JSON, never as source. */
export const runJxa: Runner = (op, args) =>
  new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("Apple Mail connector only runs on macOS."));
      return;
    }
    execFile(
      "osascript",
      ["-l", "JavaScript", SCRIPT, JSON.stringify({ op, args })],
      { timeout: Number(process.env.APPLE_MAIL_TIMEOUT_MS ?? 120_000), maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = String(stderr || err.message);
          if (/-1743|not authori[sz]ed/i.test(msg)) {
            reject(
              new Error(
                "macOS blocked access to Mail. Open System Settings → Privacy & Security → Automation and allow your Claude app (or terminal) to control Mail, then retry.",
              ),
            );
          } else reject(new Error(`osascript failed: ${msg.trim()}`));
          return;
        }
        let parsed: { ok: boolean; result?: unknown; error?: string };
        try {
          parsed = JSON.parse(stdout.trim());
        } catch {
          reject(new Error(`Unexpected osascript output: ${stdout.slice(0, 500)}`));
          return;
        }
        if (parsed.ok) resolve(parsed.result);
        else reject(new Error(parsed.error ?? "Unknown Mail error"));
      },
    );
  });
