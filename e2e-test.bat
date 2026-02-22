@echo off
setlocal enabledelayedexpansion

set API_URL=http://localhost:3000/api/v1
set TOKEN=

echo.
echo ============================================================
echo   Music Video Generator - E2E Pipeline Test
echo ============================================================
echo.

echo [Step 1] Health check
curl -s "%API_URL%/health"
echo.
echo.

echo [Step 2] Login dev session...
for /f "usebackq delims=" %%A in (`powershell -NoProfile -Command "$r=Invoke-RestMethod -Method Post -Uri '%API_URL%/auth/login/dev' -ContentType 'application/json' -Body '{\"userId\":\"00000000-0000-4000-8000-000000000001\"}'; $r.accessToken"`) do set TOKEN=%%A

if "%TOKEN%"=="" (
  echo Failed to obtain token from /auth/login/dev
  echo Check JWT_SECRET and server logs.
  exit /b 1
)

echo Token acquired.
echo.

echo [Step 3] Creating test project...
curl -s -X POST "%API_URL%/projects" ^
  -H "Content-Type: application/json" ^
  -H "Authorization: Bearer %TOKEN%" ^
  -d "{\"title\":\"Test Music Video\",\"visualStyle\":\"cinematic\"}"
echo.
echo.

set /p PROJECT_ID=Enter the Project ID from the response above: 

echo.
echo [Step 4] Starting pipeline for project %PROJECT_ID%...
curl -s -X POST "%API_URL%/jobs/pipeline/%PROJECT_ID%/start" ^
  -H "Authorization: Bearer %TOKEN%"
echo.
echo.

echo [Step 5] Polling pipeline status (Ctrl+C to stop)
:poll_loop
curl -s "%API_URL%/jobs/pipeline/%PROJECT_ID%" ^
  -H "Authorization: Bearer %TOKEN%"
echo.
timeout /t 3 /nobreak >nul
goto poll_loop
