// One simulation at a time. Ethan's simulate-*.mjs scripts and the UI dev hook that
// launches them all drive the same server, and two at once fight (one restarts the
// host while the other is mid-setup, which is how "approve" ended up with a 500).
// A tiny lock file in the temp dir tells them apart from a crashed run: it names a
// live process and expires after a few minutes.
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// HTN26_SIM_LOCK_FILE lets a test use its own lock without touching a real one.
export const SIM_LOCK_FILE = process.env.HTN26_SIM_LOCK_FILE || path.join(tmpdir(), "htn26-simulation.lock");
const STALE_AFTER_MS = 5 * 60_000;

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};

/** The current live holder, or null (no lock, a dead process, or an expired lock). */
export function readSimLock({ file = SIM_LOCK_FILE, now = Date.now() } = {}) {
  try {
    const lock = JSON.parse(readFileSync(file, "utf8"));
    if (Number.isInteger(lock.pid) && alive(lock.pid) && now - lock.at < STALE_AFTER_MS) return lock;
  } catch { /* no lock, or unreadable: treat as free */ }
  return null;
}

/**
 * Try to take the lock. `{ ok: true, release }` on success; `{ ok: false, holder }`
 * if a live simulation already has it. A script started by the dev hook (its
 * parent holds the lock for the whole photos-then-game sequence) is let through.
 */
export function acquireSimLock({ file = SIM_LOCK_FILE, pid = process.pid, parentPid = process.ppid, now = Date.now(), owner = "simulation" } = {}) {
  const held = readSimLock({ file, now });
  if (held && (held.pid === pid || held.pid === parentPid)) return { ok: true, release() {} };
  if (held) return { ok: false, holder: held };
  const data = JSON.stringify({ pid, at: now, owner });
  try {
    writeFileSync(file, data, { flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // A stale file (dead process or expired): replace it once.
    try { unlinkSync(file); } catch { /* raced with another cleaner */ }
    try { writeFileSync(file, data, { flag: "wx" }); } catch { return { ok: false, holder: readSimLock({ file, now }) || { pid: 0, at: now, owner: "unknown" } }; }
  }
  return {
    ok: true,
    release() {
      try { if (JSON.parse(readFileSync(file, "utf8")).pid === pid) unlinkSync(file); } catch { /* already gone */ }
    },
  };
}

export const describeHolder = (holder) => `pid ${holder.pid}${holder.owner ? `, ${holder.owner}` : ""}, started ${Math.max(0, Math.round((Date.now() - holder.at) / 1000))} s ago`;
