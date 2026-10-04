# Patching a bundled Electron app

How `src/patch.mjs` works, and the traps that cost real debugging time while building this. Every
one of these is a silent failure — nothing throws, the patch just does not work — which is why
each has a check behind it in `test/`.

## What the patcher guarantees

| Property | How |
|---|---|
| Survives a content hash change | The renderer entry is resolved **by size**, not by filename: the only `index-*.js` over 1 MB, against several hundred syntax-highlighting chunks |
| Never half-applies | Every anchor must match exactly once before anything is written; otherwise exit 2 with nothing touched |
| Never ships a broken bundle | The patched source is parsed as an ES module **before** it reaches disk |
| Never serves stale code after a reload | Assets are renamed to `*-fb-inspect.*` and `index.html` repointed, so no cached URL can match |
| Reverses cleanly | Insertion-only; reversing the edit table restores the pre-patch bundle byte for byte |
| Refuses to restore a poisoned backup | `--revert` validates the backup's `index.html` against the assets it claims to describe |

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

## Re-anchoring after an update

When the agent reports that the anchors moved:

```sh
node src/patch.mjs --check          # exits 2 and lists which anchors matched how many times
```

Open the new bundle, find the current spelling of each anchor, and update `EDITS` in
`src/patch.mjs`. Each entry is `{ id, from, to }` where `from` must match **exactly once**. Then:

```sh
node src/patch.mjs && npm run test:update
```

The drill stages its own fake release, so it verifies your new anchors against a bundle that has
never been seen before — which is the only way to know the anchor is not accidentally unique to
today's build.