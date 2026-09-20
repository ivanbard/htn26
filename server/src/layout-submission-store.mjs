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
  if (value === null || value === undefined || value === "") return null;
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
      let submission;
      try {
        const saved = JSON.parse(await fs.readFile(metadataPath, "utf8"));
        if (saved?.requestId !== entry.name) throw new Error("layout submission identity mismatch");
        submission = { ...saved, absolutePath, metadataPath };
      } catch {
        submission = await this.recover(entry.name, absolutePath, metadataPath);
      }
      if (submission.status === "processing") {
        submission.status = "failure";
        submission.completedAt = new Date(this.now()).toISOString();
        submission.failure = { code: "generation_interrupted" };
        submission.metrics = timingMetrics(submission.metrics);
        await this.persist(submission);
      }
      this.submissions.push(submission);
    }
    this.submissions.sort((left, right) => String(left.submittedAt).localeCompare(String(right.submittedAt)));
    this.sequence = this.submissions.length;
  }

  async recover(requestId, absolutePath, metadataPath) {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    const photos = [];
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === "metadata.json" || entry.name.endsWith(".tmp")) continue;
      const stat = await fs.stat(path.join(absolutePath, entry.name));
      photos.push({
        id: path.basename(entry.name, path.extname(entry.name)),
        file: entry.name,
        filename: entry.name,
        mime: ({ ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".heic": "image/heic" })[path.extname(entry.name).toLowerCase()] || "application/octet-stream",
        bytes: stat.size,
      });
    }
    photos.sort((left, right) => left.file.localeCompare(right.file));
    const stat = await fs.stat(absolutePath);
    const completedAt = new Date(this.now()).toISOString();
    const submission = {
      requestId,
      folder: path.posix.join("layout-submissions", requestId),
      status: "failure",
      submittedAt: stat.birthtime.toISOString(),
      completedAt,
      photoCount: photos.length,
      photos,
      metrics: timingMetrics(),
      failure: { code: "generation_interrupted" },
      absolutePath,
      metadataPath,
    };
    await this.persist(submission);
    return submission;
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

  async finish(requestId, { status, metrics, finalizeMetrics } = {}) {
    const submission = this.submissions.find((value) => value.requestId === requestId);
    if (!submission) throw new Error("layout submission not found");
    submission.status = status === "success" ? "success" : "failure";
    submission.completedAt = new Date(this.now()).toISOString();
    submission.metrics = timingMetrics({
      ...submission.metrics,
      ...metrics,
      ...(typeof finalizeMetrics === "function" ? finalizeMetrics() : {}),
    });
    submission.failure = submission.status === "failure" ? { code: "generation_unavailable" } : null;
    // Commit terminal status and its complete metrics in one atomic metadata
    // replacement so restart reconciliation cannot observe a half-finished record.
    await this.persist(submission);
    return publicSubmission(submission);
  }

  list() {
    return this.submissions.map(publicSubmission);
  }

  async persist(submission) {
    const temporaryPath = path.join(submission.absolutePath, `.metadata-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(publicSubmission(submission), null, 2));
      await fs.rename(temporaryPath, submission.metadataPath);
    } finally {
      await fs.rm(temporaryPath, { force: true });
    }
  }
}
