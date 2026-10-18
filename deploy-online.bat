@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it free from https://nodejs.org then run this again.
  pause
  exit /b 1
)
if not exist public mkdir public

rem -- always deploy THIS folder's flowboard.html --
if not exist "flowboard.html" (
  echo Could not find flowboard.html in %cd%
  pause
  exit /b 1
)

echo Copying this folder's flowboard.html into the site...
copy /Y "flowboard.html" public\index.html >nul

rem Force browsers / CDN to revalidate HTML so deploys show up after refresh
> public\_headers (
  echo /
  echo   Cache-Control: no-store
  echo /index.html
  echo   Cache-Control: no-store
)

for %%A in (flowboard.html) do echo Source size: %%~zA bytes  modified %%~tA

echo Deploying to Cloudflare (a browser window will open to log in the first time)...
call npx wrangler@latest deploy
if errorlevel 1 (
  echo.
  echo *** DEPLOY FAILED - scroll up to see the error. The live board was NOT updated. ***
) else (
  echo.
  echo Deploy finished OK.
  echo Open a PRIVATE/INCOGNITO window to:
  echo   https://flowboard.<your-subdomain>.workers.dev/?v=%RANDOM%
  echo Or hard-refresh: Ctrl+Shift+R  ^(if you still see "Edit board" you are on a cached tab^)
)
pause
