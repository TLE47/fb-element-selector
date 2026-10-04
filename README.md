# fb-element-selector

**Click an element anywhere in the Freebuff app — get its CSS selector, already copied.**

[![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](#installation)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](#installation)
[![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](#installation)
[![Tests: 75](https://img.shields.io/badge/tests-75-passing-brightgreen)](#tests)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/TLE47/fb-element-selector/blob/main/LICENSE)

A DevTools-style element inspector for the [Freebuff](https://freebuff.com) desktop app. It adds a
magnifier to the right panel's tab strip; arm it and the cursor becomes a crosshair. A purple
outline tracks whatever you hover, labelled with its tag, classes and pixel size, and clicking
copies the resolved selector straight to your clipboard.

- **Picks the app itself** — the composer, the sidebar, the tabs, the whole Freebuff chrome
- **Copies on pick** — the common case is one click, and the readout confirms it worked
- **Says so when it fails** — a clipboard that refuses is reported, never silently swallowed
- **Survives app updates** — a LaunchAgent re-applies it, and warns if an update moves its anchors

**[Install](#installation)** · **[How it works](#how-it-works)** · **[Tests](#tests)** ·
[Patching a bundled app](https://github.com/TLE47/fb-element-selector/blob/main/docs/PATCHING.md) ·
[Demo assets](https://github.com/TLE47/fb-element-selector/blob/main/docs/demo/README.md)

---

## See it work

![the inspector armed, hovering an element, and the selector it produced](https://raw.githubusercontent.com/TLE47/fb-element-selector/main/docs/demo/demo.webp)

The clip is the real app, unedited: the magnifier is armed in the tab strip, the cursor turns
into a crosshair, hovering outlines an element and labels it `tag.classes WxH`, and the click
both resolves the selector and copies it. Nothing here is a mock-up.

> It ships as **lossless animated WebP**, not video and not GIF — a Markdown page renders an image
pixel for pixel, where a video would be decoded through a codec behind a poster frame and a play
button. See [docs/demo](https://github.com/TLE47/fb-element-selector/blob/main/docs/demo/README.md)
for the toolchain and the numbers.

---

## Installation

**Clone and patch:**

```sh
git clone https://github.com/TLE47/fb-element-selector.git
cd fb-element-selector
npm install                # dev deps, for the tests only
node src/patch.mjs         # patch the installed app
```

Then **reload the app** — `View ▸ Reload App`, or quit and reopen.

Check or undo at any time:

```sh
node src/patch.mjs --check    # 0 patched · 1 not patched · 2 anchors gone · 3 would not parse
node src/patch.mjs --revert   # restore the pre-patch bundle
```

### Staying patched across updates

An app update replaces the bundle wholesale under a new content hash, so a hand edit is lost
while a script can be re-run. Install the LaunchAgent and it re-applies on every login and on
any change under `Freebuff.app`:

```sh
mkdir -p ~/Library/LaunchAgents
sed "s#__REPO__#$PWD#g; s#__HOME__#$HOME#g" launchd/com.fb.element-selector.plist \
  > ~/Library/LaunchAgents/com.fb.element-selector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fb.element-selector.plist
```

If an update ever moves the anchors, the agent deliberately does **nothing** and tells you — the
bundle's internal symbols changed, so `EDITS` in `src/patch.mjs` need re-anchoring by hand. That
is the one failure no script can fix, so it is loud rather than silent. Notifications are
deduplicated per distinct breakage, so a watch-path agent cannot spam you.

Undo the agent:

```sh
launchctl bootout gui/$(id -u)/com.fb.element-selector
rm ~/Library/LaunchAgents/com.fb.element-selector.plist
```

---

## How it works

Freebuff ships as a built bundle, so a feature added to it is a patch to the shipped file. The
patcher resolves the renderer entry **by size, not by name**, so a new content hash needs no
edit; verifies **every anchor before writing anything**, so an update that moved them is reported
rather than half-applied; and **parses the result as an ES module before it reaches disk**.

That last one is not optional: `node --check` exits 0 on any file containing ESM syntax, so it
cannot catch the single failure that would leave you with a blank window and no way back but a
reinstall.

Full detail, including the traps that cost real debugging time here, is in
[docs/PATCHING.md](https://github.com/TLE47/fb-element-selector/blob/main/docs/PATCHING.md).

---

## Tests

```sh
npm test              # 44 behaviour checks, jsdom + real React 19
npm run test:update   # 31 durability checks against a simulated app update
```

`npm test` lifts the inspector out of the **shipped bundle verbatim**, so it exercises the bytes
that actually run in the app rather than a copy that could drift from them.

`npm run test:update` is the interesting one: it stages a fake release — pristine bytes under a
content hash this install has never seen — and checks the patch applies, re-anchors, stays
idempotent, parses as an ES module, reverses byte-for-byte, and is **refused untouched** when the
anchors vanish. It also asserts that none of that reached the installed app or its backup
directory.

Both suites read the installed app, so run them after patching. To verify from untouched bytes
instead — CI, or a machine where the app is not patched:

```sh
bash test/run-isolated.sh
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| No magnifier in the tab strip | Not patched, or not reloaded: `node src/patch.mjs --check`, then reload |
| `--check` exits **2** | An update moved the anchors. Nothing was written. Re-anchor `EDITS` |
| Inspector missing after an update | Wait ~30 s for the agent, or run `bash src/ensure.sh` |
| "Copy failed" in the readout | The clipboard was refused; the selector is still selectable by hand |

---

## Requirements

macOS, Freebuff installed at `/Applications/Freebuff.app`, and Node 20+ for the patcher. Patching
modifies the app bundle, so its code signature will no longer validate — macOS currently still
launches it; if a future release does not, re-sign with
`codesign --force --deep --sign - /Applications/Freebuff.app`.

## License

MIT
