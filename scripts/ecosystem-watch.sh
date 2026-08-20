#!/usr/bin/env bash
# Ecosystem watch — detect CHANGE in the specs Handsel overlaps, not their content.
#
# Every target is fetched and hashed. A hash that matches the baseline in
# docs/ecosystem-watch.md means nothing moved and there is nothing to read.
# Only a mismatch earns a diff, and only a diff earns the operator's attention.
#
# This is deliberately not an API client: api.github.com is gated for repos
# outside this session's scope, and raw.githubusercontent is not. It is also
# deliberately not a summariser — a fetch that "summarises" a spec every day
# produces prose that drifts from the spec it describes.
#
#   usage: bash scripts/ecosystem-watch.sh          # print current hashes
#          bash scripts/ecosystem-watch.sh --status # also print status: lines
set -uo pipefail

TARGETS=(
  "erc-8004|https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8004.md"
  "erc-8183|https://raw.githubusercontent.com/ethereum/ERCs/master/ERCS/erc-8183.md"
  "a2a-spec|https://raw.githubusercontent.com/a2aproject/A2A/main/docs/specification.md"
  "a2a-x402|https://raw.githubusercontent.com/google-agentic-commerce/a2a-x402/main/README.md"
  "x402-specs|https://raw.githubusercontent.com/coinbase/x402/main/specs/README.md"
  "rails-abs|https://arxiv.org/abs/2606.08790"
)

for t in "${TARGETS[@]}"; do
  name="${t%%|*}"; url="${t#*|}"
  body=$(curl -sS --max-time 30 "$url" 2>/dev/null)
  if [ -z "$body" ]; then printf '%-12s FETCH_FAILED\n' "$name"; continue; fi
  # arXiv abs pages carry a session-varying nonce; keep only the version marker.
  if [ "$name" = "rails-abs" ]; then
    body=$(printf '%s' "$body" | grep -oE '\[v[0-9]+\]|Submitted on [^<]*' | sort -u)
  fi
  hash=$(printf '%s' "$body" | sha256sum | cut -c1-16)
  printf '%-12s %s\n' "$name" "$hash"
  if [ "${1:-}" = "--status" ]; then
    printf '%s' "$body" | grep -iE '^status:|^created:|^requires:' | sed 's/^/             /' || true
  fi
done

exit 0
