#!/bin/bash
# test/notify-sink.sh — stand-in for the macOS notification in tests.
#
# ensure.sh honours FREEBUFF_PATCH_NOTIFY_CMD, so this records the call instead of posting a
# banner. The update drill has to assert WHAT would reach the screen without putting it there.
#
# Usage: notify-sink.sh "<title>" "<body>"      (NOTIFY_INBOX names the file)
set -uo pipefail

{
  printf 'TITLE: %s\n' "$1"
  printf 'BODY: %s\n' "$2"
  printf -- '---\n'
} >>"${NOTIFY_INBOX:?NOTIFY_INBOX must be set}"
exit 0