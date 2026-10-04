# Patching a bundled Electron app

How `src/patch.mjs` works, and the traps that cost real debugging time while building this. Every
one of these is a silent failure — nothing throws, the patch just does not work — which is why
each has a check behind it in `test/`.

## What the patcher guarantees

| Property | How |
|---|---|
| Survives a content hash change | The renderer entry is resolved **by size**, not by filename: the only `index-*.js` over 1 MB, against several hundred syntax-highlighting chunks |
| Survives a **renumbered** bundle | Two tiers. Tier 1 needs three minified identifiers; tier 2 needs none and takes over when any anchor is gone |
| Never half-applies | Tier 1 requires every anchor to match exactly once; if any does not, the whole tier is skipped for tier 2 rather than applied partially |
| Never ships a broken bundle | The patched source is parsed as an ES module **before** it reaches disk |
| Never serves stale code after a reload | Assets are renamed to `*-fb-inspect.*` and `index.html` repointed, so no cached URL can match |
| Reverses cleanly | Insertion-only; reversing the edit table restores the pre-patch bundle byte for byte |
| Refuses to restore a poisoned backup | `--revert` validates the backup's `index.html` against the assets it claims to describe |

## The two tiers

Tier 1 injects `INSPECT` into the bundle: a real React component, mounted left of the `+` in the
panel tab strip. It closes over three module-scope identifiers — `k` (React), `d` (the jsx
runtime) and `le` (the app's `Icon`) — all assigned by the bundler. That is what makes it
integrate properly, and it is also its one fragility: a rebuild can rename any of the three.

Tier 2 (`DOMFALLBACK`) is appended to the bundle and depends on **nothing** minified. It mounts a
plain-DOM button next to its host:

```js
document.querySelector('button.panel-add[aria-label="Open panel tab"]')
```

Both of those strings come from the app's *source*, so minification renames nothing and a
`MutationObserver` covers the panel appearing after load. The picker itself is pure DOM, so the
behaviour — crosshair, outline, `tag.classes WxH` label, capture-phase click consumption, Escape,
copy on pick — is the same. What you lose is the React integration: a text `✕` instead of the
app's icon component, and no hover-hint styling.

`main()` picks the tier from the anchors, not from the exit code:

```js
const tier = missing.length ? 2 : 1
```

and tier 2 is only reachable by *appending*, so "insertion-only, reverses cleanly" still holds and
reversing it is a suffix removal.

### The banner is the whole signal

Exit 0 no longer distinguishes the tiers, so the patcher prints a machine-readable line that
`ensure.sh` keys on:

```
fb-element-selector: tier=2 missing=inject:0,mount:0
```

Two consequences, both of which were bugs before they were checks:

- **The banner must print on idempotent re-runs too.** Otherwise the first fallback patch
  notifies, and the next agent fire reports "already patched" — which reads as tier 1, and
  silently resets the state to `ok`. A WatchPaths agent fires repeatedly; the second one is the
  common case.
- **The fingerprint must cover the breakage, not the prose.** Hashing the patcher's whole output
  makes every run look like a *new* breakage, because it alternates between "patched `x`" and
  "already patched: `x`". Hence one dedicated line, and `ensure.sh` hashing only that line.

Dedupe then compares the **whole state string**, `fallback:$fingerprint`, not the `fallback:`
prefix. Matching the prefix is what kept a second, differently-moved anchor silent.

### The failure tier 2 cannot report — and now announces itself

Tier 2 keys on `panel-add` and `aria-label="Open panel tab"`. If an update renames those source
strings too — not the minified symbols, the app's own markup — both tiers fail to mount.

That case is invisible to everything outside the renderer. A bundle that parses cleanly falls
through both tiers and exits **0**, so `ensure.sh` writes `ok`, the notification never fires, and
the log says everything is fine — while the button simply is not there. It needs a human, and no
amount of anchoring logic reaches it.

What can be fixed is the silence. Tier 2 gives up after a mount deadline and says so in the app
itself:

```js
window.setTimeout(function () {
  mo.disconnect()
  if (!wrap || !wrap.isConnected) announce()
}, LIMIT)
```

`announce()` draws a dismissible notice bottom-corner (`role="status"`, so it is announced rather
than merely seen), sets `data-fb-inspect-failed` on `<html>`, and writes a `console.error`. The
`<html>` attribute deliberately survives dismissal: a notice the user swiped away must not become
a silent failure again, and it is what you check first when the button is missing.

Three details that matter:

- **Only from the deadline, and only when unmounted.** A notice on a working install is worse than
  no notice, so `announce()` is unreachable except on that one path — and `test/dom-fallback.test.mjs`
  drives both directions: a document with no host must notice, a document with one must not.
- **Guarded against re-announcing.** The notice is created once; a later MutationObserver tick
  cannot resurrect one the user dismissed.
- **`FB_INSP_MOUNT_TIMEOUT` is read with `typeof`.** A bare identifier would throw
  `ReferenceError` in the bundle, where it does not exist; `typeof` on an undeclared name is the
  one form that is safe. The tests set it to shrink the deadline.

The renderer has no channel back to `ensure.sh`, so this is necessarily a UI signal. If you want it
in the log as well, the renderer would need a filesystem bridge — worth doing only if you care more
about the log than the screen.

## The traps

### `node --check` does not work on an ES module bundle

It exits **0** on a file containing `export const x = 1` followed by syntactically broken code —
it cannot decide whether a file is a module without a resolution step. Use:

```js
const { SourceTextModule } = await import('node:vm')
new SourceTextModule(src)          // needs --experimental-vm-modules
```

And treat a **missing** `SourceTextModule` as "cannot check", not "broken" — otherwise a patcher
run without the flag refuses to do its job. `src/ensure.sh` and both test suites pass it.

### The jsx runtime is not variadic

`d.jsx(type, props, ...children)` **silently drops everything past the third argument**. The
runtime signature is `(type, config, maybeKey)`. Every multi-child element must spell its
children in `props.children`:

```js
d.jsxs("div", { className: "x", children: [a, b] })     // works
d.jsxs("div", { className: "x" }, a, b)                   // renders NOTHING, throws nothing
```

A test harness built on `createElement` hides this completely, because `createElement` *is*
variadic. `test/inspector.test.mjs` deliberately imports the app's real `react/jsx-runtime` for
exactly this reason.

### A test harness that can write to production state is not a harness

`BACKUP` was originally hardcoded. The update drill staged a fake release, the patcher backed it
up **over the real backup**, and `revert` then copied a poisoned `index.html` back — leaving the
app serving a renderer entry that did not exist. It survived a manual repair because the repair
fixed the live file and not the backup it was restored from.

Two rules came out of it, and both are now load-bearing:

1. **Every path the patcher touches is overridable by env var.** The drill passes `ASSETS` and
   `FREEBUFF_PATCH_BACKUP` to every single invocation.
2. **Assert on the source, not the symptom.** The drill snapshots the installed `index.html` and
   the backup directory and fails if either changed.

The isolation guard was verified by removing the override and watching the drill go red — an
assertion nobody has seen fail is decoration.

### Resolve symlinks when comparing `import.meta.url` to `process.argv[1]`

On macOS `/var` is a symlink to `/private/var`. Comparing them verbatim means the entry-point
guard silently skips `main()` when the repo lives under `/tmp` — and **exits 0 having done
nothing**. A clone there reported a successful patch that had not happened.

```js
import.meta.url === url.pathToFileURL(realpathSync(process.argv[1])).href
```

### A `catch {}` around a clipboard write turns a typo into a silent failure

The copy used a bare `navigator`. Where that is not a global it throws `ReferenceError`, the
surrounding `catch` swallows it, and every copy reports failure for a reason no log mentions.
Use `window.navigator`, and report the outcome rather than assuming it — an inspector that
silently copies nothing is worse than one that does not copy, because you paste a stale selector
and find out later.

### The parse guard catches broken fixtures too — which is how a broken test hides

The fallback test was "failing" because it used an unrecognisable bundle as its fixture. It was
not the fallback that was broken: `'x'.repeat(1_100_000)` is not JS, and the parse guard
correctly refused it with exit 3. Replacing each anchor's text with `/*gone*/` was no better —
`const nU=[{id:"preview"` becomes `/*gone*/,{id:...`, a dangling comma, still a parse failure.

Two fixtures, two syntax errors, both of which looked like the feature failing. The honest
simulation of a rebuild is **renumbering**, and the new names must be prefixed or they collide
with existing bindings (`nU` → `xQ` fails with *Identifier 'xQ' has already been declared*):

```js
const renumbered = real
  .replace(/\bnU\b/g, 'fbq0')
  .replace(/\bd\b/g, 'fbq1')
  .replace(/\ble\b/g, 'fbq2')
```

The drill now asserts that its fixture parses before using it, so it cannot quietly regress into
testing the parse-guard path again — which is the only way this class of mistake stays fixed.

### Check the precondition before you use it

Three of the bugs above had the same shape: a value read at module scope, before any guard could
run, so a missing input became a raw stack trace instead of an instruction.

```js
// throws at import, prints a Node trace, exits 1
const pristine = readdirSync(BACKUP).find(...)
```

```js
// says what to do next, exits 2
if (!existsSync(BACKUP)) { console.error(...); process.exit(2) }
const pristine = readdirSync(BACKUP).find(...)
```

The tell is a failure only a fresh clone ever hits. Test the shipped path, not just your working
copy — cloning the repo and running the documented commands is what caught all three.

## Re-anchoring after an update

When the agent reports **fallback mode**, the inspector is working and nothing is urgent. To get
the integrated React version back:

```sh
node src/patch.mjs --check          # reports not-patched, and which tier it would use
```

Open the new bundle, find the current spelling of each anchor, and update `EDITS` in
`src/patch.mjs`. Each entry is `{ id, from, to }` where `from` must match **exactly once**. Then:

```sh
node src/patch.mjs && npm run test:all
```

`EDITS` anchors two identifiers (`nU`, `d`), and the injected component body closes over three
(`k`, `d`, `le`) — check all of them still exist under those names. A rename to the *component
body's* identifiers is invisible until the mount silently fails.

The drill stages its own fake release, so it verifies your new anchors against a bundle that has
never been seen before — which is the only way to know the anchor is not accidentally unique to
today's build.

If the inspector is missing with no notification, tier 2's host strings probably changed. See
[What is still not solvable](#the-two-tiers) above.

### The exit-code contract

Measured, because it drifted while tier 2 was added:

| Code | Meaning |
|---|---|
| 0 | patched — including via tier 2 |
| 1 | `--check` only: not patched, or already patched |
| 2 | the patcher could not run — no app, no entry bundle, `--revert` with nothing to restore |
| 3 | the patched bundle would not parse; nothing written |

Two traps here. **Exit 2 stopped meaning "the anchors moved"** the moment tier 2 existed — that
condition now exits 0 — so any doc still describing it that way is describing the old patcher.
And `entryAsset()` used to run at module scope, so a missing entry bundle threw during *import*,
escaping `main()`'s handler as an unhandled stack trace and exiting 1: to `--check`, identical to
"not patched", which is the one answer that means nothing is wrong. The asset lookup is now lazy
and resolves inside `main()`, so the failure is a one-line message and exit 2.