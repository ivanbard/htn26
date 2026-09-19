import { createReadStream } from "node:fs";
import { createSerialStreamAdapter } from "./protocol.mjs";

/**
 * QNX/USB boundary. The server does not know whether the path is a QNX
 * /dev/ser* node or a Linux tty; it only consumes byte chunks from this
 * adapter. No serial package is required for the first slice.
 */
export function openSerialDevice(devicePath, { onRecord = () => {}, onError = () => {}, parser: suppliedParser } = {}) {
  if (!devicePath) throw new Error("a serial device path is required");
  const stream = createReadStream(devicePath, { encoding: null, highWaterMark: 1024 });
  const parser = suppliedParser || createSerialStreamAdapter({ onRecord });
  stream.on("data", (chunk) => parser.push(chunk));
  stream.on("end", () => parser.flush());
  stream.on("error", onError);
  return {
    path: devicePath,
    stream,
    parser,
    close() { stream.destroy(); },
  };
}
