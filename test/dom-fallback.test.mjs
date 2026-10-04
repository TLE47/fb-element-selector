#!/usr/bin/env node
// test/dom-fallback.test.mjs — prove the tier-2 fallback actually mounts and works.
//
// The point of tier 2 is that it survives a renumbered bundle: it depends on no minified
// identifier at all, only on `className:"panel-add"` and `aria-label:"Open panel tab"`, which are
// source strings. So the test does the honest thing and renumbers the bundle - rewriting `nU` to
// `xQ`, `d` to `q7` and `le` to `zz` everywhere - which is exactly what breaks tier 1.
//
//   USAGE  node --experimental-vm-modules test/dom-fallback.test.mjs

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS = process.env.ASSETS || '/Applications/Freebuff.app/Contents/Resources/orchestrator/ui/assets'
const HARNESS = path.join(ROOT, 'node_modules')

let failed = 0
const ok = (name, pass, detail = '') => {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}

const { EDITS, DOMFALLBACK } = await import('../src/patch.mjs')
if (!existsSync(path.join(HARNESS, 'react', 'index.js')) && !existsSync(path.join(HARNESS, 'node_modules', 'react', 'index.js'))) {
  console.error('\nSKIP: run `npm install` first.')
  process.exit(2)
}

// --- 1 the renumbered bundle really does break tier 1 --------------------------------------
const { readdirSync, statSync } = await import('node:fs')
const files = readdirSync(ASSETS)
const jsName = files.filter((f) => /^index-[\w-]+\.js$/.test(f))
  .map((f) => [f, statSync(path.join(ASSETS, f)).size]).sort((a, b) => b[1] - a[1])[0][0]
const real = readFileSync(path.join(ASSETS, jsName), 'latin1')

// Renumber the three identifiers tier 1 leans on. Whole-word so we do not corrupt properties.
const renumbered = real
  .replace(/\bnU\b/g, 'xQ')
  .replace(/\bd\b/g, 'q7')
  .replace(/\ble\b/g, 'zz')
const tier1Hits = EDITS.map((e) => renumbered.split(e.from).length - 1)
ok('the renumbered bundle defeats every tier-1 anchor', tier1Hits.every((h) => h !== 1), `hits=${tier1Hits.join(',')}`)

// --- 2 tier 2 has no such dependency --------------------------------------------------------
ok('tier 2 references no minified identifier the patcher relied on',
  !/\bfbInspSel\b/.test(DOMFALLBACK.replace(/fbInspSelD/g, '')) &&
  !DOMFALLBACK.includes('jsx') && !DOMFALLBACK.includes('useState'),
)
ok('tier 2 keys off the source-level class and aria-label',
  DOMFALLBACK.includes('button.panel-add[aria-label="Open panel tab"]'))
ok('tier 2 carries its own picker, so it needs nothing injected at an anchor',
  DOMFALLBACK.includes('function fbInspPickD(on)') && DOMFALLBACK.includes('addEventListener("click",click,true)'))
ok('tier 2 still consumes the pick click and handles Escape',
  DOMFALLBACK.includes('e.stopPropagation()') && DOMFALLBACK.includes('e.key!=="Escape"'))
ok('tier 2 guards against mounting twice', DOMFALLBACK.includes('wrap.isConnected'))

// --- 3 it actually mounts and works, in jsdom ------------------------------------------------
const React = await import(`${HARNESS}/react/index.js`)
const { JSDOM } = await import(`${HARNESS}/jsdom/lib/api.js`)
const dom = new JSDOM(
  `<!doctype html><body>
     <div class="panel-tabs">
       <button class="panel-tab" id="t1">Browser</button>
       <button class="panel-add" aria-label="Open panel tab">+</button>
     </div>
     <div id="target" class="composer-input">hello</div>
   </body>`,
  { url: 'https://localhost/' },
)
globalThis.window = dom.window
globalThis.document = dom.window.document

const copied = []
Object.defineProperty(dom.window.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: (t) => { copied.push(t); return Promise.resolve() } },
})

const vm = await import('node:vm')
const ctx = vm.createContext({
  window: dom.window,
  document: dom.window.document,
  MutationObserver: dom.window.MutationObserver,
  Promise,
  console,
})
try {
  new vm.Script(DOMFALLBACK, { filename: 'fbdom.js' }).runInContext(ctx)
  ok('tier 2 evaluates', true)
} catch (error) {
  ok('tier 2 evaluates', false, error.message.slice(0, 140))
}

const btn = dom.window.document.querySelector('.fb-inspect-btn')
// The button lives inside a wrapper <div> (it also holds the readout), and the WRAPPER is what
// goes into the strip - so it is the wrapper's position that has to be immediately left of the
// "+", not the button's sibling.
// Select by the aria-label, not just the class: tier 2's own button ALSO carries `panel-add`, so
// `querySelector('button.panel-add')` returns the inspector itself and the comparison is against
// the wrong node. (It does not confuse tier 2's own host() lookup, which matches on the label too.)
const plus = dom.window.document.querySelector('button.panel-add[aria-label="Open panel tab"]')
const wrap = btn?.parentElement
ok('tier 2 mounts its wrapper immediately left of the "+"',
  !!wrap && wrap.nextElementSibling === plus && wrap.previousElementSibling?.id === 't1' &&
    wrap.parentElement?.classList.contains('panel-tabs'),
  wrap ? `prev=${wrap.previousElementSibling?.id} next=${wrap.nextElementSibling?.getAttribute?.('aria-label')}` : 'no wrapper',
)
ok('tier 2 reuses the app button chrome class', btn?.className.includes('panel-add'))

// arm it
btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
ok('tier 2 arms: pressed state, crosshair, hint banner',
  btn.getAttribute('aria-pressed') === 'true' &&
  dom.window.document.body.style.cursor === 'crosshair' &&
  dom.window.document.querySelector('.fb-inspect-hint')?.textContent === 'Click an element · Esc to cancel')

// hover the target
const target = dom.window.document.getElementById('target')
target.getBoundingClientRect = () => ({ left: 5, top: 6, width: 200, height: 40 })
target.dispatchEvent(new dom.window.MouseEvent('mousemove', { bubbles: true }))
await new Promise((r) => setTimeout(r, 40))
const overlay = dom.window.document.querySelectorAll('[data-fb-inspect]')[0]
ok('tier 2 outlines the hovered element', overlay.style.display === 'block' && overlay.style.width === '200px',
  `${overlay.style.display} ${overlay.style.width}`)

// pick it
let activated = 0
target.addEventListener('click', () => activated++)
target.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
ok('tier 2 picks without activating the element', activated === 0, `${activated} activations`)
const sel = dom.window.document.querySelector('.fb-inspect-sel')?.value
ok('tier 2 resolves a selector for the picked element', sel === '#target', sel)
await new Promise((r) => setTimeout(r, 20))
ok('tier 2 copies the selector on pick', copied[0] === '#target', copied.join(','))
ok('tier 2 confirms the copy', dom.window.document.querySelector('.fb-inspect-status.ok')?.textContent === 'Copied')
ok('tier 2 tears the picker down after a pick',
  dom.window.document.querySelector('[data-fb-inspect]') === null && dom.window.document.body.style.cursor === '')

// Escape cancels
btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
ok('tier 2 re-arms', dom.window.document.querySelector('[data-fb-inspect]') !== null)
dom.window.document.body.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
ok('tier 2 cancels on Escape', dom.window.document.querySelector('[data-fb-inspect]') === null &&
  dom.window.document.body.style.cursor === '' && btn.getAttribute('aria-pressed') === 'false')

// clicking the button again cancels rather than selecting the button
btn.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
ok('tier 2 cancels when its own button is clicked', dom.window.document.querySelector('[data-fb-inspect]') === null)

// the idempotency marker tier 2 relies on
ok('the marker main() checks for is present in tier 2', DOMFALLBACK.includes('function fbInspDom()'))

// --- 4 a failed mount announces itself -----------------------------------------------------
// This is the case nothing else can catch. A bundle that parses cleanly falls through both tiers
// and exits 0, so exit codes, the log and the notification are ALL silent while the button is
// simply absent. The renderer has no channel back to ensure.sh, so tier 2 has to draw the notice
// itself.
ok('tier 2 has a mount deadline to give up on', DOMFALLBACK.includes('FB_INSP_MOUNT_TIMEOUT') && /setTimeout/.test(DOMFALLBACK))
ok('tier 2 announces instead of failing silently', DOMFALLBACK.includes('announce') && DOMFALLBACK.includes('data-fb-inspect-failed'))

// The happy path must NOT announce: a notice on a working install is worse than no notice. The
// structural half of that is that announce() is only reachable from the deadline callback, guarded
// by a not-mounted check; the behavioural half is driven for real at the end of this block.
ok('announce is only reachable from the deadline, and only when unmounted',
  /if\(!wrap\|\|!wrap\.isConnected\)announce\(\)/.test(DOMFALLBACK) &&
    (DOMFALLBACK.match(/announce\(\)/g) || []).length === 2, // the definition, and the one call
)

// Drive it for real: a document whose panel markup does not match, with a short deadline.
{
  const dom2 = new JSDOM('<!doctype html><body><div class="panel-tabs"><button class="panel-tab" id="t1">Browser</button></div></body>', { url: 'https://localhost/' })
  const errs = []
  const ctx2 = vm.createContext({
    window: dom2.window,
    document: dom2.window.document,
    MutationObserver: dom2.window.MutationObserver,
    Promise,
    console: { error: (m) => errs.push(String(m)), warn: () => {}, log: () => {} },
    // The deadline is a bare identifier on purpose, so the test can shorten it. Absent in the
    // real bundle, where typeof makes it fall back to 60s.
    FB_INSP_MOUNT_TIMEOUT: 40,
  })
  new vm.Script(DOMFALLBACK, { filename: 'fbdom-nohost.js' }).runInContext(ctx2)
  await new Promise((r) => setTimeout(r, 90))

  const notice = dom2.window.document.querySelector('div[data-fb-inspect-failed]')
  ok('an unmounted inspector raises a visible notice', !!notice, notice ? '' : 'no notice appeared')
  ok('the notice says what happened', /could not mount/.test(notice?.textContent || ''), notice?.textContent?.slice(0, 60))
  ok('the notice is announced to assistive tech', notice?.getAttribute('role') === 'status')
  ok('the notice leaves an inspectable mark on <html>', dom2.window.document.documentElement.hasAttribute('data-fb-inspect-failed'))
  ok('the notice also reaches the console, for devtools', errs.some((e) => /did not mount/.test(e)), errs[0]?.slice(0, 70))
  ok('the notice offers a dismiss control', !!notice?.querySelector('button[aria-label="Dismiss this notice"]'))
  ok('and no inspector button was mounted', dom2.window.document.querySelector('.fb-inspect-btn') === null)

  // Dismissing must not resurrect the notice on the next MutationObserver tick.
  notice?.querySelector('button')?.dispatchEvent(new dom2.window.Event('click', { bubbles: true }))
  ok('the notice can be dismissed', dom2.window.document.querySelector('div[data-fb-inspect-failed]') === null)
  dom2.window.document.body.appendChild(dom2.window.document.createElement('span'))
  await new Promise((r) => setTimeout(r, 40))
  ok('and a dismissed notice does not come back', dom2.window.document.querySelector('div[data-fb-inspect-failed]') === null)

  // The happy path in the SAME harness: the host appears in time, so nothing is announced.
  const dom3 = new JSDOM('<!doctype html><body><div class="panel-tabs"><button class="panel-add" aria-label="Open panel tab">+</button></div></body>', { url: 'https://localhost/' })
  const errs3 = []
  const ctx3 = vm.createContext({
    window: dom3.window,
    document: dom3.window.document,
    MutationObserver: dom3.window.MutationObserver,
    Promise,
    console: { error: (m) => errs3.push(String(m)), warn: () => {}, log: () => {} },
    FB_INSP_MOUNT_TIMEOUT: 40,
  })
  new vm.Script(DOMFALLBACK, { filename: 'fbdom-host.js' }).runInContext(ctx3)
  await new Promise((r) => setTimeout(r, 90))
  ok('a successful mount raises NO notice', dom3.window.document.querySelector('[data-fb-inspect-failed]') === null && errs3.length === 0)
  ok('and the button really is mounted in that document', !!dom3.window.document.querySelector('.fb-inspect-btn'))
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0