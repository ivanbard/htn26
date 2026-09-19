import { createReadStream } from "node:fs";
import { createSerialStreamAdapter } from "./protocol.mjs";

/**
 * QNX/USB boundary. The server does not know whether the path is a QNX
 * /dev/ser* node or a Linux tty; it only consumes byte chunks from this
 * adapter. No serial package is required for the first slice.
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
