#!/usr/bin/env bash
#
# Pin vendor/pdf.js to a pdf.js release and build its generic viewer into
# vendor/pdf.js/build/generic, which is what the app loads.
#
# Usage:
#   scripts/update-pdfjs.sh             update to the latest stable release
#   scripts/update-pdfjs.sh v6.4.299    switch to a specific release (the "v" is optional)
#   scripts/update-pdfjs.sh --build     rebuild the currently pinned release
#   scripts/update-pdfjs.sh --check     print the pinned and latest releases, change nothing

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PDFJS_DIR="vendor/pdf.js"
PDFJS="$ROOT/$PDFJS_DIR"
# Only plain vX.Y.Z tags are releases; upstream also has stray tags such as "vundefined".
RELEASE_TAG_RE='^v[0-9]+\.[0-9]+\.[0-9]+$'

die() { echo "error: $*" >&2; exit 1; }

current_tag() {
  git -C "$PDFJS" describe --tags --exact-match HEAD 2>/dev/null \
    || git -C "$PDFJS" rev-parse --short HEAD
}

latest_tag() {
  git -C "$PDFJS" ls-remote --tags --refs origin 'v*' \
    | sed 's#.*refs/tags/##' \
    | grep -E "$RELEASE_TAG_RE" \
    | sort -V | tail -n 1
}

build() {
  echo "==> Building pdf.js $(current_tag) generic viewer"
  rm -rf "$PDFJS/build/generic"
  (
    cd "$PDFJS"
    PUPPETEER_SKIP_DOWNLOAD=1 npm ci --no-audit --no-fund
    npx gulp generic
  )
  [[ -f "$PDFJS/build/generic/web/viewer.html" ]] || die "build finished but viewer.html is missing"
  echo "==> Built $PDFJS_DIR/build/generic"
}

cd "$ROOT"

# Initialise on fresh clones only: on an existing checkout `submodule update`
# would reset vendor/pdf.js to the commit recorded in the index.
[[ -e "$PDFJS/.git" ]] || git submodule update --init "$PDFJS_DIR"

case "${1:-}" in
  --build)
    build
    exit 0
    ;;
  --check)
    echo "pinned: $(current_tag)"
    echo "latest: $(latest_tag)"
    exit 0
    ;;
  -h | --help)
    sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
esac

tag="${1:-$(latest_tag)}"
[[ "$tag" == v* ]] || tag="v$tag"
[[ "$tag" =~ $RELEASE_TAG_RE ]] || die "'$tag' is not a pdf.js release tag (expected e.g. v6.4.299)"

current="$(current_tag)"
if [[ "$tag" == "$current" ]]; then
  echo "==> pdf.js is already at $tag (use --build to rebuild)"
  [[ -f "$PDFJS/build/generic/web/viewer.html" ]] || build
  exit 0
fi

[[ -z "$(git -C "$PDFJS" status --porcelain)" ]] \
  || die "$PDFJS_DIR has local changes; pdf.js must stay unmodified (see CLAUDE.md)"

echo "==> Switching pdf.js $current -> $tag"
git -C "$PDFJS" fetch --quiet origin tag "$tag"
git -C "$PDFJS" -c advice.detachedHead=false checkout --quiet "$tag"
git add "$PDFJS_DIR"

build

echo
echo "pdf.js is now pinned to $tag (staged). Smoke-test the app, then commit:"
echo "  git commit -m \"Update pdf.js to $tag\""
