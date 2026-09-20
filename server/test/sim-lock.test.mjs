// One simulation at a time (server/sim-lock.mjs).
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireSimLock, readSimLock } from "../sim-lock.mjs";

async function withLockFile(callback) {
  const dir = await mkdtemp(path.join(tmpdir(), "htn26-lock-"));
  try { return await callback(path.join(dir, "sim.lock")); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("the first simulation gets the lock and a second one is refused until it is released", async () => {
  await withLockFile(async (file) => {
    const first = acquireSimLock({ file, pid: process.pid, parentPid: -1, owner: "hook" });
    assert.equal(first.ok, true);
    const second = acquireSimLock({ file, pid: 999_991, parentPid: -1, owner: "manual" });
    assert.equal(second.ok, false);
    assert.equal(second.holder.pid, process.pid);
    assert.equal(second.holder.owner, "hook");
    first.release();
    assert.equal(readSimLock({ file }), null);
    assert.equal(acquireSimLock({ file, pid: 999_991, parentPid: -1 }).ok, true, "free again after release");
  });
});

test("a script started by the lock holder (its parent) is let through and does not release the parent's lock", async () => {
  await withLockFile(async (file) => {
    acquireSimLock({ file, pid: process.pid, parentPid: -1 });
    const child = acquireSimLock({ file, pid: 999_992, parentPid: process.pid, owner: "simulate-game" });
    assert.equal(child.ok, true);
    child.release();
    assert.equal(readSimLock({ file })?.pid, process.pid, "the parent still holds it");
  });
});

test("a lock left by a crashed run (dead process) or an expired one does not block anyone", async () => {
  await withLockFile(async (file) => {
    await writeFile(file, JSON.stringify({ pid: 2_999_999, at: Date.now(), owner: "crashed" }));
    assert.equal(readSimLock({ file }), null, "dead process");
    assert.equal(acquireSimLock({ file, pid: process.pid, parentPid: -1 }).ok, true);
  });
  await withLockFile(async (file) => {
    await writeFile(file, JSON.stringify({ pid: process.pid, at: Date.now() - 10 * 60_000, owner: "old" }));
    assert.equal(readSimLock({ file }), null, "expired");
    assert.equal(acquireSimLock({ file, pid: 999_993, parentPid: -1 }).ok, true);
  });
});

test("a release only removes the lock its own process took", async () => {
  await withLockFile(async (file) => {
    const mine = acquireSimLock({ file, pid: process.pid, parentPid: -1 });
    await writeFile(file, JSON.stringify({ pid: process.ppid, at: Date.now(), owner: "someone else" }));
    mine.release();
    assert.equal(readSimLock({ file })?.owner, "someone else");
  });
});
