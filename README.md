# fb-element-selector

**Click any element in the Freebuff app — get its CSS selector, already copied.**

[![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen)](#install)
[![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)](#install)
[![Tests: 117](https://img.shields.io/badge/tests-117-passing-brightgreen)](https://github.com/TLE47/fb-element-selector/blob/main/src/docs/PATCHING.md)
[![MIT](https://img.shields.io/badge/license-MIT-green)](https://github.com/TLE47/fb-element-selector/blob/main/src/LICENSE)

A DevTools-style element inspector for the [Freebuff](https://freebuff.com) desktop app. It adds a
magnifier to the right panel — click it, hover anything, click to copy that element's selector.

![the inspector armed, hovering an element, and the selector it produced](https://raw.githubusercontent.com/TLE47/fb-element-selector/main/src/docs/demo/demo.webp)

## Install

```sh
git clone https://github.com/TLE47/fb-element-selector.git
cd fb-element-selector
node src/patch.mjs
```

Then **reload Freebuff** — `View ▸ Reload App`, or quit and reopen.

## Use it

Click the magnifier, then hover an element. A purple outline follows your cursor and labels what
is under it. Click to copy the selector — the readout confirms the copy worked.

`Esc` or a second click cancels.

## Keep it across updates

Optional, but worth it: app updates drop the patch, and this puts a small background agent in place
that re-applies it for you.

<details>
<summary>Show the commands</summary>

```sh
mkdir -p ~/Library/LaunchAgents
sed "s#__REPO__#$PWD#g; s#__HOME__#$HOME#g" src/launchd/com.fb.element-selector.plist \
  > ~/Library/LaunchAgents/com.fb.element-selector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fb.element-selector.plist
```

To remove it again:

```sh
launchctl bootout gui/$(id -u)/com.fb.element-selector
rm ~/Library/LaunchAgents/com.fb.element-selector.plist
```

</details>

With it installed, a future update can never silently take the inspector away: if something changes
underneath, you get one notification and it keeps working in a plainer form. You never have to read
a log to find out.

## Undo

To put the app back exactly as it shipped:

```sh
node src/patch.mjs --revert
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

- [How it works, and the traps](https://github.com/TLE47/fb-element-selector/blob/main/src/docs/PATCHING.md)
- [Running the tests](https://github.com/TLE47/fb-element-selector/blob/main/src/docs/PATCHING.md#tests)
- [About the demo clip](https://github.com/TLE47/fb-element-selector/blob/main/src/docs/demo/README.md)

## License

MIT