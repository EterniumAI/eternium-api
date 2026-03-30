#!/bin/bash
# Eternium SDK — Publish to npm and PyPI
# Run this after: npm adduser (one-time npm login)

set -e

echo "═══════════════════════════════════════"
echo "  Eternium SDK Publisher"
echo "═══════════════════════════════════════"

# ── npm (JavaScript) ────────────────────
echo ""
echo "[1/2] Publishing JS SDK to npm..."
cd "$(dirname "$0")/sdk/js"

# Verify logged in
if ! npm whoami &>/dev/null; then
  echo "❌ Not logged into npm. Run: npm adduser"
  echo "   Then re-run this script."
  exit 1
fi

echo "  Package: eternium-sdk@$(node -p "require('./package.json').version")"
echo "  User: $(npm whoami)"
npm publish --access public
echo "  ✅ Published to npm!"

# ── PyPI (Python) ───────────────────────
echo ""
echo "[2/2] Publishing Python SDK to PyPI..."
cd "$(dirname "$0")/sdk/python"

# Check if build tools exist
if ! python3 -m build --version &>/dev/null; then
  echo "  Installing build tools..."
  pip3 install build twine
fi

# Build
python3 -m build --sdist --wheel
# Upload
python3 -m twine upload dist/* --skip-existing

echo "  ✅ Published to PyPI!"

echo ""
echo "═══════════════════════════════════════"
echo "  Done! Both SDKs are live."
echo "  npm: https://www.npmjs.com/package/eternium-sdk"
echo "  PyPI: https://pypi.org/project/eternium-sdk/"
echo "═══════════════════════════════════════"
