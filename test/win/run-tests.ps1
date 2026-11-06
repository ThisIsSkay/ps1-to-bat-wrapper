<#
  Windows runtime test harness for the PS1 to BAT Wrapper.
  Generates launchers with gen-cli.js and ACTUALLY RUNS them, then checks
  behavior against real cmd.exe + Windows PowerShell. Run on a Windows host
  (locally or via .github/workflows/test.yml).

      powershell -ExecutionPolicy Bypass -File test\win\run-tests.ps1

  Not covered here (cannot be exercised headlessly): interactive UAC accept/
  cancel, antivirus removing the temp file. The admin code path is exercised
  only when this harness itself runs elevated.
#>
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$gen  = Join-Path $root 'gen-cli.js'
$scratch = Join-Path ([IO.Path]::GetTempPath()) ('ps1bat_' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $scratch -Force | Out-Null

$pass = 0; $fail = 0
function Ok($n){ $script:pass++; Write-Host "  ok   $n" -ForegroundColor Green }
function Bad($n,$why){ $script:fail++; Write-Host "  FAIL $n`n       $why" -ForegroundColor Red }
function Check($n,$cond,$why){ if($cond){ Ok $n } else { Bad $n $why } }

function New-Ps1([string]$name,[string]$content){
  $p = Join-Path $scratch ($name + '.ps1')
  [IO.File]::WriteAllText($p, $content, (New-Object Text.UTF8Encoding($false)))
  return $p
}
function Gen([string]$mode,[string]$ps1,[string]$bat,[string[]]$extra){
  $args = @('--mode',$mode,'--in',$ps1,'--out',$bat,'--no-pause') + $extra
  & node $gen @args 2>$null
  if($LASTEXITCODE -ne 0){ throw "gen-cli failed ($LASTEXITCODE) for $bat" }
}
# Run a .bat with an isolated TEMP so cleanup assertions are reliable.
function Run-Bat([string]$bat,[string]$resultFile){
  $tmp = Join-Path $scratch ('tmp_' + [guid]::NewGuid().ToString('N').Substring(0,8))
  New-Item -ItemType Directory -Path $tmp -Force | Out-Null
  $old = $env:TEMP; $oldt = $env:TMP; $oldr = $env:RESULT
  $env:TEMP = $tmp; $env:TMP = $tmp; $env:RESULT = $resultFile
  try { & cmd.exe /c "`"$bat`"" | Out-Null; $code = $LASTEXITCODE }
  finally { $env:TEMP = $old; $env:TMP = $oldt; $env:RESULT = $oldr }
  $left = @(Get-ChildItem -Path $tmp -Filter *.ps1 -ErrorAction SilentlyContinue)
  return [pscustomobject]@{ Code = $code; TempDir = $tmp; LeftoverPs1 = $left.Count }
}

Write-Host "PS1-to-BAT Windows runtime tests"
Write-Host ("PowerShell: {0}; elevated: {1}" -f $PSVersionTable.PSVersion, `
  ([bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)))

# 1 — echo ASCII success + exit-code 0
try{
  $ps1 = New-Ps1 'ok' 'Set-Content -LiteralPath $env:RESULT -Value "OK" -Encoding ascii; exit 0'
  $bat = Join-Path $scratch 'ok.bat'; Gen echo $ps1 $bat @('--no-admin','--no-log')
  $res = Join-Path $scratch 'ok.txt'; $r = Run-Bat $bat $res
  Check 'echo: success exits 0 and script ran' (($r.Code -eq 0) -and ((Get-Content $res -Raw).Trim() -eq 'OK')) "code=$($r.Code)"
}catch{ Bad 'echo success' $_.Exception.Message }

# 2 — echo preserves cmd metacharacters through real cmd
try{
  $want = 'A & B | C < D > E (F) 100% ^caret "q"'
  $ps1 = New-Ps1 'meta' ('$s = ''' + ($want -replace "'","''") + '''' + "`r`n" + '[IO.File]::WriteAllText($env:RESULT,$s)')
  $bat = Join-Path $scratch 'meta.bat'; Gen echo $ps1 $bat @('--no-admin','--no-log')
  $res = Join-Path $scratch 'meta.txt'; $r = Run-Bat $bat $res
  $got = [IO.File]::ReadAllText($res)
  Check 'echo: metacharacters survive real cmd' (($r.Code -eq 0) -and ($got -eq $want)) "got=[$got]"
}catch{ Bad 'echo metacharacters' $_.Exception.Message }

# 3 — echo propagates a custom exit code (Finding E)
try{
  $ps1 = New-Ps1 'ex42' 'exit 42'
  $bat = Join-Path $scratch 'ex42.bat'; Gen echo $ps1 $bat @('--no-admin','--no-log')
  $r = Run-Bat $bat (Join-Path $scratch 'x.txt')
  Check 'echo: exit 42 propagates (not flattened to 5)' ($r.Code -eq 42) "code=$($r.Code)"
}catch{ Bad 'echo exit propagation' $_.Exception.Message }

# 4 — throw yields non-zero
try{
  $ps1 = New-Ps1 'throw' 'throw "boom"'
  $bat = Join-Path $scratch 'throw.bat'; Gen echo $ps1 $bat @('--no-admin','--no-log')
  $r = Run-Bat $bat (Join-Path $scratch 'x.txt')
  Check 'echo: throw yields non-zero exit' ($r.Code -ne 0) "code=$($r.Code)"
}catch{ Bad 'echo throw' $_.Exception.Message }

# 5 — hybrid preserves UTF-8 (accents, CJK, emoji, box-drawing)
try{
  $want = "Caf" + [char]0x00E9 + " " + [char]0x201C + "ok" + [char]0x201D + " " + [char]0x2500 + " " + [char]0x4F60 + [char]0x597D + " " + [char]::ConvertFromUtf32(0x1F600)
  $ps1content = '$s = "' + ($want -replace '"','`"') + '"' + "`r`n" + '[IO.File]::WriteAllText($env:RESULT,$s,(New-Object Text.UTF8Encoding($false)))'
  $ps1 = New-Ps1 'uni' $ps1content
  $bat = Join-Path $scratch 'uni.bat'; Gen hybrid $ps1 $bat @('--no-admin','--no-log')
  $res = Join-Path $scratch 'uni.txt'; $r = Run-Bat $bat $res
  $got = [IO.File]::ReadAllText($res, [Text.Encoding]::UTF8)
  Check 'hybrid: UTF-8 (accents/CJK/emoji/box) preserved end-to-end' (($r.Code -eq 0) -and ($got -eq $want)) "got=[$got]"
}catch{ Bad 'hybrid unicode' $_.Exception.Message }

# 6 — hybrid honors #requires + param() + arguments
try{
  $ps1 = New-Ps1 'param' "#requires -Version 5.1`r`nparam([string]`$Name='DEF')`r`nSet-Content -LiteralPath `$env:RESULT -Value `$Name -Encoding ascii"
  $bat = Join-Path $scratch 'param.bat'; Gen hybrid $ps1 $bat @('--no-admin','--no-log','--args','-Name CI')
  $res = Join-Path $scratch 'param.txt'; $r = Run-Bat $bat $res
  Check 'hybrid: #requires + param + args work' (($r.Code -eq 0) -and ((Get-Content $res -Raw).Trim() -eq 'CI')) "code=$($r.Code) val=$((Get-Content $res -Raw).Trim())"
}catch{ Bad 'hybrid param/args' $_.Exception.Message }

# 7 — hybrid with leading/trailing blank lines + hash ON (Finding A)
try{
  $ps1content = "`r`n`r`nSet-Content -LiteralPath `$env:RESULT -Value 'HI' -Encoding ascii`r`n`r`n"
  $ps1 = New-Ps1 'blanks' $ps1content
  $bat = Join-Path $scratch 'blanks.bat'; Gen hybrid $ps1 $bat @('--no-admin','--no-log')
  $res = Join-Path $scratch 'blanks.txt'; $r = Run-Bat $bat $res
  Check 'hybrid: leading/trailing blanks do not break the hash' (($r.Code -eq 0) -and ((Get-Content $res -Raw).Trim() -eq 'HI')) "code=$($r.Code)"
}catch{ Bad 'hybrid blank lines' $_.Exception.Message }

# 8 — hash mismatch is detected (tamper the body, keep old hash) → 204
try{
  $ps1 = New-Ps1 'tamper' "Set-Content -LiteralPath `$env:RESULT -Value 'SHOULD-NOT-RUN' -Encoding ascii"
  $bat = Join-Path $scratch 'tamper.bat'; Gen hybrid $ps1 $bat @('--no-admin','--no-log')
  $txt = [IO.File]::ReadAllText($bat, [Text.Encoding]::UTF8)
  $txt = $txt -replace 'SHOULD-NOT-RUN','SHOULD-NOT-RUN-X'      # alter body, hash now stale
  [IO.File]::WriteAllText($bat, $txt, (New-Object Text.UTF8Encoding($false)))
  $res = Join-Path $scratch 'tamper.txt'; if(Test-Path $res){Remove-Item $res}
  $r = Run-Bat $bat $res
  Check 'hybrid: tampered body fails SHA-256 (exit 204, script did not run)' (($r.Code -eq 204) -and (-not (Test-Path $res))) "code=$($r.Code) ran=$(Test-Path $res)"
}catch{ Bad 'hash mismatch' $_.Exception.Message }

# 9 — echo without hash still runs
try{
  $ps1 = New-Ps1 'nohash' 'Set-Content -LiteralPath $env:RESULT -Value "NH" -Encoding ascii; exit 0'
  $bat = Join-Path $scratch 'nohash.bat'; Gen echo $ps1 $bat @('--no-admin','--no-log','--no-hash')
  $res = Join-Path $scratch 'nohash.txt'; $r = Run-Bat $bat $res
  Check 'echo: runs with SHA-256 verification off' (($r.Code -eq 0) -and ((Get-Content $res -Raw).Trim() -eq 'NH')) "code=$($r.Code)"
}catch{ Bad 'echo no-hash' $_.Exception.Message }

# 10 — temp cleanup: deletes by default, keeps with --no-del
try{
  $ps1 = New-Ps1 'clean' 'exit 0'
  $batD = Join-Path $scratch 'clean_del.bat'; Gen hybrid $ps1 $batD @('--no-admin','--no-log')
  $rD = Run-Bat $batD (Join-Path $scratch 'x.txt')
  $batK = Join-Path $scratch 'clean_keep.bat'; Gen hybrid $ps1 $batK @('--no-admin','--no-log','--no-del')
  $rK = Run-Bat $batK (Join-Path $scratch 'x.txt')
  Check 'cleanup: deletes temp by default, keeps it with --no-del' (($rD.LeftoverPs1 -eq 0) -and ($rK.LeftoverPs1 -ge 1)) "del=$($rD.LeftoverPs1) keep=$($rK.LeftoverPs1)"
}catch{ Bad 'temp cleanup' $_.Exception.Message }

# 11 — logging from a read-only folder does not block the run (Finding D)
try{
  $ro = Join-Path $scratch 'readonly'; New-Item -ItemType Directory -Path $ro -Force | Out-Null
  $ps1 = New-Ps1 'rolog' 'Set-Content -LiteralPath $env:RESULT -Value "RO" -Encoding ascii; exit 0'
  $bat = Join-Path $ro 'rolog.bat'; Gen hybrid $ps1 $bat @('--no-admin')   # logging ON
  # deny write to the folder for the current user
  $acl = Get-Acl $ro
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($env:USERNAME,'Write','Deny')
  $acl.AddAccessRule($rule); Set-Acl $ro $acl
  $res = Join-Path $scratch 'rolog.txt'
  $r = Run-Bat $bat $res
  # cleanup ACL so the scratch dir can be removed
  $acl2 = Get-Acl $ro; $acl2.RemoveAccessRule($rule) | Out-Null; Set-Acl $ro $acl2
  Check 'logging: read-only folder falls back to TEMP, run still succeeds' (($r.Code -eq 0) -and ((Get-Content $res -Raw).Trim() -eq 'RO')) "code=$($r.Code)"
}catch{ Bad 'readonly log (best-effort)' $_.Exception.Message }

# 12 — admin path (only meaningful when already elevated)
try{
  $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
  if($elevated){
    $ps1 = New-Ps1 'adm' 'Set-Content -LiteralPath $env:RESULT -Value "ADM" -Encoding ascii; exit 0'
    $bat = Join-Path $scratch 'adm.bat'; Gen hybrid $ps1 $bat @('--no-log')   # admin ON
    $res = Join-Path $scratch 'adm.txt'; $r = Run-Bat $bat $res
    Check 'admin: already-elevated run proceeds inline' (($r.Code -eq 0) -and ((Get-Content $res -Raw).Trim() -eq 'ADM')) "code=$($r.Code)"
  } else {
    Write-Host "  skip admin path (harness not elevated; UAC cannot be tested headlessly)" -ForegroundColor Yellow
  }
}catch{ Bad 'admin path' $_.Exception.Message }

Write-Host ""
Write-Host ("{0} passed, {1} failed" -f $pass, $fail) -ForegroundColor ($(if($fail){'Red'}else{'Green'}))
try { Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue } catch {}
if($fail){ exit 1 } else { exit 0 }
