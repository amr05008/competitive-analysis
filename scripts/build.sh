#!/bin/sh
# Build the packages: copy the store listing into the manifests, check the plugin, and
# write each host's package into dist/ (see scripts/package.py).
#
#   sh scripts/build.sh                     production: the OpenAI upload zip, the Claude zip,
#                                           dist/chatgpt-local/ and dist/claude-local/
#   sh scripts/build.sh --server staging    the two local folders and a Claude zip, all
#                                           pointed at staging; no OpenAI upload zip
#
# The plugin lives in plugin/, the folder Claude's directory lists (Decision 1, 2026-10-26).
# plugin/skills/teardown/references/report-template.md, the report contract, is a source
# file: edit it in plugin/, like SKILL.md. It was generated from amr05008/agent-skills until
# 2026-11-09, and its first line still says so until the next release's first edit.
# The listing fields in plugin/plugin.json are generated; edit
# listing/competitive-analysis-listing.md (see scripts/listing.py).
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN="$ROOT/plugin"

SERVER=production
case "$#:${1:-}" in
  0:) ;;
  2:--server) SERVER="$2" ;;
  *) echo "usage: sh scripts/build.sh [--server production|staging]" >&2; exit 2 ;;
esac
case "$SERVER" in
  production|staging) ;;
  *) echo "build: --server must be production or staging" >&2; exit 2 ;;
esac

# 1. Report template: a source file in plugin/, so the build only checks it's there. Vendor
# names never go in a model-readable file; step 2's vendor check covers it with the skill.
OUT="$PLUGIN/skills/teardown/references/report-template.md"
[ -f "$OUT" ] || { echo "build: $OUT not found" >&2; exit 3; }

# 2. Listing into the manifests, with the limit, vendor and plugin-id checks.
python3 "$ROOT/scripts/listing.py"

# The plugin folder carries its own copy of the license, because installers get only
# that folder. It must match the repo's.
cmp -s "$ROOT/LICENSE" "$PLUGIN/LICENSE" || { echo "build: plugin/LICENSE differs from LICENSE; copy it again" >&2; exit 6; }

# 3. Packages. A version that's already tagged was already uploaded, so its upload zip
# can't be rebuilt from different files: bump the version in the listing instead. Staging
# writes no upload zip, so the tag doesn't apply to it.
VERSION=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$PLUGIN/plugin.json")
TAG="v$VERSION"
if [ "$SERVER" = production ] && git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  if [ "$(git -C "$ROOT" rev-parse "$TAG^{commit}")" != "$(git -C "$ROOT" rev-parse HEAD)" ] \
     || [ -n "$(git -C "$ROOT" status --porcelain -- plugin)" ]; then
    echo "build: $TAG was already uploaded; bump the version in the listing" >&2
    exit 4
  fi
fi
python3 "$ROOT/scripts/package.py" --server "$SERVER"
if [ "$SERVER" = production ] && [ -n "$(git -C "$ROOT" status --porcelain -- plugin LICENSE listing)" ]; then
  echo "build: uncommitted changes; commit before uploading so tag $TAG matches the zip"
fi
