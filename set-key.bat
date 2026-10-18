@echo off
cd /d "%~dp0"
echo Choose a strong board key (like a password). Only people who have it can
echo see or edit your board. Your typing will be hidden.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
 "$a = Read-Host 'Enter board key   ' -AsSecureString;" ^
 "$b = Read-Host 'Repeat board key  ' -AsSecureString;" ^
 "$pa = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($a));" ^
 "$pb = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($b));" ^
 "if ($pa -ne $pb) { Write-Host ''; Write-Host 'The two entries do not match - nothing was changed. Run this again.'; exit 1 };" ^
 "if ($pa.Length -lt 8) { Write-Host ''; Write-Host 'Key too short (use at least 8 characters) - nothing was changed.'; exit 1 };" ^
 "Write-Host ''; Write-Host 'Saving the key to Cloudflare...';" ^
 "$pa | npx wrangler@latest secret put BOARD_KEY"
echo.
echo If it saved successfully, open your board at:
echo   https://flowboard.YOUR-SUBDOMAIN.workers.dev/#key=THE-KEY-YOU-CHOSE
echo (the deploy step printed your exact .workers.dev address)
pause
