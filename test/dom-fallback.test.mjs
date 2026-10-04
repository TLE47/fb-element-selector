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

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0