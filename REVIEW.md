# Code review & hardening — assessment

Independent verification of the external findings for the PS1 → BAT Wrapper, plus
issues found during this review. Each finding was checked against Windows `cmd.exe`
and PowerShell behaviour by code analysis and Node simulation; **runtime** behaviour
is validated by the new Windows GitHub Actions suite (`test/win/run-tests.ps1`), not
on a Windows box by the author.

> Verification honesty: the pure-logic suite (`node test/pure.test.js`, 14 tests) was
> run locally and passes. The Windows runtime suite is written to execute real
> launchers on `windows-latest`; it has **not** been run by the author (no native
> Windows here). Interactive UAC and antivirus-removal cannot be exercised headlessly.

## Verdict table

| Finding | Confirmed? | Severity | Fix | Reason |
|---|---|---|---|---|
| A — hybrid extraction drops leading blank lines | **Confirmed defect** | High | Fixed | `TrimStart(CR,LF)` stripped a script's own leading blank lines; the embedded SHA-256 was computed over the un-stripped body, so any script starting with blank lines failed verification (exit 204) and never ran. Now the launcher skips **only** the marker line (`$b=$t.Substring($t.IndexOf([char]10,$i)+1)`) and the body is stored byte-for-byte. |
| B — UAC does not wait / exit code lost | **Valid concern** | Medium | Fixed | `Start-Process -Verb RunAs` returned immediately with code 0. Now uses `-PassThru -Wait` and propagates the elevated run's exit code. (While fixing this I found and fixed an early-`%ERRORLEVEL%`-expansion bug — see X1.) Runtime arguments to the `.bat` are **not** forwarded on relaunch by design: script arguments are baked in at generation time, documented. |
| C — echo mode can miss a partial write | **Valid concern** | Medium | Improved | `:write_ps1` returned success unconditionally. SHA-256 (default on) already caught this; added a line-count completeness check so a truncated write is caught **even with SHA-256 off** (`find /c /v ""` vs expected line count → 204). |
| D — logging can block execution | **Confirmed defect** | Medium | Fixed | A read-only `.bat` folder made the launcher abort. Logging now falls back to `%TEMP%` and, failing that, silently disables itself — it never blocks the run. Log init also moved **after** elevation so only the elevated instance logs. |
| E — script exit codes flattened to 5 | **Valid concern** | Medium | Fixed | Every non-zero script code became `5`. New contract: the script's own exit code is propagated verbatim; launcher-stage failures use reserved codes `201`–`204`; cleanup failure is a warning only. Documented in README. |
| F — cmd command-length limit | **Valid concern** | Low–Med | Improved | Was a warning only. Now an **error** in echo mode (budget accounts for the `>>"…ps1" echo(` prefix); the UI blocks it and steers to hybrid, which stores the body verbatim and has no per-line limit. |
| G — line-ending normalisation | **Valid concern** | Low | Addressed | Hybrid mode is now **byte-for-byte** (no normalisation). Echo mode still normalises to CRLF — documented as functionally-faithful-not-byte-exact. Added a warning when the script looks Authenticode-signed (wrapping invalidates the signature in either mode). |
| H — SHA-256 integrity vs security | **Valid concern (docs)** | Low | Fixed | Docs/tool no longer imply tamper-proofing. Clarified: SHA-256 catches **accidental corruption**; it is not authentication (an editor can change the hash or disable the check); for authenticity, code-sign. |
| I — escaping self-check vs real cmd | **Valid concern** | Low | Tests added | `escLine`/`decLine` were reviewed against `%`/`%%`, `!` (delayed expansion is disabled), `^`, parentheses, `& | < >`, embedded/unbalanced quotes, empty lines, long lines. They round-trip correctly for all tested inputs. Added a structural guard plus a Windows runtime test that generates a `.bat` of metacharacter-heavy lines and compares the file real cmd writes. No logic change required. |

## Issues found during this review (not in the original findings)

| # | Issue | Fix |
|---|---|---|
| X1 | In the first hardening draft, the elevation block read `%ERRORLEVEL%` inside the `if ( … )` block, so it captured `fltmc`'s code, not the elevated run's. | Capture on its own line (`set "ELC=%ERRORLEVEL%"`) after the call, then `endlocal & exit /b %ELC%`. |
| X2 | Escaped `^&` used as a separator inside `if ( … )` one-liners would be a **literal** ampersand, so `set`/`goto` would not run. | Use unescaped `&` inside blocks; added a regression test that asserts the generated `.bat` contains no `^&`. |
| X3 | Two error messages contained `( )`, which can terminate the enclosing `if` block. | Reworded all in-block messages to avoid `( ) & | < >`; added a paren-balance test per `if`-line. |
| X4 | `$PSScriptRoot` is `%TEMP%` in hybrid mode (script runs from there). | The launcher exports `%BATDIR%` as `$env:LAUNCHER_DIR`; documented, and arguments like `-OutputBase "%~dp0out"` still work. |
| X5 | Same-second temp/log name collision on concurrent runs. | Added a `%RANDOM%%RANDOM%` component (`RID`) to both the temp-script and log names. |
| X6 | PowerShell treats curly quotes/apostrophes (`“ ” ‘ ’`) as string delimiters, so a script using them as literals fails to **parse** — surfaced while writing the UTF-8 test (the wrapper preserves the bytes; the emoji/astral case passes). | Not a wrapper bug: documented in README, warned in the tool, and the Windows suite proves curly-quote **bytes** are delivered to the temp `.ps1` intact. |

## What was deliberately **not** changed

- The overall architecture (readable `.bat`, two modes, no Base64) is sound — no redesign.
- Echo mode stays line-based and ASCII-only; that is inherent, not a bug. Non-ASCII and byte-exactness are what hybrid mode is for.
- Arguments remain baked at generation time rather than forwarded from the `.bat` command line, to keep behaviour predictable and avoid fragile cross-UAC argument quoting.

## Test coverage

`node test/pure.test.js` — 14 pure-logic tests (run locally, passing).
`test/win/run-tests.ps1` — 12 Windows runtime scenarios: ASCII success, metacharacters
through real cmd, exit-code propagation (`exit 42`), `throw`, UTF-8 (accents/CJK/emoji/
box-drawing), `#requires`+`param()`+args, leading/trailing blanks with hash on, tamper
→ 204, SHA off, cleanup delete/keep, read-only-log fallback, already-elevated admin path.
Not covered: interactive UAC accept/cancel, AV removing the temp file (both noted).
