#!/bin/bash
# Run both suites against a staged, pristine bundle so the result does not depend on whatever
# else happens to be patched in the installed app right now. Leaves the app untouched.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE="$(ls -t "$HOME"/.nvm/versions/node/*/bin/node | head -1)"
SRC="${1:-$HOME/.fb-scratch/backup-desktop-note}"   # where the pristine pre-patch bytes live

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/assets" "$WORK/backup"
# Plain files only: the backup dir can hold subdirectories (quarantined drill artifacts), and
# matching one of those yields a path that is a directory rather than the pristine bundle.
JS="$(find "$SRC" -maxdepth 1 -type f -name 'index-*.js' ! -name '*.orig' | head -1)"
CSS="$(find "$SRC" -maxdepth 1 -type f -name 'index-*.css' ! -name '*.orig' | head -1)"
[ -n "$JS" ] && [ -n "$CSS" ] || { echo "no pristine backup in $SRC"; exit 2; }
cp "$JS" "$WORK/assets/$(basename "$JS")"
cp "$CSS" "$WORK/assets/$(basename "$CSS")"
printf '<link rel="stylesheet" href="/assets/%s"><script type="module" src="/assets/%s">' \
  "$(basename "$CSS")" "$(basename "$JS")" > "$WORK/index.html"

export ASSETS="$WORK/assets"
export FREEBUFF_PATCH_BACKUP="$WORK/backup"

echo "== applying the repo patcher to a pristine bundle =="
"$NODE" --experimental-vm-modules --no-warnings "$HERE/src/patch.mjs" || exit 1

echo
echo "== inspector.test.mjs =="
"$NODE" --experimental-vm-modules --no-warnings "$HERE/test/inspector.test.mjs"
inspector=$?

echo
echo "== update-drill.mjs =="
"$NODE" --experimental-vm-modules --no-warnings "$HERE/test/update-drill.mjs"
drill=$?

echo
echo "== dom-fallback.test.mjs =="
"$NODE" --experimental-vm-modules --no-warnings "$HERE/test/dom-fallback.test.mjs"
fallback=$?

echo
echo "inspector_exit=$inspector drill_exit=$drill fallback_exit=$fallback"
exit $(( inspector | drill | fallback ))