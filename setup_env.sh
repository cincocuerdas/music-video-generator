#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Music Video Generator - Environment Setup Script (Unix/macOS)
# ═══════════════════════════════════════════════════════════════════════════

set -e

echo "🎬 Music Video Generator - Setup"
echo "================================="

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 1. Check prerequisites
echo -e "\n${YELLOW}[1/6] Checking prerequisites...${NC}"

if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed. Please install Node.js 20+"
    exit 1
fi
echo "✅ Node.js $(node -v)"

if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 is not installed. Please install Python 3.11+"
    exit 1
fi
echo "✅ Python $(python3 --version)"

# 2. Create scripts directory structure
echo -e "\n${YELLOW}[2/6] Creating scripts directory structure...${NC}"
mkdir -p scripts/analysis
mkdir -p scripts/images
mkdir -p scripts/video
echo "✅ Scripts directories created"

# 3. Create Python virtual environment
echo -e "\n${YELLOW}[3/6] Creating Python virtual environment...${NC}"
if [ ! -d "scripts/venv" ]; then
    python3 -m venv scripts/venv
    echo "✅ Virtual environment created"
else
    echo "⏭️  Virtual environment already exists"
fi

# 4. Activate venv and install dependencies
echo -e "\n${YELLOW}[4/6] Installing Python dependencies...${NC}"
source scripts/venv/bin/activate

# Upgrade pip
pip install --upgrade pip > /dev/null

# Install LLM dependencies
echo "Installing LLM packages (anthropic, openai)..."
pip install anthropic openai > /dev/null 2>&1

# Install image generation dependencies
echo "Installing image generation packages (replicate)..."
pip install replicate > /dev/null 2>&1

# Install video rendering dependencies
echo "Installing video rendering packages (ffmpeg-python, requests)..."
pip install ffmpeg-python requests > /dev/null 2>&1

echo "✅ Python environment ready"

# Check FFmpeg
if command -v ffmpeg &> /dev/null; then
    echo "✅ FFmpeg is installed: $(ffmpeg -version 2>&1 | head -n1)"
else
    echo -e "${YELLOW}⚠️  FFmpeg not found. Install it:${NC}"
    echo "   Ubuntu: sudo apt install ffmpeg"
    echo "   macOS: brew install ffmpeg"
fi

# 5. Set execution permissions for Python scripts
echo -e "\n${YELLOW}[5/6] Setting script permissions...${NC}"
find scripts -name "*.py" -exec chmod +x {} \;
echo "✅ Script permissions set"

# 6. Install Node.js dependencies
echo -e "\n${YELLOW}[6/6] Installing Node.js dependencies...${NC}"
npm install
echo "✅ Node.js dependencies installed"

# 7. Setup environment file
echo -e "\n${YELLOW}[7/7] Setting up environment...${NC}"
if [ ! -f ".env" ]; then
    cp .env.example .env
    echo "✅ .env file created from .env.example"
else
    echo "⏭️  .env file already exists"
fi

# Done
echo -e "\n${GREEN}════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ Setup complete!${NC}"
echo -e "${GREEN}════════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo "  1. Configure your .env file (DATABASE_URL, REDIS_HOST, etc.)"
echo "  2. Start PostgreSQL and Redis"
echo "  3. Run database migrations: npm run db:migrate"
echo "  4. Generate Prisma client: npm run db:generate"
echo "  5. Start the server: npm run start:dev"
echo ""
echo "To test the pipeline:"
echo "  ./e2e-test.sh"
echo ""
