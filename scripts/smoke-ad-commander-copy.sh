#!/usr/bin/env bash
# Smoke test for POST /v1/ad-commander/creatives/draft
#
# Usage:
#   ./scripts/smoke-ad-commander-copy.sh <api-key> <ads-account-id> <mode>
#
# Examples:
#   ./scripts/smoke-ad-commander-copy.sh etrn_xxx a0ca9111-628f-44e5-82c7-3d2e5d6ee2e3 scaffold
#   ./scripts/smoke-ad-commander-copy.sh etrn_xxx a0ca9111-628f-44e5-82c7-3d2e5d6ee2e3 from_winners

set -euo pipefail

API_KEY="${1:?Usage: $0 <api-key> <ads-account-id> <mode>}"
ADS_ACCOUNT_ID="${2:?Usage: $0 <api-key> <ads-account-id> <mode>}"
MODE="${3:-scaffold}"
BASE_URL="${BASE_URL:-https://api.eternium.ai}"

echo "=== Ad Commander Copy Generation Smoke Test ==="
echo "Endpoint: ${BASE_URL}/v1/ad-commander/creatives/draft"
echo "Account:  ${ADS_ACCOUNT_ID}"
echo "Mode:     ${MODE}"
echo ""

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "${BASE_URL}/v1/ad-commander/creatives/draft" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "{
    \"ads_account_id\": \"${ADS_ACCOUNT_ID}\",
    \"format\": \"link_ad\",
    \"product_description\": \"Utah law firm specializing in family mediation. \$500 flat-fee consult.\",
    \"target_audience\": \"Utah adults 30-55 searching for divorce mediation.\",
    \"mode\": \"${MODE}\"
  }")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | sed '$d')

echo "HTTP ${HTTP_CODE}"
echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
echo ""

if [ "$HTTP_CODE" = "200" ]; then
  echo "PASS"
elif [ "$HTTP_CODE" = "409" ] && [ "$MODE" = "from_winners" ]; then
  echo "PASS (insufficient history, expected for some accounts)"
else
  echo "FAIL (expected 200 or 409, got ${HTTP_CODE})"
  exit 1
fi
