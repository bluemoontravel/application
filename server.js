const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { S3Client, PutObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const SPACES_BUCKET = process.env.SPACES_BUCKET;
const SPACES_REGION = process.env.SPACES_REGION;
const SPACES_ENDPOINT = process.env.SPACES_ENDPOINT;
const SPACES_KEY = process.env.SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET;
const SPACES_PUBLIC_BASE_URL = (process.env.SPACES_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const USE_SPACES = Boolean(
  SPACES_BUCKET &&
  SPACES_REGION &&
  SPACES_ENDPOINT &&
  SPACES_KEY &&
  SPACES_SECRET &&
  SPACES_PUBLIC_BASE_URL
);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const localStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    cb(null, createFileName(file.originalname || ""));
  }
});

const upload = multer({
  storage: USE_SPACES ? multer.memoryStorage() : localStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith("image/")) cb(null, true);
    else cb(new Error("Only image files are allowed"));
  }
});

const s3Client = USE_SPACES
  ? new S3Client({
      region: SPACES_REGION,
      endpoint: SPACES_ENDPOINT,
      credentials: {
        accessKeyId: SPACES_KEY,
        secretAccessKey: SPACES_SECRET
      }
    })
  : null;

function createFileName(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
}

app.use(express.static(ROOT_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));

app.get("/api/pictures", async (req, res) => {
  if (USE_SPACES) {
    try {
      const result = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: SPACES_BUCKET
        })
      );
      const files = (result.Contents || [])
        .filter((item) => item.Key)
        .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified))
        .map((item) => `${SPACES_PUBLIC_BASE_URL}/${item.Key}`);
      return res.json(files);
    } catch (error) {
      return res.status(500).json({ error: "Failed to read spaces images" });
    }
  }

  fs.readdir(UPLOADS_DIR, (err, files = []) => {
    if (err) return res.status(500).json({ error: "Failed to read uploads" });

    const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
    const images = files
      .filter((file) => imageExtensions.has(path.extname(file).toLowerCase()))
      .sort((a, b) => b.localeCompare(a))
      .map((file) => `/uploads/${file}`);

    return res.json(images);
  });
});

app.post("/api/pictures", upload.array("pictures", 20), async (req, res) => {
  if (!req.files || !req.files.length) {
    return res.status(400).json({ error: "No files uploaded" });
  }

  if (USE_SPACES) {
    try {
      const uploaded = [];
      for (const file of req.files) {
        const key = createFileName(file.originalname || "");
        await s3Client.send(
          new PutObjectCommand({
            Bucket: SPACES_BUCKET,
            Key: key,
            Body: file.buffer,
            ContentType: file.mimetype,
            ACL: "public-read"
          })
        );
        uploaded.push(`${SPACES_PUBLIC_BASE_URL}/${key}`);
      }
      return res.json({ uploaded });
    } catch (error) {
      return res.status(500).json({ error: "Failed to upload to spaces" });
    }
  }

  const uploaded = (req.files || []).map((file) => `/uploads/${file.filename}`);
  return res.json({ uploaded });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "admin.html"));
});

app.use((err, req, res, next) => {
  if (err) {
    return res.status(400).json({ error: err.message || "Upload failed" });
  }
  return next();
});

app.listen(PORT, () => {
  console.log(`BlueMoon app running at http://localhost:${PORT}`);
});
