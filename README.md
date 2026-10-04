# fb-element-selector

**Click any element in the Freebuff app — get its CSS selector, already copied.**

[![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](#install)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](#install)
[![Tests: 117](https://img.shields.io/badge/tests-117-passing-brightgreen)](https://github.com/TLE47/fb-element-selector/blob/main/docs/PATCHING.md)
[![MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/TLE47/fb-element-selector/blob/main/LICENSE)

A DevTools-style element inspector for the [Freebuff](https://freebuff.com) desktop app. Click the
magnifier in the right panel, hover anything, and click to copy its selector.

![the inspector armed, hovering an element, and the selector it produced](https://raw.githubusercontent.com/TLE47/fb-element-selector/main/docs/demo/demo.webp)

## Install

```sh
git clone https://github.com/TLE47/fb-element-selector.git
cd fb-element-selector
node src/patch.mjs
```

Then **reload Freebuff** — `View ▸ Reload App`, or quit and reopen.

> It ships as **lossless animated WebP**, not video and not GIF — a Markdown page renders an image
pixel for pixel, where a video would be decoded through a codec behind a poster frame and a play
button. See [docs/demo](https://github.com/TLE47/fb-element-selector/blob/main/docs/demo/README.md)
for the toolchain and the numbers.

## Use it

Click the magnifier, then hover an element. A purple outline follows your cursor and labels what
is under it. Click to copy the selector — the readout confirms the copy worked.

`Esc` or a second click cancels.

## Keep it across updates

App updates replace the bundle, which drops the patch. One command puts a small agent in place that
re-applies it for you:

```sh
mkdir -p ~/Library/LaunchAgents
sed "s#__REPO__#$PWD#g; s#__HOME__#$HOME#g" launchd/com.fb.element-selector.plist \
  > ~/Library/LaunchAgents/com.fb.element-selector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fb.element-selector.plist
```

If a future update ever breaks it, you get one notification — and it keeps working in a plainer
form rather than disappearing. You never have to read a log to find out.

## Undo

```sh
node src/patch.mjs --revert                    # restore the original app files
launchctl bootout gui/$(id -u)/com.fb.element-selector   # if you installed the agent
```

## If something looks wrong

| What you see | What to do |
|---|---|
| No magnifier | Run `node src/patch.mjs`, then reload the app |
| Missing after an update | Wait ~30 s for the agent, or run `bash src/ensure.sh` |
| Looks plainer than the demo | That's the fallback working — nothing to do |
| "Copy failed" | The clipboard was refused; the selector is still selectable by hand |
| Anything else | Run `node src/patch.mjs --check`; it explains what state you're in |

## Requirements

macOS, Freebuff installed at `/Applications/Freebuff.app`, and Node 20+. Patching modifies the app
bundle, so its code signature no longer validates — macOS still launches it; if a future release
does not, re-sign with `codesign --force --deep --sign - /Applications/Freebuff.app`.

## Want the details?

- [How it works, and the traps](https://github.com/TLE47/fb-element-selector/blob/main/docs/PATCHING.md)
- [Running the tests](https://github.com/TLE47/fb-element-selector/blob/main/docs/PATCHING.md#tests)

## License

MIT