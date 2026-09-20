import { execFileSync } from "node:child_process";

const LEVELS = new Set(["easy", "normal", "hectic"]);

export class DifficultyDirector {
  constructor({ command = process.env.HTN26_DIFFICULTY_INFER, timeout = 500 } = {}) {
    this.command = command || null;
    this.timeout = timeout;
  }

  infer(features) {
    if (!this.command) return { level: "normal", source: "fallback", detail: "QNX OpenCV director is not configured" };
    try {
      const args = [features.activeOrders, features.failureRate, features.busyStoves, features.elapsed].map((value) => String(Math.max(0, Math.min(1, Number(value) || 0))));
      const result = JSON.parse(execFileSync(this.command, args, { encoding: "utf8", timeout: this.timeout }).trim());
      if (!LEVELS.has(result.level)) throw new Error("invalid difficulty level");
      return { level: result.level, source: "qnx-opencv", latencyMs: Number(result.latencyMs) || 0, detail: "Local QNX OpenCV inference" };
    } catch (error) {
      return { level: "normal", source: "fallback", detail: `QNX OpenCV director unavailable: ${error.message}` };
    }
  }
}
