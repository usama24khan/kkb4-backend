/**
 * patch-fontkit.js
 * ─────────────────
 * Patches fontkit's GPOSProcessor.getAnchor to guard against null anchor
 * records in Noto Nastaliq Urdu (and other complex Arabic/Urdu fonts).
 *
 * Run automatically via `npm run postinstall` so the fix survives npm install.
 */

const fs = require("fs");
const path = require("path");

const FONTKIT_DIR = path.join(__dirname, "../node_modules/fontkit");

const targets = [
  path.join(FONTKIT_DIR, "dist/main.cjs"),
  path.join(FONTKIT_DIR, "dist/module.mjs"),
  path.join(FONTKIT_DIR, "src/opentype/GPOSProcessor.js"),
];

const BROKEN = `    getAnchor(anchor) {
        // TODO: contour point, device tables
        let x = anchor.xCoordinate;`;

const FIXED = `    getAnchor(anchor) {
        // TODO: contour point, device tables
        if (!anchor) return { x: 0, y: 0 };
        let x = anchor.xCoordinate;`;

// src/ uses 2-space indent
const BROKEN_SRC = `  getAnchor(anchor) {
    // TODO: contour point, device tables
    let x = anchor.xCoordinate;`;

const FIXED_SRC = `  getAnchor(anchor) {
    // TODO: contour point, device tables
    if (!anchor) return { x: 0, y: 0 };
    let x = anchor.xCoordinate;`;

let patched = 0;

for (const file of targets) {
  if (!fs.existsSync(file)) continue;

  let content = fs.readFileSync(file, "utf8");
  const isSrc = file.includes("/src/");
  const broken = isSrc ? BROKEN_SRC : BROKEN;
  const fixed = isSrc ? FIXED_SRC : FIXED;

  if (content.includes(fixed)) {
    console.log(`[patch-fontkit] already patched: ${path.relative(process.cwd(), file)}`);
    continue;
  }

  if (!content.includes(broken)) {
    console.warn(`[patch-fontkit] pattern not found — skipping: ${path.relative(process.cwd(), file)}`);
    continue;
  }

  fs.writeFileSync(file, content.replace(broken, fixed), "utf8");
  console.log(`[patch-fontkit] patched: ${path.relative(process.cwd(), file)}`);
  patched++;
}

if (patched > 0) {
  console.log(`[patch-fontkit] done — ${patched} file(s) patched.`);
}
