@echo off
REM ═══════════════════════════════════════════════════════════════════════════
REM Music Video Generator - Environment Setup Script (Windows)
REM ═══════════════════════════════════════════════════════════════════════════

echo.
echo 🎬 Music Video Generator - Setup
echo =================================

REM 1. Check prerequisites
echo.
echo [1/6] Checking prerequisites...

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ❌ Node.js is not installed. Please install Node.js 20+
    exit /b 1
)
for /f "tokens=*" %%i in ('node -v') do echo ✅ Node.js %%i

where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ❌ Python is not installed. Please install Python 3.11+
    exit /b 1
)
for /f "tokens=*" %%i in ('python --version') do echo ✅ %%i

REM 2. Create scripts directory structure
echo.
echo [2/6] Creating scripts directory structure...
if not exist "scripts\analysis" mkdir scripts\analysis
if not exist "scripts\images" mkdir scripts\images
if not exist "scripts\video" mkdir scripts\video
echo ✅ Scripts directories created

REM 3. Create Python virtual environment
echo.
echo [3/6] Creating Python virtual environment...
if not exist "scripts\venv" (
    python -m venv scripts\venv
    echo ✅ Virtual environment created
) else (
    echo ⏭️  Virtual environment already exists
)

REM 4. Activate venv and install dependencies
echo.
echo [4/6] Installing Python dependencies...
call scripts\venv\Scripts\activate.bat

REM Upgrade pip
python -m pip install --upgrade pip >nul

REM Install base dependencies (uncomment for production)
REM pip install spacy lingua-language-detector replicate ffmpeg-python boto3 pillow

echo ✅ Python environment ready

REM 5. Install Node.js dependencies
echo.
echo [5/6] Installing Node.js dependencies...
call npm install
echo ✅ Node.js dependencies installed

REM 6. Setup environment file
echo.
echo [6/6] Setting up environment...
if not exist ".env" (
    copy .env.example .env >nul
    echo ✅ .env file created from .env.example
) else (
    echo ⏭️  .env file already exists
)

REM Done
echo.
echo ════════════════════════════════════════════
echo ✅ Setup complete!
echo ════════════════════════════════════════════
echo.
echo Next steps:
echo   1. Configure your .env file (DATABASE_URL, REDIS_HOST, etc.)
echo   2. Start PostgreSQL and Redis
echo   3. Run database migrations: npm run db:migrate
echo   4. Generate Prisma client: npm run db:generate
echo   5. Start the server: npm run start:dev
echo.
echo To test the pipeline:
echo   e2e-test.bat
echo.

pause
