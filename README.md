# fb-element-selector

**Click an element anywhere in the Freebuff app — get its CSS selector, already copied.**

[![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](#installation)
[![Platform: macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](#installation)
[![No dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](#installation)
[![Tests: 99](https://img.shields.io/badge/tests-99-passing-brightgreen)](#tests)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/TLE47/fb-element-selector/blob/main/LICENSE)

A DevTools-style element inspector for the [Freebuff](https://freebuff.com) desktop app. It adds a
magnifier to the right panel's tab strip; arm it and the cursor becomes a crosshair. A purple
outline tracks whatever you hover, labelled with its tag, classes and pixel size, and clicking
copies the resolved selector straight to your clipboard.

- **Picks the app itself** — the composer, the sidebar, the tabs, the whole Freebuff chrome
- **Copies on pick** — the common case is one click, and the readout confirms it worked
- **Says so when it fails** — a clipboard that refuses is reported, never silently swallowed
- **Survives app updates** — a LaunchAgent re-applies it, and falls back to plain DOM if an update renumbers the bundle

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
node src/patch.mjs --check    # 1 not patched · 1 already patched · 2 could not run · 3 would not parse
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

**If an update renumbers the bundle, you are told — but the inspector still works.** There are two
tiers. Tier 1 injects a React component and leans on three minified identifiers the bundler
assigns, which a rebuild can rename. Tier 2 depends on *none* of them: it mounts as plain DOM
beside the panel launcher, keyed on `className:"panel-add"` and
`aria-label:"Open panel tab"` — strings that come from the app's source and survive minification.
When tier 1's anchors stop matching, tier 2 lands instead and you get one notification saying so.

So an update that moves the anchors is no longer a lost feature. It is a slightly plainer button,
plus a note that re-anchoring `EDITS` in `src/patch.mjs` would restore the integrated version.
Notifications are deduplicated per *distinct* breakage, so a watch-path agent cannot spam you and
cannot hide a genuinely new breakage either.

Undo the agent:

```sh
launchctl bootout gui/$(id -u)/com.fb.element-selector
rm ~/Library/LaunchAgents/com.fb.element-selector.plist
```

---

## How it works

Freebuff ships as a built bundle, so a feature added to it is a patch to the shipped file. The
patcher resolves the renderer entry **by size, not by name**, so a new content hash needs no
edit; tries tier 1's anchors and falls back to an anchor-free tier 2 when any of them is gone,
so a rebuild degrades instead of breaking; and **parses the result as an ES module before it
reaches disk**.

That last one is not optional: `node --check` exits 0 on any file containing ESM syntax, so it
cannot catch the single failure that would leave you with a blank window and no way back but a
reinstall. It is also what makes tier selection honest — a bundle that does not parse is refused
outright rather than patched.

Full detail, including the traps that cost real debugging time here, is in
[docs/PATCHING.md](https://github.com/TLE47/fb-element-selector/blob/main/docs/PATCHING.md).

---

## Tests

```sh
npm test              # 44 behaviour checks, jsdom + real React 19
npm run test:update   # 35 durability checks against a simulated app update
npm run test:fallback # 20 checks that tier 2 mounts and picks, on a renumbered bundle
```

`npm test` lifts the inspector out of the **shipped bundle verbatim**, so it exercises the bytes
that actually run in the app rather than a copy that could drift from them.

`npm run test:update` is the interesting one: it stages a fake release — pristine bytes under a
content hash this install has never seen — and checks the patch applies, re-anchors, stays
idempotent, parses as an ES module, reverses byte-for-byte, and **falls back rather than refusing**
when the anchors vanish. It also asserts that none of that reached the installed app or its backup
directory, and it exercises the notification contract: a moved anchor notifies once, the same
breakage stays quiet, a *different* moved anchor notifies again, and recovery announces itself.

`npm run test:fallback` proves tier 2 on its own terms: it renumbers the bundle (`nU`→`fbq0`,
`d`→`fbq1`, `le`→`fbq2`) to defeat every tier-1 anchor, then drives the fallback in jsdom — it
mounts left of the `+`, arms, outlines, picks without activating the element, resolves a selector,
copies it, and cancels on Escape.

Both suites read the installed app, so run them after patching. **On a fresh clone with nothing
patched yet, `npm run test:update` exits 2 with an explanation** — it needs the pristine pre-patch
bytes to stage a fake release from, and there are none. Use the isolated runner, which stages its
own pristine copy and needs no prior state:

```sh
bash test/run-isolated.sh    # all three suites, from untouched bytes; works on a fresh clone
```

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| No magnifier in the tab strip | Not patched, or not reloaded: `node src/patch.mjs --check`, then reload |
| Notification says "running in fallback mode" | An update renumbered the bundle. The inspector works as plain DOM; re-anchor `EDITS` for the React version |
| The magnifier looks a little different than the demo | That is what fallback mode looks like — no hover hint styling, a text `✕` instead of the app's icon |
| `--check` exits **3** | The patched bundle would not parse, so nothing was written. The app is untouched |
| `--check` exits **2** | The patcher could not run — no app, no entry bundle, or `--revert` with nothing to restore. The message says which |
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
