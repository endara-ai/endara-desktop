#!/usr/bin/env node
/**
 * Cross-platform script to copy the endara-relay binary into the Tauri
 * sidecar binaries directory with the correct target-triple suffix.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DESKTOP_DIR = path.resolve(__dirname, "..");
const MONOREPO_DIR = path.resolve(DESKTOP_DIR, "../..");

// Detect target triple
function getTargetTriple() {
  if (process.env.TARGET_TRIPLE) {
    return process.env.TARGET_TRIPLE;
  }
  try {
    return execSync("rustc --print host-tuple", { encoding: "utf8" }).trim();
  } catch {
    const output = execSync("rustc -vV", { encoding: "utf8" });
    const match = output.match(/^host:\s*(.+)$/m);
    if (match) return match[1].trim();
    throw new Error("Could not determine target triple from rustc");
  }
}

const targetTriple = getTargetTriple();
const relayBin = path.join(
  MONOREPO_DIR,
  "packages/relay/target/release",
  process.platform === "win32" ? "endara-relay.exe" : "endara-relay"
);
const destDir = path.join(DESKTOP_DIR, "src-tauri/binaries");
const ext = process.platform === "win32" ? ".exe" : "";
const destBin = path.join(destDir, `endara-relay-${targetTriple}${ext}`);

if (!fs.existsSync(relayBin)) {
  console.error(`Error: Relay binary not found at ${relayBin}`);
  console.error(
    "Build it first: cd packages/relay && cargo build --release"
  );
  process.exit(1);
}

fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(relayBin, destBin);

// Make executable on Unix
if (process.platform !== "win32") {
  fs.chmodSync(destBin, 0o755);
}

console.log(`Copied relay binary to ${destBin}`);
console.log(`Target triple: ${targetTriple}`);

