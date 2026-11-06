#!/usr/bin/env node
/*
 * CLI wrapper around generator.js so the Windows test harness (and anyone)
 * can produce a .bat from a .ps1 without a browser.
 *
 *   node gen-cli.js --mode echo|hybrid --in script.ps1 --out out.bat \
 *       [--stem Name] [--args "..."] [--no-hash] [--no-admin] \
 *       [--no-del] [--no-log] [--no-pause]
 *
 * Writes the .bat as UTF-8 WITHOUT BOM (required for the hybrid launcher).
 */
"use strict";
const fs = require("fs");
const crypto = require("crypto");
const G = require("./generator.js");

function arg(name, def) { const i = process.argv.indexOf("--" + name); return i >= 0 ? process.argv[i + 1] : def; }
function flagOff(name) { return process.argv.indexOf("--no-" + name) >= 0; }
function sha(str) { return crypto.createHash("sha256").update(Buffer.from(str, "utf8")).digest("hex").toUpperCase(); }

const mode = arg("mode", "echo");
const inPath = arg("in");
const outPath = arg("out");
if (!inPath || !outPath) { console.error("need --in and --out"); process.exit(2); }

const raw = fs.readFileSync(inPath, "utf8");
const sp = G.splitLines(raw);
const stem = (arg("stem", "Run-Script")).replace(/\.(bat|cmd)$/i, "").replace(/[^A-Za-z0-9._-]/g, "_") || "Run-Script";
const opts = {
  stem: stem,
  admin: !flagOff("admin"),
  hash: !flagOff("hash"),
  del: !flagOff("del"),
  log: !flagOff("log"),
  pause: !flagOff("pause"),
  args: arg("args", "")
};

let bat, hash = "";
if (mode === "hybrid") {
  const body = sp.raw;
  const rest = G.markerRest(body);
  if (opts.hash) hash = sha(body);
  bat = G.buildHybrid(body, opts, rest, G.PH);
  if (opts.hash) bat = bat.replace(G.PH, hash);
} else {
  const body = G.echoBodyText(sp.lines);
  if (opts.hash) hash = sha(body);
  bat = G.buildEcho(sp.lines, opts, G.PH);
  if (opts.hash) bat = bat.replace(G.PH, hash);
  const longest = G.maxEchoLen(sp.lines);
  if (longest > G.ECHO_LINE_BUDGET) { console.error("echo line too long: " + longest); process.exit(3); }
}
// UTF-8 without BOM
fs.writeFileSync(outPath, Buffer.from(bat, "utf8"));
// info goes to stdout; stderr is reserved for real errors (so a PowerShell
// caller with $ErrorActionPreference='Stop' does not treat this as a failure)
process.stdout.write("wrote " + outPath + " (" + mode + ", hash " + (opts.hash ? hash.slice(0, 12) : "off") + ")\n");
