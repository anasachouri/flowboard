@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it free from https://nodejs.org
  pause
  exit /b 1
)
if not exist "..\flowboard.html" (
  echo Missing ..\flowboard.html
  pause
  exit /b 1
)
if not exist public mkdir public

echo Building SaaS site from flowboard.html ...
node -e "const fs=require('fs');let h=fs.readFileSync('../flowboard.html','utf8');if(!h.includes('FLOWBOARD_SAAS')){console.error('flowboard.html missing SaaS mode');process.exit(1);}h=h.replace('<head>','<head><script>window.FLOWBOARD_SAAS=1</script>');fs.writeFileSync('public/index.html',h);fs.writeFileSync('public/_headers','/\n  Cache-Control: no-store\n/index.html\n  Cache-Control: no-store\n');try{fs.copyFileSync('../brand/logo.svg','public/logo.svg')}catch(e){}console.log('Built public/index.html',fs.statSync('public/index.html').size,'bytes');"

echo Deploying Worker "flowboard-saas" (does NOT touch your personal flowboard)...
call npx wrangler@latest deploy
if errorlevel 1 (
  echo.
  echo *** DEPLOY FAILED ***
) else (
  echo.
  echo SaaS experiment is live. Open the URL wrangler printed.
  echo 1^) Sign up with YOUR email first ^(you become admin^).
  echo 2^) Send the same URL to your friend to create their own account.
  echo 3^) Your personal board stays at flowboard.*.workers.dev unchanged.
)
pause
