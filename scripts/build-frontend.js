const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const source = path.join(root, "public");
const output = path.join(root, "dist");
const apiBase = (process.env.BACKEND_URL || "http://localhost:3000").replace(/\/$/, "");

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
fs.writeFileSync(
  path.join(output, "js", "config.js"),
  `window.APP_CONFIG = { apiBase: ${JSON.stringify(apiBase)} };\n`
);
console.log(`Frontend built in dist/ with backend ${apiBase}`);