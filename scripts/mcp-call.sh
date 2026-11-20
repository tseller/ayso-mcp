#!/usr/bin/env bash
# Drive the deployed billcom-mcp Streamable-HTTP endpoint with the static
# MCP_API_TOKEN (bypasses OAuth). Usage:
#   scripts/mcp-call.sh <tool_name> '<json args>'
#   scripts/mcp-call.sh --list
# MCP_ACCESS=viewer serves the read-only viewer's server instead (#78).
set -euo pipefail

URL="${MCP_URL:-https://billcom-mcp-733083913968.us-central1.run.app/mcp}"
TOKEN="${MCP_TOKEN:?set MCP_TOKEN}"
H_AUTH="Authorization: Bearer $TOKEN"
H_ACCEPT="Accept: application/json, text/event-stream"
H_CT="Content-Type: application/json"
H_ACCESS="X-Treasurer-Access: ${MCP_ACCESS:-full}"

HDRS=$(mktemp)
curl -sS -D "$HDRS" -o /dev/null -X POST "$URL" -H "$H_AUTH" -H "$H_ACCEPT" -H "$H_CT" -H "$H_ACCESS" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"repro","version":"0"}}}'
SID=$(grep -i '^mcp-session-id:' "$HDRS" | tr -d '\r' | awk '{print $2}')
rm -f "$HDRS"
[ -n "$SID" ] || { echo "no session id" >&2; exit 1; }

curl -sS -o /dev/null -X POST "$URL" -H "$H_AUTH" -H "$H_ACCEPT" -H "$H_CT" -H "$H_ACCESS" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}'

if [ "${1:-}" = "--list" ]; then
  BODY='{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
else
  TOOL="$1"; ARGS="${2:-}"; [ -n "$ARGS" ] || ARGS='{}'
  BODY=$(jq -cn --arg name "$TOOL" --argjson args "$ARGS" \
    '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:$name,arguments:$args}}')
fi

curl -sS -w '\n__HTTP_STATUS:%{http_code} TIME:%{time_total}s SIZE:%{size_download}\n' \
  -X POST "$URL" -H "$H_AUTH" -H "$H_ACCEPT" -H "$H_CT" -H "$H_ACCESS" -H "mcp-session-id: $SID" -d "$BODY"
