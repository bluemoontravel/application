const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const DATA_DIR = path.join(ROOT_DIR, "data");

const DESTINATIONS_FILE = path.join(DATA_DIR, "destinations.json");
const PACKAGES_FILE = path.join(DATA_DIR, "packages.json");
const BOOKINGS_FILE = path.join(DATA_DIR, "bookings.json");

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
fs.mkdirSync(DATA_DIR, { recursive: true });
initializeStore(DESTINATIONS_FILE, []);
initializeStore(PACKAGES_FILE, []);
initializeStore(BOOKINGS_FILE, []);

function initializeStore(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(defaultValue, null, 2));
  }
}

function readStore(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    return [];
  }
}

function writeStore(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
}

function createFileName(originalName) {
  const ext = path.extname(originalName).toLowerCase();
  return `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
}

const localStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, createFileName(file.originalname || "image.jpg"))
});

const upload = multer({
  storage: USE_SPACES ? multer.memoryStorage() : localStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
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

function toPublicImageUrl(key) {
  return `${SPACES_PUBLIC_BASE_URL}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

app.use(express.static(ROOT_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use(express.json());

app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Image is required" });

  if (USE_SPACES) {
    try {
      const key = `uploads/${createFileName(req.file.originalname || "image.jpg")}`;
      try {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: SPACES_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype,
            ACL: "public-read"
          })
        );
      } catch (aclError) {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: SPACES_BUCKET,
            Key: key,
            Body: req.file.buffer,
            ContentType: req.file.mimetype
          })
        );
      }
      return res.json({ url: toPublicImageUrl(key) });
    } catch (error) {
      return res.status(500).json({ error: "Failed to upload image" });
    }
  }

  return res.json({ url: `/uploads/${req.file.filename}` });
});

app.get("/api/destinations", (req, res) => {
  const destinations = readStore(DESTINATIONS_FILE);
  res.json(destinations.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post("/api/destinations", (req, res) => {
  const { name, imageUrl, status = "live" } = req.body;
  if (!name || !imageUrl) return res.status(400).json({ error: "name and imageUrl are required" });

  const destinations = readStore(DESTINATIONS_FILE);
  const destination = {
    id: createId("dest"),
    name: String(name).trim(),
    imageUrl: String(imageUrl).trim(),
    status: status === "offline" ? "offline" : "live",
    createdAt: new Date().toISOString()
  };
  destinations.push(destination);
  writeStore(DESTINATIONS_FILE, destinations);
  res.status(201).json(destination);
});

app.put("/api/destinations/:id", (req, res) => {
  const destinations = readStore(DESTINATIONS_FILE);
  const index = destinations.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Destination not found" });

  destinations[index] = {
    ...destinations[index],
    ...req.body,
    id: destinations[index].id
  };
  writeStore(DESTINATIONS_FILE, destinations);
  res.json(destinations[index]);
});

app.delete("/api/destinations/:id", (req, res) => {
  const destinations = readStore(DESTINATIONS_FILE);
  const next = destinations.filter((item) => item.id !== req.params.id);
  if (next.length === destinations.length) return res.status(404).json({ error: "Destination not found" });

  writeStore(DESTINATIONS_FILE, next);
  const packages = readStore(PACKAGES_FILE).filter((pkg) => pkg.destinationId !== req.params.id);
  writeStore(PACKAGES_FILE, packages);
  res.status(204).end();
});

app.get("/api/packages", (req, res) => {
  const destinations = readStore(DESTINATIONS_FILE);
  const destinationMap = new Map(destinations.map((item) => [item.id, item]));
  const packages = readStore(PACKAGES_FILE).map((pkg) => ({
    ...pkg,
    destinationName: destinationMap.get(pkg.destinationId)?.name || "Unknown"
  }));
  res.json(packages.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post("/api/packages", (req, res) => {
  const { name, destinationId, duration, priceThb, details, imageUrl, status = "live" } = req.body;
  if (!name || !destinationId || !duration || !priceThb || !imageUrl) {
    return res.status(400).json({ error: "name, destinationId, duration, priceThb, imageUrl are required" });
  }

  const destinations = readStore(DESTINATIONS_FILE);
  if (!destinations.find((item) => item.id === destinationId)) {
    return res.status(400).json({ error: "Invalid destinationId" });
  }

  const packages = readStore(PACKAGES_FILE);
  const pkg = {
    id: createId("pkg"),
    name: String(name).trim(),
    destinationId,
    duration: String(duration).trim(),
    priceThb: Number(priceThb),
    details: String(details || "").trim(),
    imageUrl: String(imageUrl).trim(),
    status: status === "offline" ? "offline" : "live",
    createdAt: new Date().toISOString()
  };
  packages.push(pkg);
  writeStore(PACKAGES_FILE, packages);
  res.status(201).json(pkg);
});

app.put("/api/packages/:id", (req, res) => {
  const packages = readStore(PACKAGES_FILE);
  const index = packages.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Package not found" });

  packages[index] = {
    ...packages[index],
    ...req.body,
    id: packages[index].id
  };
  writeStore(PACKAGES_FILE, packages);
  res.json(packages[index]);
});

app.delete("/api/packages/:id", (req, res) => {
  const packages = readStore(PACKAGES_FILE);
  const next = packages.filter((item) => item.id !== req.params.id);
  if (next.length === packages.length) return res.status(404).json({ error: "Package not found" });
  writeStore(PACKAGES_FILE, next);
  res.status(204).end();
});

app.get("/api/bookings", (req, res) => {
  const packages = readStore(PACKAGES_FILE);
  const destinations = readStore(DESTINATIONS_FILE);
  const pkgMap = new Map(packages.map((item) => [item.id, item]));
  const destMap = new Map(destinations.map((item) => [item.id, item]));

  const bookings = readStore(BOOKINGS_FILE).map((item) => {
    const pkg = pkgMap.get(item.packageId);
    const dest = pkg ? destMap.get(pkg.destinationId) : null;
    return {
      ...item,
      packageName: pkg?.name || "Unknown",
      destinationName: dest?.name || "Unknown"
    };
  });
  res.json(bookings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post("/api/bookings", (req, res) => {
  const { customerName, phone, travelDate, travelers, notes, packageId } = req.body;
  if (!customerName || !phone || !travelDate || !travelers || !packageId) {
    return res.status(400).json({ error: "customerName, phone, travelDate, travelers, packageId are required" });
  }

  const packages = readStore(PACKAGES_FILE);
  const pkg = packages.find((item) => item.id === packageId);
  if (!pkg) return res.status(400).json({ error: "Invalid packageId" });

  const bookings = readStore(BOOKINGS_FILE);
  const booking = {
    id: createId("book"),
    customerName: String(customerName).trim(),
    phone: String(phone).trim(),
    travelDate,
    travelers: Number(travelers),
    notes: String(notes || "").trim(),
    packageId,
    status: "new",
    createdAt: new Date().toISOString()
  };
  bookings.push(booking);
  writeStore(BOOKINGS_FILE, bookings);
  res.status(201).json(booking);
});

app.patch("/api/bookings/:id", (req, res) => {
  const { status } = req.body;
  if (!["new", "confirmed", "cancelled"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  const bookings = readStore(BOOKINGS_FILE);
  const index = bookings.findIndex((item) => item.id === req.params.id);
  if (index === -1) return res.status(404).json({ error: "Booking not found" });

  bookings[index].status = status;
  writeStore(BOOKINGS_FILE, bookings);
  res.json(bookings[index]);
});

app.get("/api/dashboard", (req, res) => {
  const destinations = readStore(DESTINATIONS_FILE);
  const packages = readStore(PACKAGES_FILE);
  const bookings = readStore(BOOKINGS_FILE);

  const pkgMap = new Map(packages.map((item) => [item.id, item]));
  let expectedRevenue = 0;
  for (const booking of bookings) {
    const pkg = pkgMap.get(booking.packageId);
    if (pkg && booking.status !== "cancelled") {
      expectedRevenue += Number(pkg.priceThb || 0) * Number(booking.travelers || 1);
    }
  }

  res.json({
    totalDestinations: destinations.length,
    totalPackages: packages.length,
    totalBookings: bookings.length,
    newBookings: bookings.filter((item) => item.status === "new").length,
    expectedRevenue
  });
});

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "admin.html"));
});

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || "Request failed" });
  return next();
});

app.listen(PORT, () => {
  console.log(`BlueMoon app running at http://localhost:${PORT}`);
});
