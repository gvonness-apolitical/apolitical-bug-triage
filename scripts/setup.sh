#!/bin/bash
# Setup script for new developers

set -e

echo "=== Apolitical Bug Triage Setup ==="
echo

# Check Node version
NODE_VERSION=$(node -v 2>/dev/null | cut -d'v' -f2 | cut -d'.' -f1)
if [ -z "$NODE_VERSION" ] || [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Node.js 20+ required. Current: $(node -v 2>/dev/null || echo 'not installed')"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Check git-crypt
if ! command -v git-crypt &> /dev/null; then
  echo "❌ git-crypt not installed. Run: brew install git-crypt"
  exit 1
fi
echo "✓ git-crypt installed"

# Check if repo is unlocked
if git-crypt status 2>/dev/null | grep -q "encrypted:"; then
  if file test-data/historical-messages.json 2>/dev/null | grep -q "ASCII"; then
    echo "✓ git-crypt unlocked"
  else
    echo "⚠️  git-crypt locked. Get the key from apolitical-assistant:"
    echo "   cd ../apolitical-assistant && git-crypt export-key /tmp/key"
    echo "   cd ../apolitical-bug-triage && git-crypt unlock /tmp/key && rm /tmp/key"
    exit 1
  fi
fi

# Install dependencies
echo
echo "Installing dependencies..."
npm install

# Check keychain credentials
echo
echo "Checking keychain credentials..."
MISSING=""

check_credential() {
  if security find-generic-password -a "claude" -s "$1" -w &>/dev/null; then
    echo "✓ $1"
  else
    echo "❌ $1 missing"
    MISSING="$MISSING $1"
  fi
}

check_credential "ANTHROPIC_API_KEY"
check_credential "SLACK_TOKEN"
check_credential "LINEAR_API_KEY"

if [ -n "$MISSING" ]; then
  echo
  echo "Missing credentials. Add with:"
  for cred in $MISSING; do
    echo "  security add-generic-password -a \"claude\" -s \"$cred\" -w \"your-key-here\""
  done
  exit 1
fi

echo
echo "=== Setup Complete ==="
echo
echo "Quick start:"
echo "  npm run triage:dry          # Test run (read-only)"
echo "  npm run eval:run:opus       # Run prompt evaluation"
echo
