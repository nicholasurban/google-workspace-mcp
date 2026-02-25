#!/bin/sh
# Write credentials from env vars to files if they exist
# This allows Coolify to manage credentials via env vars
# without needing bind mounts

CRED_DIR="/app/credentials"
mkdir -p "$CRED_DIR"

# Service account key (base64-encoded in env var to avoid JSON escaping issues)
if [ -n "$GOOGLE_SA_KEY_BASE64" ]; then
  echo "$GOOGLE_SA_KEY_BASE64" | base64 -d > "$CRED_DIR/google-sa.json"
  echo "Wrote service account key to $CRED_DIR/google-sa.json"
fi

# Gmail tokens (base64-encoded)
if [ -n "$GOOGLE_TOKENS_BASE64" ]; then
  echo "$GOOGLE_TOKENS_BASE64" | base64 -d > "$CRED_DIR/gmail-tokens.json"
  echo "Wrote Gmail tokens to $CRED_DIR/gmail-tokens.json"
fi

exec node dist/index.js
