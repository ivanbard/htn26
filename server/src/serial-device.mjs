import { createReadStream } from "node:fs";
import { createSerialStreamAdapter } from "./protocol.mjs";

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
    stream = createReadStream(devicePath, { encoding: null, highWaterMark: 1024 });
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
