/*
 * PS1 to BAT Wrapper — launcher generator (pure, no DOM).
 * Shared by index.html (browser) and the test suite (Node).
 *
 * Exit-code contract of the generated launcher:
 *   0            the embedded script ran and returned 0
 *   1..200,>=205 the embedded script's OWN exit code, propagated verbatim
 *   201          not elevated / UAC cancelled   (script did NOT run)
 *   202          bad output location / UNC path  (script did NOT run)
 *   203          64-bit Windows PowerShell not found (script did NOT run)
 *   204          embedded script could not be written or failed SHA-256
 *                verification (script did NOT run)
 *   Temp-cleanup failure is a WARNING only and never changes the exit code.
 *   (If a script legitimately uses exit 201-204 the two are indistinguishable;
 *    this is documented and accepted.)
 *
 * cmd quoting rules observed below:
 *   - Inside `if ... ( a & b & c )` one-liners the `&` separators are UNESCAPED
 *     (an escaped `^&` there is a literal ampersand and breaks the sequence).
 *   - Error-message text passed to echo/call never contains ( ) & | < > so it
 *     cannot terminate the enclosing block (quotes are not relied on for this).
 *   - The elevation exit code is captured on its own line (set "ELC=%ERRORLEVEL%")
 *     so it is read AFTER the elevated run, not at block-parse time.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.PS1BAT = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var SPECIAL = "^&|<>()";
  var PH = "__EXPECTED_SHA256__";
  var CODES = { notAdmin: 201, badFolder: 202, noPowerShell: 203, writeVerify: 204 };
  var ECHO_LINE_BUDGET = 8000;

  function escLine(line) {
    var out = "", q = false;
    for (var k = 0; k < line.length; k++) {
      var ch = line[k];
      if (ch === "%") { out += "%%"; continue; }
      if (ch === '"') { q = !q; out += '"'; continue; }
      if (!q && SPECIAL.indexOf(ch) >= 0) { out += "^" + ch; continue; }
      out += ch;
    }
    return out;
  }

  function decLine(s) {
    var out = "", q = false;
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (ch === "%") { if (s[i + 1] === "%") { out += "%"; i++; continue; } return null; }
      if (ch === '"') { q = !q; out += '"'; continue; }
      if (!q && ch === "^") { i++; if (i >= s.length) return null; out += s[i]; continue; }
      if (!q && "&|<>()".indexOf(ch) >= 0) return null;
      out += ch;
    }
    return out;
  }

  function splitLines(raw) {
    var t = raw, bom = false;
    if (t.charCodeAt(0) === 0xFEFF) { bom = true; t = t.slice(1); }
    var crlf = /\r\n/.test(t);
    var bareLf = /(^|[^\r])\n/.test(t);
    var bareCr = /\r(?!\n)/.test(t);
    var lines = t.split(/\r\n|\r|\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { lines: lines, raw: t, bom: bom, mixed: crlf && (bareLf || bareCr), lf: bareLf && !crlf };
  }

  function echoBodyText(lines) { return lines.join("\r\n") + "\r\n"; }

  function maxEchoLen(lines) {
    var m = 0;
    for (var i = 0; i < lines.length; i++) { var l = escLine(lines[i]).length; if (l > m) m = l; }
    return m;
  }

  function markerRest(text) {
    var rest = "PSBODY_7F3A2C91", n = 0;
    while (text.indexOf("#" + rest) >= 0) { n++; rest = "PSBODY_7F3A2C91_" + n; }
    return rest;
  }

  function extractHybridBody(bat, rest) {
    var mark = "#" + rest;
    var i = bat.indexOf(mark);
    if (i < 0) return null;
    var j = bat.indexOf("\n", i);
    if (j < 0) return null;
    return bat.slice(j + 1);
  }

  /* ---------- shared batch fragments ---------- */
  function psExe(L) {
    L.push("rem ---- 64-bit Windows PowerShell, even from a 32-bit prompt -----------------");
    L.push('set "PSEXE=%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"');
    L.push('if exist "%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe" set "PSEXE=%SystemRoot%\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe"');
    L.push("");
  }

  function preflight(L) {
    L.push("rem ---- Pre-flight (before elevation and before logging) --------------------");
    L.push('if not exist "%PSEXE%" ( echo ERROR: 64-bit Windows PowerShell not found. & set "RC=' + CODES.noPowerShell + '" & goto :finish )');
    L.push('if "%BATDIR:~0,2%"=="\\\\" ( echo ERROR: Running from a UNC path; copy the .bat to a local drive. & set "RC=' + CODES.badFolder + '" & goto :finish )');
    L.push("");
  }

  function elevationBlock(L) {
    L.push("rem ---- Admin check + UAC elevation (waits for the elevated run) ------------");
    L.push('"%SystemRoot%\\System32\\fltmc.exe" >nul 2>&1');
    L.push("if not errorlevel 1 goto :elevated_ok");
    L.push('if /i "%~1"=="/elevated" ( echo ERROR: Elevation failed; right-click the .bat and Run as administrator. & set "RC=' + CODES.notAdmin + '" & goto :finish )');
    L.push("echo Requesting administrator rights; continue in the elevated window...");
    L.push('"%PSEXE%" -NoProfile -NonInteractive -Command "try { $p=Start-Process -FilePath $env:ComSpec -ArgumentList (\'/c \' + [char]34 + [char]34 + $env:SELF + [char]34 + \' /elevated\' + [char]34) -Verb RunAs -PassThru -Wait -ErrorAction Stop; exit $p.ExitCode } catch { exit ' + CODES.notAdmin + ' }"');
    L.push('set "ELC=%ERRORLEVEL%"');
    L.push("endlocal & exit /b %ELC%");
    L.push(":elevated_ok");
    L.push("");
  }

  function stampAndTemp(L, stem) {
    L.push("rem ---- Timestamp, temp path, launcher dir ---------------------------------");
    L.push('set "STAMP="');
    L.push('if exist "%PSEXE%" for /f "delims=" %%T in (\'call "%PSEXE%" -NoProfile -NonInteractive -Command "Get-Date -Format yyyyMMdd_HHmmss"\') do set "STAMP=%%T"');
    L.push('if not defined STAMP set "STAMP=%RANDOM%%RANDOM%"');
    L.push('set "RID=%RANDOM%%RANDOM%"');
    L.push('set "TMPPS1=%TEMP%\\' + stem + '_%STAMP%_%RID%.ps1"');
    L.push('set "LAUNCHER_DIR=%BATDIR%"');
    L.push("");
  }

  function logInit(L, stem) {
    L.push("rem ---- Logging (non-fatal; falls back to %TEMP% if the folder is read-only) -");
    L.push('set "LOG=%BATDIR%\\' + stem + '_%COMPUTERNAME%_%STAMP%_%RID%.log"');
    L.push('>>"%LOG%" 2>nul echo [%DATE% %TIME%] Launcher start on %COMPUTERNAME% as %USERDOMAIN%\\%USERNAME%');
    L.push('if not exist "%LOG%" (');
    L.push('    set "LOG=%TEMP%\\' + stem + '_%COMPUTERNAME%_%STAMP%_%RID%.log"');
    L.push('    >>"%LOG%" 2>nul echo [%DATE% %TIME%] Launcher start ^(log fell back to TEMP; .bat folder not writable^)');
    L.push(")");
    L.push('if not exist "%LOG%" set "LOG="');
    L.push('call :log "Launcher: %SELF%"');
    L.push('call :log "Output folder: %BATDIR%"');
    L.push('call :log "Temp script: %TMPPS1%"');
    L.push("");
  }

  function runSection(L, opts) {
    L.push("rem ---- Run the embedded script (its exit code is propagated) ---------------");
    if (opts.log) L.push('call :log "Running the script."');
    L.push('"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -File "%TMPPS1%"' + (opts.args ? " " + opts.args : ""));
    L.push('set "RC=%ERRORLEVEL%"');
    if (opts.log) L.push('call :log "Script returned exit code %RC%."');
    L.push("");
  }

  function cleanupAndFinish(L, opts) {
    L.push(":cleanup");
    if (opts.del) {
      L.push("rem ---- Delete the temp script (failure is a warning, never fatal) ----------");
      L.push('if exist "%TMPPS1%" del /f /q "%TMPPS1%" >nul 2>&1');
      L.push('if exist "%TMPPS1%" ( "%SystemRoot%\\System32\\timeout.exe" /t 2 /nobreak >nul 2>&1 & del /f /q "%TMPPS1%" >nul 2>&1 )');
      if (opts.log) {
        L.push('if exist "%TMPPS1%" ( call :log "WARNING: could not delete the temp script; remove it manually." ) else ( call :log "Temp script deleted." )');
      } else {
        L.push('if exist "%TMPPS1%" echo WARNING: could not delete the temp script; remove it manually.');
      }
    } else {
      L.push('rem (Temp script kept - "delete after run" was off.)');
    }
    L.push("");
    L.push(":finish");
    if (opts.log) L.push('call :log "Launcher exit code %RC%."');
    if (opts.pause) {
      L.push("echo.");
      L.push('if "%RC%"=="0" ( echo  DONE. ) else ( echo  FINISHED - exit code %RC%.' + (opts.log ? " See the log file." : "") + ' )');
      L.push("pause");
    }
    L.push("endlocal & exit /b %RC%");
    L.push("");
    if (opts.log) {
      L.push(":log");
      L.push('if defined LOG >>"%LOG%" 2>nul echo [%DATE% %TIME%] %~1');
      L.push('echo [%DATE% %TIME%] %~1');
      L.push("exit /b 0");
      L.push("");
    }
  }

  function banner(L, opts, mode) {
    L.push("@echo off");
    L.push("setlocal EnableExtensions DisableDelayedExpansion");
    if (mode === "hybrid") L.push("rem Keep everything before the body marker 7-bit ASCII.");
    L.push("title " + opts.stem);
    L.push("rem ===========================================================================");
    L.push("rem  " + opts.stem + ".bat  (" + (mode === "hybrid" ? "self-read hybrid" : "echo") + " mode)");
    if (mode === "hybrid") {
      L.push("rem  The PowerShell body is stored verbatim after the marker at the end of");
      L.push("rem  this file. cmd never parses it: PowerShell reads this file as UTF-8,");
      L.push("rem  extracts the body," + (opts.hash ? " verifies its SHA-256," : "") + " writes it to %TEMP% as a UTF-8 .ps1,");
      L.push("rem  runs it with -File" + (opts.del ? ", then deletes it." : "."));
      L.push("rem  >>> SAVE THIS FILE AS UTF-8 WITHOUT BOM <<<");
    } else {
      L.push("rem  The script is written to %TEMP% as echo lines" + (opts.hash ? ", verified by SHA-256," : ",") + " run");
      L.push("rem  in 64-bit PowerShell with -File" + (opts.del ? ", then deleted." : "."));
    }
    L.push("rem  Exit codes: 0 ok; the script's own code when it ran; " + CODES.notAdmin + " not admin;");
    L.push("rem  " + CODES.badFolder + " bad folder; " + CODES.noPowerShell + " no PowerShell; " + CODES.writeVerify + " write or verify failed.");
    L.push("rem ===========================================================================");
    L.push('set "SELF=%~f0"');
    L.push('set "BATDIR=%~dp0"');
    L.push('if "%BATDIR:~-1%"=="\\" set "BATDIR=%BATDIR:~0,-1%"');
    L.push('set "RC=0"');
    L.push("");
  }

  /* ================= ECHO MODE ================= */
  function buildEcho(lines, opts, hashPH) {
    var L = [];
    banner(L, opts, "echo");
    if (opts.hash) { L.push('set "EXPECTED_SHA256=' + hashPH + '"'); L.push(""); }
    psExe(L);
    preflight(L);
    if (opts.admin) elevationBlock(L);
    stampAndTemp(L, opts.stem);
    if (opts.log) logInit(L, opts.stem);

    L.push("rem ---- Write the script with echo, then check completeness ----------------");
    if (opts.log) L.push('call :log "Writing script to the temp file (' + lines.length + ' lines)"');
    L.push("call :write_ps1");
    L.push('if errorlevel 1 ( ' + err(opts, "Could not write to the temp folder.") + ' & set "RC=' + CODES.writeVerify + '" & goto :cleanup )');
    L.push('if not exist "%TMPPS1%" ( ' + err(opts, "Written script is missing - antivirus may have removed it.") + ' & set "RC=' + CODES.writeVerify + '" & goto :cleanup )');
    L.push('set "ACTUAL_LINES=0"');
    L.push('for /f %%C in (\'type "%TMPPS1%" ^| find /c /v ""\') do set "ACTUAL_LINES=%%C"');
    L.push('if not "%ACTUAL_LINES%"=="' + lines.length + '" ( ' + err(opts, "Incomplete write - expected " + lines.length + " lines, got %ACTUAL_LINES%.") + ' & set "RC=' + CODES.writeVerify + '" & goto :cleanup )');
    if (opts.hash) {
      L.push('"%PSEXE%" -NoProfile -NonInteractive -Command "try { $h=(Get-FileHash -LiteralPath $env:TMPPS1 -Algorithm SHA256 -ErrorAction Stop).Hash; if($h -ne $env:EXPECTED_SHA256){ exit 1 }; exit 0 } catch { exit 1 }"');
      L.push('if errorlevel 1 ( ' + err(opts, "SHA-256 mismatch; the .bat was edited or damaged.") + ' & set "RC=' + CODES.writeVerify + '" & goto :cleanup )');
      if (opts.log) L.push('call :log "SHA-256 verified."');
    }
    L.push("");
    runSection(L, opts);
    cleanupAndFinish(L, opts);

    L.push("rem ===========================================================================");
    L.push("rem  :write_ps1  -  one echo per line. %% = %, and ^ escapes & | < > ( ) ^");
    L.push("rem  outside double quotes. Edit the source and regenerate, not these lines.");
    L.push("rem ===========================================================================");
    L.push(":write_ps1");
    L.push('type nul > "%TMPPS1%" 2>nul || exit /b 1');
    for (var i = 0; i < lines.length; i++) L.push('>>"%TMPPS1%" echo(' + escLine(lines[i]));
    L.push("exit /b 0");
    return L.join("\r\n") + "\r\n";
  }

  /* ================= HYBRID MODE ================= */
  function buildHybrid(rawBody, opts, rest, hashPH) {
    var L = [];
    banner(L, opts, "hybrid");
    psExe(L);
    preflight(L);
    if (opts.admin) elevationBlock(L);
    stampAndTemp(L, opts.stem);
    if (opts.log) logInit(L, opts.stem);

    L.push("rem ---- Extract the body from this file and write it (PowerShell, UTF-8) ----");
    if (opts.log) L.push('call :log "Extracting and writing the script body"');
    var seg = [
      "$ErrorActionPreference='Stop';",
      "$t=[IO.File]::ReadAllText($env:SELF,[Text.Encoding]::UTF8);",
      "$m='#'+'" + rest + "';",
      "$i=$t.IndexOf($m,[StringComparison]::Ordinal);",
      "if($i -lt 0){[Console]::Error.WriteLine('ERROR: body marker not found.');exit " + CODES.writeVerify + "};",
      "$j=$t.IndexOf([char]10,$i);",
      "if($j -lt 0){[Console]::Error.WriteLine('ERROR: marker line has no terminator.');exit " + CODES.writeVerify + "};",
      "$b=$t.Substring($j+1);"
    ];
    if (opts.hash) {
      seg.push("$hash=[BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($b))).Replace('-','');");
      seg.push("if($hash -ne '" + hashPH + "'){[Console]::Error.WriteLine('ERROR: body SHA-256 mismatch - the file was edited or damaged.');exit " + CODES.writeVerify + "};");
    }
    seg.push("[IO.File]::WriteAllText($env:TMPPS1,$b,[Text.UTF8Encoding]::new($true));");
    seg.push("exit 0");
    L.push('"%PSEXE%" -NoLogo -NoProfile -Command ^');
    for (var k = 0; k < seg.length; k++) L.push('  "' + seg[k] + '"' + (k < seg.length - 1 ? " ^" : ""));
    L.push('if errorlevel 1 ( ' + err(opts, "Could not extract or verify the script body; see the message above.") + ' & set "RC=' + CODES.writeVerify + '" & goto :cleanup )');
    L.push('if not exist "%TMPPS1%" ( ' + err(opts, "Temp script is missing - antivirus may have removed it.") + ' & set "RC=' + CODES.writeVerify + '" & goto :cleanup )');
    if (opts.log) L.push('call :log "Body written and verified."');
    L.push("");
    runSection(L, opts);
    cleanupAndFinish(L, opts);

    L.push("rem ===========================================================================");
    L.push("rem  PowerShell body below, stored verbatim as UTF-8. Edit the source and");
    L.push("rem  regenerate" + (opts.hash ? " (the SHA-256 above covers this body)." : ".") + " cmd never reaches these lines.");
    L.push("rem ===========================================================================");
    L.push("#" + rest);
    // marker line is terminated by the CRLF the join adds; the raw body follows
    // verbatim so leading/trailing blank lines and original bytes are preserved.
    return L.join("\r\n") + "\r\n" + rawBody;
  }

  function err(opts, msg) { return opts.log ? ('call :log "ERROR: ' + msg + '"') : ('echo ERROR: ' + msg); }

  return {
    SPECIAL: SPECIAL, PH: PH, CODES: CODES, ECHO_LINE_BUDGET: ECHO_LINE_BUDGET,
    escLine: escLine, decLine: decLine, splitLines: splitLines,
    echoBodyText: echoBodyText, maxEchoLen: maxEchoLen,
    markerRest: markerRest, extractHybridBody: extractHybridBody,
    buildEcho: buildEcho, buildHybrid: buildHybrid
  };
});
