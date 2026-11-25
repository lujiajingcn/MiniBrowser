param(
  [int]$StartX = 0,
  [int]$StartY = 0,
  [int]$Steps = 24,
  [int]$StepDelayMs = 70,
  [int]$Dx = 10,
  [int]$Dy = 5,
  [int]$HoldMs = 300
)

# NOTE: keep this file PURE ASCII.
# PowerShell 5.1 decodes BOM-less .ps1 as ANSI (GBK on this machine);
# any non-ASCII byte may corrupt nearby string literals.
#
# IMPORTANT: Alt must be pressed with keybd_event(VK_MENU), NOT mouse_event's
# MOUSEEVENTF_ALT flag -- that flag does not generate a keydown, so the app
# never sees altKey=true and the drag never starts.

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class M {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const byte VK_MENU = 0x12;
  public const uint KEYUP = 0x0002;
  public static void AltDown() { keybd_event(VK_MENU, 0, 0, IntPtr.Zero); }
  public static void AltUp()   { keybd_event(VK_MENU, 0, KEYUP, IntPtr.Zero); }
}
"@

if ($StartX -le 0) { Write-Output "NO_START"; exit 1 }

[M]::SetCursorPos($StartX, $StartY) | Out-Null
Start-Sleep -Milliseconds 400

[M]::AltDown()
Start-Sleep -Milliseconds $HoldMs
[M]::mouse_event([M]::LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds $HoldMs

for ($i = 1; $i -le $Steps; $i++) {
  [M]::SetCursorPos(($StartX + $i * $Dx), ($StartY + $i * $Dy)) | Out-Null
  Start-Sleep -Milliseconds $StepDelayMs
}

[M]::mouse_event([M]::LEFTUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 200
[M]::AltUp()
Start-Sleep -Milliseconds 200

Write-Output "DRAG_DONE"
