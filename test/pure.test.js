/*
 * Pure-logic regression tests. Run anywhere with Node (no Windows needed):
 *   node test/pure.test.js
 * These validate the GENERATOR (escaping, extraction, hashes, exit codes).
 * They do NOT prove Windows runtime behavior — that is what test/win/run-tests.ps1
 * on a Windows runner (see .github/workflows/test.yml) actually executes.
 */
"use strict";
const assert = require("assert");
const crypto = require("crypto");
const G = require("../generator.js");

let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log("  ok   " + name); } catch (e) { fail++; console.log("  FAIL " + name + "\n       " + e.message); } }
function sha(str) { return crypto.createHash("sha256").update(Buffer.from(str, "utf8")).digest("hex").toUpperCase(); }

const OPTS = { stem: "Test", admin: true, hash: true, del: true, log: true, pause: true, args: "" };
function opt(over) { return Object.assign({}, OPTS, over); }

/* ---- escaping round-trip (self-check parity with cmd semantics) ---- */
const ESCAPE_CASES = [
  "a & b", "$x=\"100%\" | foo", "echo (test)", "trailing caret ^",
  "\"quoted & | < >\"", "mix \"a%b\" & c^", "(paren) <redir> >out |pipe",
  "%PATH% literal", "", " leading spaces kept", "tab\there",
  "a\"b\"c & d", "unbalanced \" & | < > ( )", "100%% already", "^^ double caret",
  "Write-Host 'it''s ok'", "if ($x -gt 0) { 'y' } else { 'n' }",
  "$env:PATH -split ';'", "cmd /c \"echo hi & echo bye\""
];
t("escLine/decLine round-trip on tricky lines", () => {
  for (const c of ESCAPE_CASES) assert.strictEqual(G.decLine(G.escLine(c)), c, JSON.stringify(c));
});

/* ---- ECHO mode: reconstruct the temp file the launcher would write ---- */
function reconstructEcho(bat) {
  // the launcher appends decLine(escaped)+CRLF for each `>>"%TMPPS1%" echo(...` line
  const out = [];
  for (const line of bat.split("\r\n")) {
    const m = line.match(/^>>"%TMPPS1%" echo\((.*)$/);
    if (m) { const d = G.decLine(m[1]); assert.notStrictEqual(d, null, "undecodable: " + m[1]); out.push(d); }
  }
  return out.join("\r\n") + "\r\n";
}
t("echo: reconstructed temp file == hashed body, and hash matches", () => {
  const script = "#requires -Version 5.1\n\n# two leading blanks above were none; one here:\nWrite-Host \"a & b | c\"\n$x = 'it''s'\nif ($y) { 'z' }\n";
  const sp = G.splitLines(script);
  const body = G.echoBodyText(sp.lines);
  let bat = G.buildEcho(sp.lines, opt({}), G.PH).replace(G.PH, sha(body));
  assert.strictEqual(reconstructEcho(bat), body, "reconstruct mismatch");
  // embedded expected hash equals sha of body
  const m = bat.match(/set "EXPECTED_SHA256=([0-9A-F]+)"/);
  assert.ok(m, "no embedded hash"); assert.strictEqual(m[1], sha(body));
});
t("echo: leading AND trailing blank lines are preserved", () => {
  const script = "\r\n\r\nWrite-Host hi\r\n\r\n";
  const sp = G.splitLines(script);
  const body = G.echoBodyText(sp.lines);
  const bat = G.buildEcho(sp.lines, opt({}), G.PH).replace(G.PH, sha(body));
  assert.strictEqual(reconstructEcho(bat), body);
});
t("echo: completeness line count matches number of echo lines", () => {
  const sp = G.splitLines("a\r\nb\r\nc\r\n");
  const bat = G.buildEcho(sp.lines, opt({ hash: false }), G.PH);
  const echoCount = (bat.match(/^>>"%TMPPS1%" echo\(/gm) || []).length;
  assert.strictEqual(echoCount, sp.lines.length);
  assert.ok(bat.indexOf('if not "%ACTUAL_LINES%"=="' + sp.lines.length + '"') >= 0, "line-count guard missing");
});

/* ---- HYBRID mode: Finding A + G ---- */
t("hybrid: extracted body == raw input (byte-for-byte, incl. leading blanks)", () => {
  const script = "\r\n\r\n#requires -Version 5.1\nparam([string]$Name='x')\nWrite-Host \"Café “ok” ─ $Name\"\n\n\n";
  const sp = G.splitLines(script);
  const rest = G.markerRest(sp.raw);
  const bat = G.buildHybrid(sp.raw, opt({}), rest, G.PH).replace(G.PH, sha(sp.raw));
  const extracted = G.extractHybridBody(bat, rest);
  assert.strictEqual(extracted, sp.raw, "hybrid body not byte-preserved");
});
t("hybrid: embedded hash == sha256 of the raw body", () => {
  const script = "Write-Host 你好\r\nexit 0\r\n";
  const sp = G.splitLines(script);
  const rest = G.markerRest(sp.raw);
  const h = sha(sp.raw);
  const bat = G.buildHybrid(sp.raw, opt({}), rest, G.PH).replace(G.PH, h);
  const extracted = G.extractHybridBody(bat, rest);
  assert.strictEqual(sha(extracted), h, "runtime hash would not match embedded");
  assert.ok(bat.indexOf("if($hash -ne '" + h + "')") >= 0, "embedded hash not placed in -Command");
});
t("hybrid: marker is unique and header is 7-bit ASCII", () => {
  const sp = G.splitLines("Write-Host é\r\n");
  const rest = G.markerRest(sp.raw);
  const bat = G.buildHybrid(sp.raw, opt({}), rest, G.PH).replace(G.PH, sha(sp.raw));
  const occurrences = bat.split("#" + rest).length - 1;
  assert.strictEqual(occurrences, 1, "marker appears " + occurrences + " times");
  const header = bat.slice(0, bat.indexOf("#" + rest));
  for (let i = 0; i < header.length; i++) assert.ok(header.charCodeAt(i) < 128, "non-ASCII in header at " + i);
});
t("hybrid: marker collision in body is avoided", () => {
  const body = "# " + "PSBODY_7F3A2C91" + " appears in the script\r\n";
  const raw = "#" + "PSBODY_7F3A2C91" + "\r\n" + body; // force a collision with the default
  const rest = G.markerRest(raw);
  assert.notStrictEqual(rest, "PSBODY_7F3A2C91");
  const bat = G.buildHybrid(raw, opt({}), rest, G.PH).replace(G.PH, sha(raw));
  assert.strictEqual(G.extractHybridBody(bat, rest), raw);
});

/* ---- exit-code contract present ---- */
t("exit codes: launcher-stage codes present, script code propagated", () => {
  const sp = G.splitLines("exit 42\r\n");
  const bat = G.buildEcho(sp.lines, opt({}), G.PH).replace(G.PH, sha(G.echoBodyText(sp.lines)));
  assert.ok(bat.indexOf('set "RC=%ERRORLEVEL%"') >= 0, "script exit code not captured");
  assert.ok(bat.indexOf("exit /b %RC%") >= 0, "RC not propagated");
  assert.ok(bat.indexOf("RC=201") >= 0 && bat.indexOf("RC=203") >= 0 && bat.indexOf("RC=204") >= 0, "launcher codes missing");
  // script exit code must NOT be flattened to a fixed launcher code
  assert.ok(bat.indexOf('set "RC=5"') < 0, "old flatten-to-5 still present");
});

/* ---- UAC waits and propagates ---- */
t("elevation: uses -Wait -PassThru and propagates the elevated exit code", () => {
  const sp = G.splitLines("Write-Host hi\r\n");
  const bat = G.buildEcho(sp.lines, opt({}), G.PH).replace(G.PH, sha(G.echoBodyText(sp.lines)));
  assert.ok(/-PassThru -Wait/.test(bat), "elevation does not wait");
  assert.ok(bat.indexOf("exit $p.ExitCode") >= 0, "elevated exit code not returned");
  assert.ok(bat.indexOf('set "ELC=%ERRORLEVEL%"') >= 0, "elevation code not captured on its own line");
  assert.ok(bat.indexOf("endlocal & exit /b %ELC%") >= 0, "unelevated instance does not propagate the elevated code");
  // guard against the early-expansion bug: must NOT read %ERRORLEVEL% in-block
  assert.ok(bat.indexOf("endlocal & exit /b %ERRORLEVEL%") < 0, "elevation still expands ERRORLEVEL too early");
});

/* ---- logging is non-fatal ---- */
t("logging: falls back to %TEMP% and never aborts on a read-only folder", () => {
  const sp = G.splitLines("Write-Host hi\r\n");
  const bat = G.buildEcho(sp.lines, opt({}), G.PH).replace(G.PH, sha(G.echoBodyText(sp.lines)));
  assert.ok(bat.indexOf('set "LOG=%TEMP%\\') >= 0, "no TEMP fallback for log");
  // there must be no 'goto :end' / RC=2 solely because the log could not be created
  assert.ok(!/not exist "%LOG%"[^\n]*goto/.test(bat), "log failure still aborts");
});

/* ---- cmd-parsing structural guards (regressions in block quoting) ---- */
t("structure: no escaped ^& separators, and if-block messages have no parens", () => {
  for (const mode of ["echo", "hybrid"]) {
    const sp = G.splitLines("Write-Host hi\r\nexit 0\r\n");
    const bat = mode === "echo"
      ? G.buildEcho(sp.lines, opt({}), G.PH).replace(G.PH, sha(G.echoBodyText(sp.lines)))
      : G.buildHybrid(sp.raw, opt({}), G.markerRest(sp.raw), G.PH).replace(G.PH, sha(sp.raw));
    assert.ok(bat.indexOf("^&") < 0, mode + ": contains ^& (would be a literal ampersand, breaking separation)");
    // every single-line `if ... ( ... )` must have balanced parens on that line
    for (const line of bat.split("\r\n")) {
      if (/^\s*if .*\(/.test(line) && line.indexOf(")") >= 0) {
        // strip escaped parens ^( ^) which are literal and balanced by design
        const stripped = line.replace(/\^\(/g, "").replace(/\^\)/g, "");
        const open = (stripped.match(/\(/g) || []).length;
        const close = (stripped.match(/\)/g) || []).length;
        assert.strictEqual(open, close, mode + ": unbalanced parens -> " + line);
      }
    }
  }
});

/* ---- echo length budget ---- */
t("echo: long line is detectable via maxEchoLen against the budget", () => {
  const longLine = "Write-Host '" + "x".repeat(9000) + "'";
  const sp = G.splitLines(longLine + "\r\n");
  assert.ok(G.maxEchoLen(sp.lines) > G.ECHO_LINE_BUDGET, "budget check would miss an over-long line");
  const okLine = "Write-Host 'short'";
  assert.ok(G.maxEchoLen(G.splitLines(okLine).lines) < G.ECHO_LINE_BUDGET);
});

/* ---- large synthetic script: every echo line decodes back exactly ---- */
t("echo: 400+ line script full of metacharacters round-trips", () => {
  const frags = [
    'Write-Host "a & b | c < d > e (f)"', "$x = 'it''s'; if ($x -ne 0) { 'y' }",
    "Get-ChildItem | Where-Object { $_.Length -gt 100 } | Select-Object -First 5",
    "$p = \"$env:TEMP\\out.txt\"; 100% done", "  indented line with trailing caret ^",
    "", "cmd /c \"echo nested & echo quotes\"", "@'", "here-string body & | < >", "'@"
  ];
  const lines = [];
  for (let i = 0; i < 45; i++) for (const f of frags) lines.push(f.replace("100%", "100% iter" + i));
  const body = lines.join("\r\n") + "\r\n";
  const sp = G.splitLines(body);
  assert.ok(sp.lines.length >= 400, "expected 400+ lines, got " + sp.lines.length);
  const bat = G.buildEcho(sp.lines, opt({}), G.PH).replace(G.PH, sha(G.echoBodyText(sp.lines)));
  assert.strictEqual(reconstructEcho(bat), G.echoBodyText(sp.lines));
});

console.log("\n" + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
