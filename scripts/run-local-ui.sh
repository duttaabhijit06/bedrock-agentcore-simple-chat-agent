#!/bin/bash
set -euo pipefail

# ─── Party Supply Chat Agent - Run UI Locally ────────────────────────────────
# Starts the chat UI dev server.
# Ensures .env.local is configured with the gateway URL before starting.
#
# Usage:
#   ./scripts/run-ui.sh
#   ./scripts/run-ui.sh --port 3000

REGION="${AWS_REGION:-us-west-2}"
PORT="${1:-5173}"

# Strip --port flag if provided
if [ "${1:-}" = "--port" ]; then
  PORT="${2:-5173}"
fi

echo ""
echo "🎉 Party Supply Chat Agent - UI"
echo ""

# ─── Check dependencies ─────────────────────────────────────────────────────

if [ ! -d "chat-ui/node_modules" ]; then
  echo "  Installing chat-ui dependencies..."
  npm install --prefix chat-ui
  echo ""
fi

# ─── Ensure .env.local exists with gateway URL ───────────────────────────────

if [ ! -f "chat-ui/.env.local" ] || ! grep -q "VITE_GATEWAY_URL=https://" chat-ui/.env.local 2>/dev/null; then
  echo "  Gateway URL not configured. Fetching from deployment..."

  # Try to get gateway ID
  GATEWAY_ID=""
  if command -v agentcore >/dev/null 2>&1 || [ -f "node_modules/.bin/agentcore" ]; then
    GATEWAY_ID=$(npx agentcore status 2>&1 | grep -o '([^)]*' | grep 'partysupply' | sed 's/(//' | head -1 || echo "")
  fi

  if [ -z "$GATEWAY_ID" ]; then
    GATEWAY_ID=$(aws bedrock-agentcore-control list-gateways --region "${REGION}" \
      --query "items[?contains(name, 'PartySupply')].gatewayId | [0]" \
      --output text 2>/dev/null || echo "None")
  fi

  if [ -z "$GATEWAY_ID" ] || [ "$GATEWAY_ID" = "None" ]; then
    echo "  ❌ Gateway not found. Run ./scripts/deploy.sh --all first."
    exit 1
  fi

  GATEWAY_URL="https://${GATEWAY_ID}.gateway.bedrock-agentcore.${REGION}.amazonaws.com"

  cat > chat-ui/.env.local <<EOF
VITE_GATEWAY_URL=${GATEWAY_URL}
VITE_AWS_REGION=${REGION}
EOF

  echo "  Gateway URL: ${GATEWAY_URL}"
  echo "  Written to chat-ui/.env.local"
  echo ""
fi

# ─── Start dev server ────────────────────────────────────────────────────────

echo "  Starting Vite dev server on port ${PORT}..."
echo "  Open: http://localhost:${PORT}"
echo ""

cd chat-ui
npx vite --port "${PORT}"
