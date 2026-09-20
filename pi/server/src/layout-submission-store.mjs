import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const MAX_PHOTO_BYTES = 12 * 1024 * 1024;

function extensionFor(mime, filename = "") {
  const fromName = path.extname(filename).toLowerCase().replace(/[^a-z0-9.]/g, "");
  if ([".jpg", ".jpeg", ".png", ".webp", ".heic"].includes(fromName)) return fromName;
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic" })[mime] || ".bin";
}

function finiteDuration(value) {
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
}

function timingMetrics(metrics = {}) {
  return {
    preprocessMs: finiteDuration(metrics.preprocessMs),
    requestMs: finiteDuration(metrics.requestMs),
    validationMs: finiteDuration(metrics.validationMs),
    totalMs: finiteDuration(metrics.totalMs),
  };
}

function publicSubmission(submission) {
  const { absolutePath, metadataPath, ...value } = submission;
  return structuredClone(value);
}

export class LayoutSubmissionStore {
  constructor({ directory, now = () => Date.now() } = {}) {
    this.directory = path.join(directory, "layout-submissions");
    this.now = now;
    this.submissions = [];
    this.sequence = 0;
  }

  async init() {
    await fs.mkdir(this.directory, { recursive: true });
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const absolutePath = path.join(this.directory, entry.name);
      const metadataPath = path.join(absolutePath, "metadata.json");
      try {
        const saved = JSON.parse(await fs.readFile(metadataPath, "utf8"));
        if (saved?.requestId === entry.name) this.submissions.push({ ...saved, absolutePath, metadataPath });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    this.submissions.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
    this.sequence = this.submissions.length;
  }

  async create(uploads, { preprocessMs } = {}) {
    if (!Array.isArray(uploads) || uploads.length < 3 || uploads.length > 5) {
      throw Object.assign(new Error("upload 3 to 5 room photos"), { statusCode: 400 });
    }
    for (const upload of uploads) {
      if (!Buffer.isBuffer(upload.bytes) || upload.bytes.length === 0) throw Object.assign(new Error("photo upload is empty"), { statusCode: 400 });
      if (upload.bytes.length > MAX_PHOTO_BYTES) throw Object.assign(new Error("each photo must be 12 MiB or smaller"), { statusCode: 413 });
    }

    const submittedAt = new Date(this.now()).toISOString();
    const timestamp = submittedAt.replace(/[-:.]/g, "");
    const requestId = `${timestamp}-${String(++this.sequence).padStart(4, "0")}-${randomUUID().slice(0, 8)}`;
    const folder = path.posix.join("layout-submissions", requestId);
    const absolutePath = path.join(this.directory, requestId);
    const metadataPath = path.join(absolutePath, "metadata.json");
    await fs.mkdir(absolutePath);

    const photos = [];
    for (const [index, upload] of uploads.entries()) {
      const id = `photo-${String(index + 1).padStart(2, "0")}`;
      const file = `${id}${extensionFor(upload.mime, upload.filename)}`;
      await fs.writeFile(path.join(absolutePath, file), upload.bytes, { flag: "wx" });
      photos.push({
        id,
        file,
        filename: path.basename(upload.filename || file),
        mime: upload.mime || "application/octet-stream",
        bytes: upload.bytes.length,
      });
    }

    const submission = {
      requestId,
      folder,
      status: "processing",
      submittedAt,
      completedAt: null,
      photoCount: photos.length,
      photos,
      metrics: timingMetrics({ preprocessMs }),
      failure: null,
      absolutePath,
      metadataPath,
    };
    this.submissions.push(submission);
    await this.persist(submission);
    return publicSubmission(submission);
  }

  async finish(requestId, { status, metrics } = {}) {
    const submission = this.submissions.find((value) => value.requestId === requestId);
    if (!submission) throw new Error("layout submission not found");
    submission.status = status === "success" ? "success" : "failure";
    submission.completedAt = new Date(this.now()).toISOString();
    submission.metrics = timingMetrics({ ...submission.metrics, ...metrics });
    submission.failure = submission.status === "failure" ? { code: "generation_unavailable" } : null;
    await this.persist(submission);
    return publicSubmission(submission);
  }

  list() {
    return this.submissions.map(publicSubmission);
  }

  async persist(submission) {
    await fs.writeFile(submission.metadataPath, JSON.stringify(publicSubmission(submission), null, 2));
  }
}
