# PS1 to BAT Wrapper

A single-page, browser-based tool that wraps a PowerShell script in a self-contained Windows `.bat` launcher — **readable, not a Base64 blob**. Everything runs client-side; nothing is uploaded.

### ▶ [Open the tool](https://thisisskay.github.io/ps1-to-bat-wrapper/)

Runs entirely in your browser. Requires GitHub Pages to be enabled for this repo (see [Hosting](#hosting-github-pages)). You can also download [`index.html`](index.html) and open it locally.

A Base64-embedded payload reads like malware to both human reviewers and antivirus heuristics ("decode a blob to disk and run it" is a textbook dropper shape). This tool keeps the script visible in the `.bat` so anyone can read exactly what will run, and adds a SHA-256 check so a damaged or tampered file is caught before it executes.

## Two methods

**echo lines (ASCII)**
Each line of the script becomes one `>>"%TMPPS1%" echo(…` statement written to `%TEMP%`. The tool re-parses every line the way `cmd.exe` would and confirms it reconstructs the original. Reliable for **ASCII** scripts. Because `echo` emits bytes in the console code page, non-ASCII characters (curly quotes, accents, box-drawing) can corrupt.

**self-read hybrid (UTF-8)**
The script body is stored **verbatim** after a unique marker at the end of the file. The ASCII batch header launches PowerShell, which reads *this same file* as UTF-8, extracts the body, verifies its SHA-256, writes it to `%TEMP%` as a UTF-8 `.ps1`, and runs it with `-File`. `cmd` never parses the body, so **non-ASCII survives**, and because it runs as a real file, `#requires`, `param()` blocks and launch arguments all work.

## What the generated launcher does

1. Selects **64-bit** `powershell.exe` even when started from a 32-bit prompt.
2. (Optional) Checks for administrator rights and offers a UAC prompt.
3. Writes the embedded script to `%TEMP%`.
4. (Optional) Verifies the script's SHA-256 before running.
5. Runs it, (optionally) logs each step next to the `.bat`, and deletes the temp script afterwards.

Exit codes: `0` ok · `1` not admin · `2` bad folder · `3` PowerShell missing · `4` write/verify failed · `5` script error · `6` temp delete failed.

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
- Base64 embedding still has a place for binary payloads or heavy non-ASCII; there a checksum stops being optional.

## License

MIT — see [LICENSE](LICENSE).
