param(
  [int]$StartX = 0,
  [int]$StartY = 0,
  [int]$Steps = 20,
  [int]$StepDelayMs = 70,
  [int]$Dx = 8,
  [int]$Dy = 8
)

# NOTE: keep this file PURE ASCII.
# PowerShell 5.1 decodes BOM-less .ps1 as ANSI (GBK on this machine);
# any non-ASCII byte may corrupt nearby string literals.
#
# Real mouse drag with the button held down.
# The Alt key is intentionally NOT pressed here: this script is used to
# probe Chromium's border-resize hot zone directly.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
}
"@

if ($StartX -le 0) { Write-Output "NO_START"; exit 1 }

[M]::SetCursorPos($StartX, $StartY) | Out-Null
Start-Sleep -Milliseconds 400

[M]::mouse_event([M]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300

for ($i = 1; $i -le $Steps; $i++) {
  [M]::SetCursorPos(($StartX + $i * $Dx), ($StartY + $i * $Dy)) | Out-Null
  Start-Sleep -Milliseconds $StepDelayMs
}

[M]::mouse_event([M]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 300

Write-Output "DRAG_DONE"
