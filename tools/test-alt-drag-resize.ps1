param(
  [int]$Steps = 20,
  [int]$SampleMs = 80,
  [int]$Dx = 8,
  [int]$Dy = 4,
  [switch]$NoAlt
)

# NOTE: keep this file PURE ASCII.
# PowerShell 5.1 decodes BOM-less .ps1 as ANSI (GBK on this machine);
# any non-ASCII byte may corrupt nearby string literals.

$ErrorActionPreference = 'Continue'
$ROOT = 'E:\study_lujiajing\WorkSpace_MiniBrowser\MiniBrowser'

# --- 1. clean duplicate proxy env vars (upper/lower case clash breaks Start-Process) ---
foreach ($n in @('HTTPS_PROXY','https_proxy','HTTP_PROXY','http_proxy')) {
  Remove-Item ("Env:" + $n) -ErrorAction SilentlyContinue
}
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:ELECTRON_RUN_AS_NODE = ''

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  public struct RECT { public int L, T, R, B; }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const byte VK_MENU = 0x12, VK_LBUTTON = 0x01;
  public const uint KEYUP = 0x0002;
  public static void AltDown() { keybd_event(VK_MENU, 0, 0, IntPtr.Zero); }
  public static void AltUp()   { keybd_event(VK_MENU, 0, KEYUP, IntPtr.Zero); }
}
"@

function Get-Bounds($h) {
  $r = New-Object M+RECT
  [M]::GetWindowRect($h, [ref]$r) | Out-Null
  return [pscustomobject]@{ X=$r.L; Y=$r.T; W=($r.R-$r.L); H=($r.B-$r.T) }
}

# --- 2. launch the app ---
Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
$udd = 'C:\Users\lujiajing\AppData\Local\Temp\mb-drag-udd-' + [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
$exe = Join-Path $ROOT 'node_modules\electron\dist\electron.exe'
$env:MB_DRAG_DEBUG = '1'
$outLog = Join-Path $ROOT 'mb-drag-debug.log'
Start-Process -FilePath $exe -ArgumentList '.', ("--user-data-dir=" + $udd) -WorkingDirectory $ROOT `
  -RedirectStandardOutput $outLog -RedirectStandardError ($outLog + '.err') | Out-Null

# --- 3. wait for the window ---
$proc = $null
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  $proc = Get-Process electron -ErrorAction SilentlyContinue |
          Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like '*MiniBrowser*' } |
          Select-Object -First 1
  if ($proc) { break }
}
if (-not $proc) { Write-Output "NO_WINDOW_AFTER_START"; exit 1 }

$h = $proc.MainWindowHandle
[M]::SetForegroundWindow($h) | Out-Null
Start-Sleep -Milliseconds 600

$b0 = Get-Bounds $h
Write-Output ("START   x={0} y={1} w={2} h={3}" -f $b0.X, $b0.Y, $b0.W, $b0.H)

# --- 4. Alt + left-drag ---
$sx = $b0.X + [int]($b0.W * 0.5)
$sy = $b0.Y + [int]($b0.H * 0.5)
[M]::SetCursorPos($sx, $sy) | Out-Null
Start-Sleep -Milliseconds 500

if (-not $NoAlt) { [M]::AltDown(); Start-Sleep -Milliseconds 350 }
[M]::mouse_event([M]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300

$prev = Get-Bounds $h
$sizeChanges = 0
for ($i = 1; $i -le $Steps; $i++) {
  [M]::SetCursorPos(($sx + $i * $Dx), ($sy + $i * $Dy)) | Out-Null
  Start-Sleep -Milliseconds $SampleMs
  $b = Get-Bounds $h
  $dw = $b.W - $prev.W; $dh = $b.H - $prev.H
  if ($dw -ne 0 -or $dh -ne 0) {
    $sizeChanges++
    Write-Output ("  RESIZE at step{0}: x={1} y={2} w={3} h={4}  dW={5} dH={6}" -f $i, $b.X, $b.Y, $b.W, $b.H, $dw, $dh)
  }
  $prev = $b
}

[M]::mouse_event([M]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 250
if (-not $NoAlt) { [M]::AltUp() }
Start-Sleep -Milliseconds 500

$b1 = Get-Bounds $h
Write-Output ("END     x={0} y={1} w={2} h={3}" -f $b1.X, $b1.Y, $b1.W, $b1.H)
Write-Output ("SUMMARY sizeChanges={0}  totalDW={1} totalDH={2}  movedX={3} movedY={4}" -f `
  $sizeChanges, ($b1.W - $b0.W), ($b1.H - $b0.H), ($b1.X - $b0.X), ($b1.Y - $b0.Y))

$alive = Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object
Write-Output ("ALIVE_AFTER_DRAG windows={0}" -f $alive.Count)

if (Test-Path $outLog) {
  Write-Output ""
  Write-Output "----- 应用日志已写入 mb-drag-debug.log -----"
}

Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
exit 0
