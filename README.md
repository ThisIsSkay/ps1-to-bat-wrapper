# PS1 to BAT Wrapper

A single-page, browser-based tool that wraps a PowerShell script in a self-contained Windows `.bat` launcher — **readable, not a Base64 blob**. Everything runs client-side; nothing is uploaded.

### ▶ [Open the tool](https://thisisskay.github.io/ps1-to-bat-wrapper/)

Runs entirely in your browser. Requires GitHub Pages to be enabled for this repo (see [Hosting](#hosting-github-pages)). You can also download [`index.html`](index.html) and open it locally.

A Base64-embedded payload reads like malware to both human reviewers and antivirus heuristics ("decode a blob to disk and run it" is a textbook dropper shape). This tool keeps the script visible in the `.bat` so anyone can read exactly what will run, and adds a SHA-256 check so **accidental corruption** is caught before it executes.

## Two methods

**echo lines (ASCII)**
Each line of the script becomes one `>>"%TMPPS1%" echo(…` statement written to `%TEMP%`. The tool re-parses every line the way `cmd.exe` would and confirms it reconstructs the original, and the launcher counts the written lines to catch a partial write even when SHA-256 is off. Reliable for **ASCII** scripts. Because `echo` emits bytes in the console code page, non-ASCII characters (curly quotes, accents, box-drawing) can corrupt — the tool warns and steers you to hybrid mode. A single line that, after escaping, nears cmd's ~8191-character command limit is **rejected** in echo mode (use hybrid). Line endings are normalised to CRLF, so echo mode is functionally faithful but not byte-for-byte.

**self-read hybrid (UTF-8)**
The script body is stored **byte-for-byte** after a unique marker at the end of the file. The ASCII batch header launches PowerShell, which reads *this same file* as UTF-8, extracts everything after the marker line (so leading and trailing blank lines are preserved), verifies its SHA-256, writes it to `%TEMP%` as a UTF-8 `.ps1`, and runs it with `-File`. `cmd` never parses the body, so **non-ASCII survives** and there is no per-line length limit. Because it runs as a real file, `#requires`, `param()` blocks and launch arguments all work.

## What the generated launcher does

1. Selects **64-bit** `powershell.exe` even when started from a 32-bit prompt.
2. (Optional) Checks for administrator rights, requests a UAC prompt, **waits** for the elevated run and returns its exit code.
3. Writes the embedded script to `%TEMP%`.
4. (Optional) Verifies the script's SHA-256 before running.
5. Runs it and **propagates the script's own exit code**; (optionally) logs each step (logging falls back to `%TEMP%` if the `.bat` folder is read-only and never blocks the run); deletes the temp script afterwards (a delete failure is a warning only).

### Exit-code contract

| Code | Meaning |
|---|---|
| `0` | the embedded script ran and returned 0 |
| the script's own code | propagated verbatim when the script ran (e.g. `exit 42` → `42`) |
| `201` | not elevated / UAC cancelled — script did **not** run |
| `202` | bad output location / UNC path — script did **not** run |
| `203` | 64-bit Windows PowerShell not found — script did **not** run |
| `204` | embedded script could not be written or failed SHA-256 — script did **not** run |

Temp-cleanup failure is a warning only and never changes the exit code. A script that itself uses `201`–`204` is indistinguishable from the launcher's own codes (documented and accepted).

## What SHA-256 does and doesn't do

It detects **accidental corruption** of the embedded script — a bad copy, truncation, or encoding damage — before it runs. It is **not** a tamper-proof control: anyone who can edit the `.bat` can also change the embedded hash or turn the check off. For real authenticity, Authenticode-sign the script or the launcher. (Wrapping an already-signed `.ps1` invalidates its signature; run signed scripts directly instead — the tool warns if it detects a signature block.)

## Usage

Open `index.html` in any modern browser (or host it — see below). Paste a script or drop a `.ps1` file, choose a method and options, then **Copy** the generated `.bat`. Paste it into Notepad and save with "Save as type" set to **All files**:

- **echo mode** — save as `.bat` (ASCII, any encoding works).
- **hybrid mode** — save as `.bat` with encoding **UTF-8** (Notepad's default "UTF-8", *not* "UTF-8 with BOM", *not* ANSI). A BOM at the top breaks `cmd`'s first line.

## Hosting (GitHub Pages)

Because the tool is one static file, it can be served free from this repo:

1. Settings → Pages → Source: **Deploy from a branch** → `main` / `root`.
2. Open `https://thisisskay.github.io/ps1-to-bat-wrapper/`.

## Notes & limitations

- The launcher only writes, verifies, runs and deletes a copy of *your* script — it adds no behaviour of its own. Always review a script before running it elevated.
- In **hybrid** mode the script runs from `%TEMP%`, so `$PSScriptRoot` points there, not the `.bat` folder. If a script needs its own location, pass it via the arguments field (e.g. `-OutputBase "%~dp0out"`).
- The preview sandbox cannot save `.bat` files directly, so **Copy** is the reliable export. A "Save as .txt" button appears where the host supports it; rename to `.bat`.
- **Curly quotes** (`“ ” ‘ ’`) are preserved byte-for-byte, but PowerShell itself treats them as string delimiters — a script that uses them as *literal characters* inside a string will hit a PowerShell parser error (not a wrapper bug). Use straight quotes in code; the tool warns if it sees curly ones.
- Arguments you enter are inserted **verbatim** onto the PowerShell command line, so treat them as you would any command you'd run.
- Base64 embedding still has a place for binary payloads or heavy non-ASCII; there a checksum stops being optional.

## Testing

The generator logic is factored into `generator.js` and shared by the page and the tests.

- **Pure logic** (escaping round-trip, hybrid extraction, hash determinism, exit-code contract, cmd-block quoting) — runs anywhere:
  ```bash
  node test/pure.test.js
  ```
- **Windows runtime** (generates launchers and actually executes them against real `cmd.exe` + Windows PowerShell: UTF-8 round-trips, metacharacters, exit-code propagation, `param()`/`#requires`, tamper detection, cleanup, read-only-log fallback) — runs on Windows:
  ```powershell
  powershell -ExecutionPolicy Bypass -File test\win\run-tests.ps1
  ```

CI runs both on every push via [`.github/workflows/test.yml`](.github/workflows/test.yml) (Ubuntu for the pure tests, `windows-latest` for the runtime suite). Interactive UAC accept/cancel and antivirus removing the temp file are the only behaviours not covered automatically.

## License

MIT — see [LICENSE](LICENSE).
