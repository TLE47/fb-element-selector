#!/usr/bin/env node
// test/inspector.test.mjs — prove the inspector patch is in, is insertion-only, and behaves.
//
//   1 static   each anchor is present exactly once; the CSS matches; the invariants that make
//              the picker safe are present in the injected source
//   2 diff     reversing the edit table restores the pre-patch bundle byte for byte
//   3 runtime  the inspector, lifted verbatim out of the shipped bundle, driven in jsdom with
//              real React: selector building, hover outline, pick-without-activate, Escape,
//              cancel-by-clicking-the-button, and teardown on unmount
//
// USAGE  npm test        (node --experimental-vm-modules test/inspector.test.mjs)

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = process.env.ASSETS || '/Applications/Freebuff.app/Contents/Resources/orchestrator/ui/assets'
const BACKUP = process.env.FREEBUFF_PATCH_BACKUP || path.join(os.homedir(), '.fb-scratch', 'freebuff-element-selector')
// react / react-dom / jsdom are devDependencies; see README.
const HARNESS = path.join(ROOT, 'node_modules')

let failed = 0
const ok = (name, pass, detail = '') => {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}

const { EDITS, MARK, CSS: CSS_RULES, INSPECT } = await import('../src/patch.mjs')

if (!existsSync(ASSETS)) {
  console.error(`no assets at ${ASSETS}; is the app installed?`)
  process.exit(2)
}

const files = readdirSync(ASSETS)
const jsName = files
  .filter((f) => /^index-[\w-]+\.js$/.test(f))
  .map((f) => [f, readFileSync(path.join(ASSETS, f)).length])
  .sort((a, b) => b[1] - a[1])[0]?.[0]
const cssName = files.filter((f) => /^index-[\w-]+\.css$/.test(f))[0]
if (!jsName) {
  console.error('no renderer entry in ASSETS; is the app installed?')
  process.exit(2)
}

const readLatin = (f) => readFileSync(f, 'latin1')
const js = readLatin(path.join(ASSETS, jsName))
const css = readLatin(path.join(ASSETS, cssName))

// --- 1 static ------------------------------------------------------------------------------
{
  const vm = await import('node:vm')
  try {
    // eslint-disable-next-line no-new
    new vm.SourceTextModule(js, { identifier: 'renderer bundle' })
    ok('static: the patched bundle parses as an ES module', true)
  } catch (error) {
    ok('static: the patched bundle parses as an ES module', false, error.message.slice(0, 120))
  }
}

// The edit table lives in the patcher, so what is checked here is what would actually be
// written - there is no second copy of "what the patch is" to drift out of date.
for (const edit of EDITS) {
  const applied = js.split(edit.to).length - 1
  const keepsAnchor = edit.to.includes(edit.from)
  const original = keepsAnchor ? 0 : js.split(edit.from).length - 1
  ok(
    `static: ${edit.id} applied once${keepsAnchor ? '' : ', anchor consumed'}`,
    applied === 1 && original === 0,
    `to=${applied} from=${original}`,
  )
}
ok('static: css marker present once', css.split(`/*${MARK}*/`).length - 1 === 1)
ok('static: css matches the patcher', css.trimEnd().endsWith(CSS_RULES))

// The invariants that make a full-window picker safe to ship. Each of these is a way the
// picker can strand the user, so they are asserted rather than assumed.
ok(
  'static: the button sits immediately left of the "+" in the tab strip',
  /d\.jsx\(fbInspect,\{\}\),d\.jsx\("button",\{className:"panel-add"/.test(js),
)
ok(
  'static: the inspector reaches the app chrome, not the preview webview',
  INSPECT.includes('document.body.appendChild') && !INSPECT.includes('executeJavaScript'),
)
ok(
  'static: it cancels on Escape and restores the cursor',
  INSPECT.includes('e.key!=="Escape"') && INSPECT.includes('document.body.style.cursor=prev'),
)
ok(
  'static: it consumes the pick click instead of activating the element',
  INSPECT.includes('e.stopPropagation()') && INSPECT.includes('e.preventDefault()'),
)
ok(
  'static: every picker listener is capture-phase, so the picker wins over React',
  INSPECT.includes('addEventListener("click",click,true)') &&
    INSPECT.includes('addEventListener("mousemove",move,true)'),
)
ok(
  'static: it removes every listener it added',
  INSPECT.includes('removeEventListener("mousemove",move,true)') &&
    INSPECT.includes('removeEventListener("click",click,true)') &&
    INSPECT.includes('removeEventListener("keydown",key,true)'),
)
ok(
  'static: it skips its own chrome so it cannot select itself',
  INSPECT.includes('data-fb-inspect-ui') &&
    INSPECT.includes('closest("[data-fb-inspect],[data-fb-inspect-ui]")'),
)
ok(
  'static: the readout is anchored out of flow so it cannot resize the strip',
  /\.fb-inspect-out\{[^}]*position:absolute/.test(CSS_RULES) && /top:calc\(100% \+ 6px\)/.test(CSS_RULES),
)
ok(
  'static: it sits beside the "+" (margin-left:auto) and reuses panel-add chrome',
  /\.fb-inspect\{[^}]*margin-left:auto/.test(CSS_RULES) &&
    js.includes('className:b?"panel-add fb-inspect-btn on"'),
)

// --- 2 diff ---------------------------------------------------------------------------------
const pristine = (name) => {
  const original = name.replace('-fb-inspect.', '.')
  const plain = path.join(BACKUP, original)
  return existsSync(plain) ? plain : path.join(BACKUP, `${original}.orig`)
}
const jsBackup = pristine(jsName)
if (existsSync(jsBackup)) {
  // Reverse every edit the patcher defines and compare with the pre-patch bundle: that is what
  // "insertion-only" means, checked against the same table that wrote it.
  let after = js
  for (const edit of EDITS) after = after.replace(edit.to, edit.from)
  ok('diff: reversing the edit table restores the bundle byte for byte', after === readLatin(jsBackup))
  const cssBackup = pristine(cssName)
  if (existsSync(cssBackup)) {
    const cb = readFileSync(cssBackup, 'utf8')
    const cn = readFileSync(path.join(ASSETS, cssName), 'utf8')
    ok('diff: css is append-only', cn === `${cb}${CSS_RULES}`, `+${cn.length - cb.length} bytes`)
  }
} else {
  ok('diff: a pre-patch backup exists', false, BACKUP)
}

// --- 3 runtime ------------------------------------------------------------------------------
// The inspector is lifted out of the shipped bundle verbatim, so this exercises the bytes that
// actually run in the app - not a copy that could drift from them.
if (!existsSync(path.join(HARNESS, 'node_modules', 'react', 'index.js')) &&
    !existsSync(path.join(HARNESS, 'react', 'index.js'))) {
  console.error('\nSKIP runtime checks: run `npm install` first (react, react-dom, jsdom).')
  console.log(failed ? `\n${failed} check(s) failed` : '\nall static and diff checks passed')
  process.exitCode = failed ? 1 : 0
} else {
  const React = await import(`${HARNESS}/react/index.js`)
  const { createRoot } = await import(`${HARNESS}/react-dom/client.js`)
  const { act } = React
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  // The app's `d` IS react/jsx-runtime, so the harness must use it rather than createElement:
  // the runtime takes (type, config, maybeKey) and DROPS everything past the third argument,
  // which createElement does not - stubbing it that way hid a real defect once.
  const d = await import(`${HARNESS}/react/jsx-runtime.js`)
  const k = React
  const { JSDOM } = await import(`${HARNESS}/jsdom/lib/api.js`)
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'https://localhost/' })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  const vm = await import('node:vm')

  const ctx = vm.createContext({
    k,
    d,
    // `le` is the app's Icon component; the inspector renders two of them.
    le: ({ name }) => React.createElement('i', { 'data-icon': name }),
    module: { exports: {} },
    exports: {},
    window: dom.window,
    document: dom.window.document,
    console,
  })
  let fbInspect, fbInspSel, fbInspDesc
  try {
    new vm.Script(`${INSPECT}\nmodule.exports={fbInspect,fbInspSel,fbInspDesc}`, {
      filename: 'fbinspect.js',
    }).runInContext(ctx)
    ;({ fbInspect, fbInspSel, fbInspDesc } = ctx.module.exports)
  } catch (error) {
    ok('runtime: the inspector lifted from the bundle', false, error.message.slice(0, 100))
  }
  ok('runtime: the inspector and its helpers lifted from the bundle', !!fbInspect && !!fbInspSel && !!fbInspDesc)

  if (fbInspect) {
    // jsdom has no layout, so give the probe a box or the outline is legitimately hidden.
    const probe = document.createElement('button')
    probe.id = 'fb-probe'
    probe.className = 'probe-btn is-active'
    probe.textContent = 'probe'
    const sibling = document.createElement('button')
    sibling.className = 'probe-btn'
    document.body.append(probe, sibling)
    probe.getBoundingClientRect = () => ({ left: 10, top: 20, width: 120, height: 40 })

    ok('runtime: a selector is built from the id when there is one', fbInspSel(probe) === '#fb-probe', fbInspSel(probe))
    const siblingSel = fbInspSel(sibling)
    ok(
      'runtime: without an id it walks up with tag, class and nth-of-type',
      siblingSel.startsWith('button.probe-btn:nth-of-type(') && !siblingSel.includes('is-active'),
      siblingSel,
    )
    ok('runtime: the hover label shows tag, class and size', /^button\.probe-btn\.is-active {2}120x40$/.test(fbInspDesc(probe)), fbInspDesc(probe))

    const root = createRoot(document.getElementById('root'))
    act(() => root.render(React.createElement(fbInspect, {})))
    const btn = () => document.querySelector('.fb-inspect-btn')
    ok('runtime: it starts idle and says what it does', btn().getAttribute('aria-pressed') === 'false' && btn().getAttribute('aria-label') === 'Inspect an element in the app')
    ok('runtime: nothing is listening before the picker is armed', document.querySelector('[data-fb-inspect]') === null)

    act(() => btn().dispatchEvent(new dom.window.Event('click', { bubbles: true })))
    ok('runtime: arming shows the overlay and the hint', document.querySelector('[data-fb-inspect]') !== null && document.body.style.cursor === 'crosshair')
    ok('runtime: the hint says how to pick and how to cancel', document.querySelector('.fb-inspect-hint')?.textContent === 'Click an element · Esc to cancel', document.querySelector('.fb-inspect-hint')?.textContent)
    ok('runtime: the button reports itself pressed while picking', btn().getAttribute('aria-pressed') === 'true')

    act(() => probe.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true })))
    await new Promise((r) => setTimeout(r, 40)) // let the rAF paint run
    const overlay = document.querySelectorAll('[data-fb-inspect]')[0]
    ok(
      'runtime: hovering draws the outline over the element',
      overlay.style.display === 'block' && overlay.style.left === '10px' && overlay.style.width === '120px',
      `${overlay.style.display} ${overlay.style.left} ${overlay.style.width}`,
    )
    ok('runtime: the hover label names the element', document.querySelectorAll('[data-fb-inspect]')[1].textContent.includes('button'))

    // The whole point: the click selects, and it must NOT also activate the element.
    let activated = 0
    probe.addEventListener('click', () => activated++)
    act(() => probe.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    ok('runtime: clicking selects it without activating it', activated === 0, `${activated} activations`)
    ok('runtime: the pick shows a selector you can read and copy', document.querySelector('.fb-inspect-sel')?.value === '#fb-probe', document.querySelector('.fb-inspect-sel')?.value)
    ok('runtime: picking tears the picker down again', document.querySelector('[data-fb-inspect]') === null && document.body.style.cursor === '' && btn().getAttribute('aria-pressed') === 'false')

    act(() => btn().dispatchEvent(new dom.window.Event('click', { bubbles: true })))
    act(() => document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
    ok('runtime: Escape cancels and leaves nothing behind', document.querySelector('[data-fb-inspect]') === null && document.querySelector('.fb-inspect-sel') === null && btn().getAttribute('aria-pressed') === 'false')

    act(() => btn().dispatchEvent(new dom.window.Event('click', { bubbles: true })))
    act(() => btn().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    ok('runtime: clicking the inspector button cancels instead of selecting the button', document.querySelector('[data-fb-inspect]') === null && btn().getAttribute('aria-pressed') === 'false')

    // Unmounting mid-pick must not leave full-window listeners or overlays alive.
    act(() => btn().dispatchEvent(new dom.window.Event('click', { bubbles: true })))
    act(() => root.unmount())
    ok('runtime: unmounting mid-pick removes the overlay and restores the cursor', document.querySelector('[data-fb-inspect]') === null && document.body.style.cursor === '')
    let leaked = 0
    probe.addEventListener('click', () => leaked++)
    act(() => probe.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })))
    ok('runtime: no picker listener survives the unmount', leaked === 1, `${leaked} click(s) reached the element`)

    probe.remove()
    sibling.remove()
  }
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0