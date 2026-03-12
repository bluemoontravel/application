const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT_DIR = __dirname;

app.use(express.static(ROOT_DIR));

app.get("/", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "index.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(ROOT_DIR, "admin.html"));
});

app.listen(PORT, () => {
  console.log(`BlueMoon app running at http://localhost:${PORT}`);
});
