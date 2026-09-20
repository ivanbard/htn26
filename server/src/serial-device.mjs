import { spawnSync } from "node:child_process";
import { closeSync, createReadStream, fstatSync, openSync } from "node:fs";
import { createSerialStreamAdapter } from "./protocol.mjs";

/**
 * A POSIX tty can transmit input back to the device through its ECHO line
 * discipline even when the application opened the descriptor read-only. Put
 * real tty devices in raw/no-echo mode before consuming badge logs, and avoid
 * dropping DTR when the reader reconnects.
 */
export function configureSerialFd(fd, { platform = process.platform, fstat = fstatSync, run = spawnSync } = {}) {
  if (platform === "win32" || !fstat(fd).isCharacterDevice()) return false;
  const result = run("stty", ["raw", "-echo", "-hupcl", "clocal"], {
    encoding: "utf8",
    stdio: [fd, "ignore", "pipe"],
  });
  if (result.error) {
    throw new Error(`cannot configure serial device for safe receive-only access: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || "").trim();
    throw new Error(`cannot configure serial device for safe receive-only access${detail ? `: ${detail}` : ""}`);
  }
  return true;
}

/**
 * Laptop USB-serial boundary. The server consumes byte chunks from a configured
 * device path without coupling protocol parsing to a laptop OS. The same seam
 * can be replaced for a possible future deployment target.
 */
export function openSerialDevice(devicePath, { onRecord = () => {}, onError = () => {}, parser: suppliedParser, reconnectDelayMs = 250 } = {}) {
  if (!devicePath) throw new Error("a serial device path is required");
  const parser = suppliedParser || createSerialStreamAdapter({ onRecord });
  let stream = null;
  let closed = false;
  let retryTimer = null;
  const open = () => {
    if (closed) return;
    let fd;
    try {
      fd = openSync(devicePath, "r");
      configureSerialFd(fd);
      stream = createReadStream(devicePath, { fd, autoClose: true, encoding: null, highWaterMark: 1024 });
      fd = undefined;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      onError(error);
      scheduleReconnect();
      return;
    }
    stream.on("data", (chunk) => parser.push(chunk));
    stream.on("end", scheduleReconnect);
    stream.on("error", (error) => {
      onError(error);
      scheduleReconnect();
    });
  };
  const scheduleReconnect = () => {
    if (closed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      open();
    }, Math.max(0, Number(reconnectDelayMs) || 0));
    retryTimer.unref?.();
  };
  open();
  return {
    path: devicePath,
    get stream() { return stream; },
    parser,
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      stream?.destroy();
    },
  };
}
