#!/bin/bash
# record.sh — turn a raw screen recording into the README's demo clip.
#
#   src/docs/demo/record.sh "~/Movies/Screen Recording ....mov"
#
# One ffmpeg pass decodes the capture, drops the dead air before the action, decimates the frame
# rate and scales it down; it lands PNG frames, and those frames are the master. img2webp then
# makes the lossless animated WebP, and the stills come out of the same PNGs - so nothing in the
# repo is a re-encode of anything else.
#
# Why 8 fps and 1100 px: the source is a 600 fps screen capture, so almost every frame is a
# duplicate of its neighbour, and the clip is ~40 s of a mostly-dark UI. Those two numbers are
# where the size lives - see src/docs/demo/README.md.
#
# The whole window is kept. A crop to the inspector's half of the window was tried and made the
# file BIGGER (6.4 MB against 3.5 MB): cropping away the dark sidebar forced a larger downscale
# of what remained, so the text got sharper and each frame cost more than the frames it saved.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="${1:-}"
[ -n "$SRC" ] || { echo "usage: $0 <recording.mov>" >&2; exit 2; }
[ -f "$SRC" ] || { echo "no such file: $SRC" >&2; exit 2; }

command -v ffmpeg >/dev/null || { echo "need ffmpeg:  brew install ffmpeg" >&2; exit 1; }
command -v img2webp >/dev/null || { echo "need img2webp: brew install webp" >&2; exit 1; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FPS=8
WIDTH=1100

echo "framing -> ${FPS} fps, ${WIDTH} px wide"
ffmpeg -v error -ss 0.6 -i "$SRC" \
  -vf "fps=${FPS},scale=${WIDTH}:-2:flags=lanczos" \
  "$WORK/f%04d.png"

frames=$(find "$WORK" -name 'f*.png' | wc -l | tr -d ' ')
echo "encoded $frames frames"

echo "lossless animated webp (this takes a couple of minutes)"
img2webp -lossless -m 3 -q 100 "$WORK"/f*.png -o "$HERE/demo.webp"

# Three stills: arm, hover, pick. Positions are fractions of the clip so they survive a re-record.
last=$(find "$WORK" -name 'f*.png' | sort | tail -1)
idx=$(basename "$last" .png | tr -d 'f')
for spec in "4:armed" "30:hover" "78:picked"; do
  pct="${spec%%:*}"; name="${spec##*:}"
  n=$(( 10#$idx * pct / 100 + 1 ))
  cp "$WORK/$(printf 'f%04d.png' "$n")" "$HERE/$name.png"
done

echo "wrote $HERE/demo.webp and three stills"
ls -la "$HERE/demo.webp"