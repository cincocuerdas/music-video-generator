#!/bin/bash
set -e

API_URL="${API_URL:-http://localhost:3000/api/v1}"

echo ""
echo "============================================================"
echo "  Music Video Generator - E2E Pipeline Test"
echo "============================================================"
echo ""

echo "[Step 1] Health check"
curl -s "${API_URL}/health"
echo ""
echo ""

echo "[Step 2] Login dev session..."
TOKEN_RESPONSE=$(curl -s -X POST "${API_URL}/auth/login/dev" \
  -H "Content-Type: application/json" \
  -d '{"userId":"00000000-0000-4000-8000-000000000001"}')

TOKEN=$(echo "$TOKEN_RESPONSE" | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')

if [ -z "$TOKEN" ]; then
  echo "Failed to obtain token from /auth/login/dev"
  echo "Response: $TOKEN_RESPONSE"
  exit 1
fi

echo "Token acquired."
echo ""

echo "[Step 3] Creating test project..."
PROJECT_RESPONSE=$(curl -s -X POST "${API_URL}/projects" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d '{"title":"Test Music Video","visualStyle":"cinematic"}')

echo "Response: $PROJECT_RESPONSE"
PROJECT_ID=$(echo "$PROJECT_RESPONSE" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')

if [ -z "$PROJECT_ID" ]; then
  echo "Could not extract project id. Copy manually from response."
  read -r -p "Project ID: " PROJECT_ID
fi

echo ""
echo "[Step 4] Starting pipeline for project ${PROJECT_ID}..."
curl -s -X POST "${API_URL}/jobs/pipeline/${PROJECT_ID}/start" \
  -H "Authorization: Bearer ${TOKEN}"
echo ""
echo ""

echo "[Step 5] Polling pipeline status (Ctrl+C to stop)"
while true; do
  curl -s "${API_URL}/jobs/pipeline/${PROJECT_ID}" \
    -H "Authorization: Bearer ${TOKEN}"
  echo ""
  sleep 3
done
