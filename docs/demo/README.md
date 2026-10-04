# The demo

Everything here exists so the README can show the inspector doing its actual job instead of a
drawing — and so anyone can rebuild the clip from a raw screen recording in two commands.

| File | What it is |
|---|---|
| [`demo.webp`](demo.webp) | the clip: animated **lossless** WebP — renders inline, pixel for pixel, in GitHub and VS Code previews and in every current browser |
| [`stills.png`](stills.png) | three stills pulled from the clip ([below](#the-stills)) |
| [`record.sh`](record.sh) | the whole pipeline: a raw `.mov` in, `demo.webp` + the stills out |

## Record it

```sh
brew install ffmpeg webp          # ffmpeg for the frames, webp for img2webp
docs/demo/record.sh "~/Movies/my-recording.mov"
```

That is: trim to the action, crop to the inspector's half of the window, decimate to 8 fps and
scale to 1100 px wide — one ffmpeg pass that lands PNG frames — then `img2webp -lossless` over
those frames. The PNGs are the master; the WebP and the stills both come from them, so neither is
a re-encode of the other.

## Why lossless WebP, and not an MP4 or a GIF

A Markdown page renders a video through a codec, with a poster frame and a play button. It
renders an image at full pixel-for-pixel accuracy. So the clip is an image, not a video.

A GIF would render the same way and is supported even more widely, but 256 colours is 256
colours: antialiased text and the purple overlay's translucent fill both get dithered, which is a
poor way to show off a tool whose whole output *is* text. Lossless WebP is exact, animates in
GitHub's and VS Code's Markdown previews, and lands smaller than the GIF it would replace. If you
need a GIF anyway: `ffmpeg -i demo.webp -loop 0 demo.gif` (decode it from the start, as that
does; ffmpeg cannot seek into an animated WebP).

## The stills

Three moments from the clip, so the README can show the behaviour without asking anyone to watch
42 seconds of video:

- **armed** — the magnifier is active and the cursor is a crosshair; the hint banner explains the
  one gesture that is coming
- **hovering** — the outline and its `tag.classes WxH` label track the pointer
- **picked** — the resolved selector is in the readout, and it is already on your clipboard
## Why a WebP and not a video

It ships as **lossless animated WebP**, not video and not GIF — a Markdown page renders an image
pixel for pixel, where a video would be decoded through a codec behind a poster frame and a play
button. That matters most on a repository page, where the demo is the first thing a visitor sees.
