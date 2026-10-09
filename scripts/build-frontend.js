const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const source = path.join(root, "public");
const output = path.join(root, "dist");

fs.rmSync(output, { recursive: true, force: true });
fs.cpSync(source, output, { recursive: true });
fs.writeFileSync(
  path.join(output, "js", "config.js"),
  "window.APP_CONFIG = { apiBase: \"\" };\n"
);
console.log("Frontend built in dist/ with same-origin API requests.");