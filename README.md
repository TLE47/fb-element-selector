# fb-element-selector

A DevTools-style **element inspector** for the [Freebuff](https://freebuff.ai) desktop app.

Click the magnifier in the right panel's tab strip, and the cursor turns into a crosshair. A
purple outline tracks whatever you hover, labelled with its tag, classes and pixel size. Click
to select it: the readout shows a CSS selector you can paste straight into devtools, **and the
selector is copied to your clipboard on the spot** — no second click needed. The readout says
`Copied` when that worked, or tells you to copy manually when it did not, because a silent
failure would look exactly like a success.

```
┌────────────────────────────────────────────────────────────┐
│  Browser │ Files │ Terminal │ Changes │ Note   [🔍]  [+]     │
│                                             ▲               │
│                                             the inspector  │
└────────────────────────────────────────────────────────────┘
```

The magnifier is the last control before the `+` that opens the panel launcher.

## Why this exists when the app already has one

Freebuff does ship an element inspector, but only for the **preview webview**. It injects a
picker script into the page being previewed with `executeJavaScript`, so it can select elements
of *the site under preview* and nothing else. It cannot reach the Freebuff chrome — not the
composer, not the sidebar, not the tabs, not this button.

This one runs in the renderer against `document.body`, so it picks **any element of the app
itself**.

## Install

```bash
git clone https://github.com/TLE47/fb-element-selector.git
cd fb-element-selector
npm install            # dev deps only, for the tests
node src/patch.mjs     # patch the installed app
```

Then **reload the app** (`View ▸ Reload App`, or quit and reopen).

Check or undo at any time:

```bash
node src/patch.mjs --check    # exit 0 patched, 1 not patched, 2 anchors gone
node src/patch.mjs --revert   # restore the pre-patch bundle
```

### Surviving app updates

An app update replaces the bundle wholesale, under a new content hash, so a hand edit is lost
while a script can be re-run. To have this re-applied automatically, install the LaunchAgent:

```bash
mkdir -p ~/Library/LaunchAgents
sed "s#__REPO__#$PWD#g; s#__HOME__#$HOME#g" launchd/com.fb.element-selector.plist \
  > ~/Library/LaunchAgents/com.fb.element-selector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.fb.element-selector.plist
```

It runs on every login and whenever anything under `Freebuff.app` changes, so an update landing
mid-session is picked up within about a minute (the agent has a 30-second throttle).

If an update ever moves the anchors — renames the panel-tab list, the store's panel-id list, or
the tab strip's markup — the agent deliberately does **nothing** and tells you:

> **Freebuff element selector needs re-anchoring**
> Freebuff 2026.10.1 moved the patch anchors; the inspector is not applied. …

That is the one failure a script genuinely cannot fix: the bundle's internal symbols changed, so
the two anchors in `src/patch.mjs` need updating by hand. Re-anchor `EDITS`, and re-run the
drill. The notification fires once per distinct breakage rather than on every trigger, so it
cannot become noise.

Undo the agent:

```bash
launchctl bootout gui/$(id -u)/com.fb.element-selector
rm ~/Library/LaunchAgents/com.fb.element-selector.plist
```

## How it works

Freebuff ships as a built bundle, so a feature added to it is a patch to the shipped file. The
patcher:

1. **Resolves the entry assets by size, not by name.** There are several hundred `index-*.js`
   chunks; the renderer entry is the only one over 1 MB. A new content hash needs no edit.
2. **Verifies every anchor before writing anything.** If either anchor does not match exactly
   once, it writes nothing and exits 2 — a moved anchor reports itself instead of producing a
   half-patched bundle.
3. **Parses the result as an ES module before it reaches disk.** `node --check` is useless here:
   it exits 0 on *any* file containing ESM syntax. An unparseable bundle would leave the app
   with a blank window and no way back but a reinstall, so that check is not optional.
4. **Renames the assets** to `*-fb-inspect.*` and repoints `index.html`, so no cached URL can
   serve the pre-patch UI after a reload.

The injected code closes over three identifiers that are already in module scope at the
injection point: `k` (React), `d` (the jsx runtime) and `le` (the app's Icon component).

## Tests

```bash
npm test              # behaviour: 44 checks in jsdom with real React 19
npm run test:update   # durability: 27 checks against a simulated app update
```

Both suites read the **installed** app, so run them after `node src/patch.mjs`. To verify the
repo end to end from untouched bytes instead — useful in CI, or on a machine where the app is
not patched — use the isolated runner, which stages a pristine copy in a temp dir and leaves the
app alone:

```bash
bash test/run-isolated.sh [path-to-pristine-backup]
```

`npm test` lifts the inspector out of the **shipped bundle verbatim**, so it exercises the bytes
that actually run in the app rather than a copy that could drift from them.

`npm run test:update` is the interesting one. It stages a fake new release — pristine bytes
under a content hash this install has never seen — and checks that the patch applies,
re-anchors, stays idempotent, parses as an ES module, reverses byte-for-byte, and is *refused
untouched* when the anchors vanish. It also asserts that none of those staged operations
reached the installed app or its backup directory, which is the regression test for a bug this
harness once had.

## Gotchas, for anyone patching a bundled Electron app

These are all things that cost real debugging time here:

- **`node --check` does not work on an ES module bundle.** It exits 0 on a file containing
  `export const x=1` followed by syntactically broken code. Use
  `new vm.SourceTextModule(src)` under `--experimental-vm-modules`, and treat a missing
  `SourceTextModule` as "cannot check" rather than "broken".
- **The jsx runtime is not variadic.** `jsx(type, props, ...children)` silently drops everything
  past the third argument. Every multi-child element must spell its children in
  `props.children`. A stub built on `createElement` hides this completely.
- **An app update replaces the bundle under a new content hash.** Anything keyed to a filename
  breaks; resolve by content, or re-derive.
- **A test harness that can write to production state is not a harness.** A hardcoded backup path
  in the patcher meant a staged fake release overwrote the real `index.html`, leaving the app
  serving a URL that did not exist. Make every path overridable and assert isolation.
- **Resolve symlinks when comparing `import.meta.url` to `process.argv[1]`.** On macOS `/var`
  is a symlink to `/private/var`, so the two differ for any path under `/tmp`. Comparing them
  verbatim makes the entry-point guard silently skip `main()` and exit 0 having done nothing —
  a failed patch that reports success.
- **A `catch {}` around a clipboard write turns a typo into a silent failure.** A bare
  `navigator` reference throws `ReferenceError` in any scope where it is not a global; that
  throw gets swallowed by the surrounding `catch`, and every copy then reports failure for a
  reason no log mentions. Use `window.navigator`, and report the outcome rather than assuming
  it.

## Requirements

- macOS, with Freebuff installed at `/Applications/Freebuff.app`
- Node 20+ (`node`, for the patcher and tests)
- Patching modifies the app bundle, so its code signature will no longer validate. macOS
  currently still launches it; a future OS may not. `codesign --force --deep --sign -` on the
  bundle re-signs it ad hoc if you ever hit that.

## License

MIT