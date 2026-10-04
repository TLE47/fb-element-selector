#!/bin/bash
# ensure.sh — re-apply the element inspector whenever the Freebuff app changes.
#
# The patch lives in the app's own bundle and an app update replaces that bundle wholesale under
# a new content hash, so re-running the patcher is the only way the feature comes back. This does
# it on every launch and on every change under the app.
#
# Safe to run at any time, any number of times: the patcher is idempotent, verifies every anchor
# before writing anything, and refuses to write a bundle that would not parse.
#
# NOTIFYING WHEN AN UPDATE BREAKS THE PATCH
#   A moved anchor is the one failure a script genuinely cannot fix - the inspector silently
#   disappears from the app. A line in a log nobody reads is not a report, so it raises a macOS
#   notification. Two rules keep that from becoming noise, because a WatchPaths agent fires on
#   any change under the app:
#     * notify once per distinct BROKEN STATE (fingerprinted from the patcher output), and
#     * always notify on a TRANSITION - newly broken, or recovered.
#   Notification is best-effort: if osascript is blocked, the run still patches and still logs.
#   Failing to notify must never stop the patch from being applied.
#
# Exit 0 unless the patcher is missing, so launchd records success and does not treat a moved
# anchor as a crash to retry.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PATCHER="$HERE/src/patch.mjs"
APP="/Applications/Freebuff.app"
SCRATCH="$HOME/.fb-scratch"
# These are overridable so test/update-drill.sh can exercise this against a staged bundle without
# touching the real log, the real app, or the real backup directory.
LOG="${FREEBUFF_PATCH_LOG:-$SCRATCH/freebuff-element-selector.log}"
STATE="${FREEBUFF_PATCH_STATE:-$SCRATCH/freebuff-element-selector.state}"
export FREEBUFF_PATCH_BACKUP="${FREEBUFF_PATCH_BACKUP:-$SCRATCH/freebuff-element-selector-backup}"
NOTIFY="${FREEBUFF_PATCH_NOTIFY:-1}"

# node exists only under nvm on this machine, and a login shell may not have it on PATH.
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then
      PATH="$(dirname "$candidate"):$PATH"
      break
    fi
  done
fi

say() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $*"
  echo "$msg"
  mkdir -p "$(dirname "$LOG")" 2>/dev/null
  echo "$msg" >>"$LOG" 2>/dev/null
}

# The app's own version, which makes the notification actionable: "the patch broke on 2026.10.1"
# points at the release to re-anchor against.
app_version() {
  /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
    "$APP/Contents/Info.plist" 2>/dev/null || echo "unknown"
}

# Best-effort macOS notification. A blank title is a caller bug, not a reason to fail the run,
# so this never returns non-zero upward.
notify() {
  [ "$NOTIFY" = "0" ] && return 0
  # FREEBUFF_PATCH_NOTIFY_CMD lets the tests capture what WOULD have been posted without posting
  # anything, and lets you route alerts elsewhere (ntfy, Slack, a phone hook).
  if [ -n "${FREEBUFF_PATCH_NOTIFY_CMD:-}" ]; then
    "$FREEBUFF_PATCH_NOTIFY_CMD" "$1" "$2" >>"$LOG" 2>/dev/null
    return 0
  fi
  command -v osascript >/dev/null 2>&1 || return 0
  # Escape for AppleScript string literals: these come from tool output, so a quote or backslash
  # would otherwise break the script.
  local t b
  t="$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  b="$(printf '%s' "$2" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
  osascript -e "display notification \"$b\" with title \"$t\"" >/dev/null 2>&1
}

read_state() { [ -f "$STATE" ] && cat "$STATE" 2>/dev/null; }
write_state() {
  mkdir -p "$(dirname "$STATE")" 2>/dev/null
  printf '%s\n' "$1" >"$STATE" 2>/dev/null
}

if ! command -v node >/dev/null 2>&1; then
  say "SKIP: node not found on PATH"
  exit 0
fi

[ -d "$APP" ] || { say "SKIP: $APP is not installed"; exit 0; }
[ -f "$PATCHER" ] || { say "ERROR: $PATCHER is missing"; exit 1; }

previous="$(read_state)"

# --experimental-vm-modules enables the pre-write parse guard. Without it the patch still applies,
# just unchecked, so this flag is what makes the automatic path the safe one.
out="$(node --experimental-vm-modules --no-warnings "$PATCHER" 2>&1)"
status=$?

case "$status" in
  0)
    say "OK: patch is in place${out:+ - $out}"
    write_state "ok"
    # A recovery deserves a notification too: if you were told it was broken, silence would leave
    # you not knowing to reload and check.
    case "$previous" in
      broken:*)
        say "RECOVERED: the patch anchors match again - reload the app (View > Reload App)"
        notify "Freebuff element selector recovered" \
          "The inspector is patched again on $(app_version). Reload the app to pick it up."
        ;;
    esac
    ;;
  2)
    say "ATTENTION: the app update moved the patch anchors; nothing was written."
    say "           Re-anchor EDITS in $PATCHER against the new bundle."
    printf '%s\n' "$out" | while IFS= read -r line; do say "           $line"; done
    # Fingerprint the failure from the patcher's own message: identical output on a later run
    # means nothing new happened, so stay quiet.
    fingerprint="$(printf '%s' "$out" | cksum | cut -d' ' -f1)"
    write_state "broken:$fingerprint"
    case "$previous" in
      "broken:$fingerprint")
        say "           (already notified for this exact breakage; not notifying again)"
        ;;
      *)
        detail="$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-160)"
        notify "Freebuff element selector needs re-anchoring" \
          "Freebuff $(app_version) moved the patch anchors; the inspector is not applied. $detail See $LOG"
        ;;
    esac
    ;;
  *)
    say "ERROR: patcher exited $status${out:+ - $out}"
    write_state "error:$status"
    notify "Freebuff element selector error" \
      "The patcher exited $status on Freebuff $(app_version). See $LOG"
    ;;
esac

# Keep the log from growing without bound across many updates.
[ -f "$LOG" ] && tail -c 200000 "$LOG" >"$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
exit 0