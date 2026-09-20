const DEFAULT_LONG_EDGE = 1280;
const DEFAULT_QUALITY = 0.76;

async function canvasToBlob(canvas, type, quality) {
  if (typeof canvas.convertToBlob === "function") return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("photo compression failed")), type, quality));
}

/** Prepare one phone image without blocking the others. createImageBitmap's
 * imageOrientation option lets browsers honor EXIF orientation before drawing. */
export async function preprocessRoomPhoto(file, { longEdge = DEFAULT_LONG_EDGE, quality = DEFAULT_QUALITY, type = "image/jpeg" } = {}) {
  if (!file || typeof file.arrayBuffer !== "function") throw new Error("a photo file is required");
  if (typeof OffscreenCanvas === "undefined" && typeof document === "undefined") return file;
  const source = typeof createImageBitmap === "function"
    ? await createImageBitmap(file, { imageOrientation: "from-image" })
    : await loadImage(file);
  const width = source.width || source.naturalWidth;
  const height = source.height || source.naturalHeight;
  const scale = Math.min(1, longEdge / Math.max(width, height));
  const canvas = typeof OffscreenCanvas !== "undefined"
    ? new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)))
    : Object.assign(document.createElement("canvas"), { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) });
  const context = canvas.getContext("2d");
  context.drawImage(source, 0, 0, canvas.width, canvas.height);
  source.close?.();
  return canvasToBlob(canvas, type, quality);
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("photo could not be decoded"));
    image.src = URL.createObjectURL(file);
  });
}

export async function preprocessRoomPhotos(files, options) {
  return Promise.all(Array.from(files || []).map((file) => preprocessRoomPhoto(file, options)));
}

export async function generateRoomLayout(fetchImpl = globalThis.fetch, files, { baseUrl = "" } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("room layout generation requires fetch");
  const started = globalThis.performance?.now?.() ?? Date.now();
  const prepared = await preprocessRoomPhotos(files);
  const preprocessMs = (globalThis.performance?.now?.() ?? Date.now()) - started;
  const body = new FormData();
  prepared.forEach((photo, index) => body.append("photos", photo, `room-${index + 1}.jpg`));
  const response = await fetchImpl(`${baseUrl}/api/layout/generate`, { method: "POST", body, headers: { accept: "application/json", "x-htn26-photo-preprocess-ms": String(preprocessMs) } });
  const payload = await response.json();
  if (!response.ok) throw new Error("Room layout generation is unavailable. Try again.");
  return payload;
}
