const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const source = path.join(root, "public");
const output = path.join(root, "dist");
if (process.env.VERCEL && !process.env.BACKEND_URL) {
  throw new Error("BACKEND_URL must be set to the deployed Render backend URL before building on Vercel.");
}
const apiBase = (process.env.BACKEND_URL || "http://localhost:3000").replace(/\/$/, "");

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
fs.writeFileSync(
  path.join(output, "js", "config.js"),
  `window.APP_CONFIG = { apiBase: ${JSON.stringify(apiBase)} };\n`
);
console.log(`Frontend built in dist/ with backend ${apiBase}`);