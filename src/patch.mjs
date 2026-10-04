#!/usr/bin/env node
// patch.mjs — add a DevTools-style element inspector to the Freebuff desktop app.
//
// WHAT IT DOES
//   The Freebuff desktop app ships as a built bundle, so a feature added to it is a patch to
//   the shipped file. This adds a magnifier button to the right panel's tab strip - immediately
//   left of the "+" that opens the panel launcher. Click it and the cursor becomes a crosshair;
//   a purple outline tracks whatever you hover, labelled with its tag, classes and size; click
//   to select it and read a CSS selector you can paste straight into devtools. Escape or a
//   second click cancels.
//
// WHY IT EXISTS WHEN THE APP ALREADY SHIPS AN INSPECTOR
//   The app has one, but only for the preview webview: `gqe` injects a picker script into the
//   previewed page with `executeJavaScript`, so it can select elements of *the site being
//   previewed* and nothing else. It cannot reach the Freebuff chrome - not the composer, not
//   the sidebar, not the tabs. This one runs in the renderer against `document.body`, so it
//   picks any element of the app itself.
//
// HOW IT SURVIVES UPDATES
//   An update replaces the bundle wholesale, under a new content hash, so a hand edit is lost
//   while a script can be re-run. The entry assets are resolved by size rather than by name, so
//   a new hash needs no edit here. There are TWO tiers: tier 1 injects a React component and
//   leans on three minified identifiers the bundler assigns, while tier 2 is appended and needs
//   no anchor at all - so a rebuild that renumbers the bundle degrades to plain DOM rather than
//   losing the feature. The patched source is parsed as an ES module before it is allowed to
//   reach disk: `node --check` is useless for this (it exits 0 on any file containing ESM
//   syntax), and an unparseable bundle would leave the app with a blank window and no way back
//   but a reinstall. Pair this with ensure.sh / the LaunchAgent to re-apply automatically.
//
// USAGE
//   node src/patch.mjs            patch (default)
//   node src/patch.mjs --check    report only; exit 1 if not patched, 1 if already patched
//   node src/patch.mjs --revert   restore the last pre-patch backup
//
// ENV
//   ASSETS                 the assets directory (default: the installed app's)
//   FREEBUFF_PATCH_BACKUP  where to keep pre-patch backups (default: ~/.fb-scratch/…)
//
// Exit codes: 0 ok · 1 not patched (or, with --check, already patched) · 2 the patcher could not
// run (no app, no entry bundle, --revert with nothing to restore), nothing written · 3 the patched
// bundle would not parse, nothing written. A moved anchor is NOT an error any more: tier 2 takes
// over and the run still exits 0.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, existsSync, statSync, realpathSync } from 'node:fs'
import * as fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import url from 'node:url'

const ASSETS =
  process.env.ASSETS || '/Applications/Freebuff.app/Contents/Resources/orchestrator/ui/assets'
// Overridable so the update drill can run against a staged bundle without writing into the
// real backup directory. It previously was not, and a test harness that can clobber production
// state is not a harness.
const BACKUP =
  process.env.FREEBUFF_PATCH_BACKUP || path.join(os.homedir(), '.fb-scratch', 'fb-element-selector')
export const MARK = 'fb-inspect'

// The renderer entry is the only non-chunk asset named index-*.js; the several hundred other
// index-*.js files are syntax-highlighting chunks, so the size separates them too.
function entryAsset(pattern, minSize) {
  const hit = readdirSync(ASSETS)
    .filter((f) => pattern.test(f))
    .map((f) => ({ f, size: statSync(path.join(ASSETS, f)).size }))
    .filter((x) => x.size >= minSize)
    .sort((a, b) => b.size - a.size)[0]
  if (!hit) throw new Error(`no ${pattern} over ${minSize} bytes in ${ASSETS}`)
  return path.join(ASSETS, hit.f)
}

// Resolved LAZILY, not at module scope. At module scope a missing entry threw during import, so
// the failure escaped main()'s handler as an unhandled stack trace and exited 1 - which reads as
// "not patched" to --check and dumps a raw Node trace at anyone running it by hand. Lazy means the
// throw happens inside main(), where it becomes the clean one-line message and exit 2.
// It also lets the tests import this module for EDITS without an app present.
let jsFile = null
let cssFile = null
const JS_FILE = () => (jsFile ??= entryAsset(/^index-[\w-]+\.js$/, 1_000_000))
const CSS_FILE = () => (cssFile ??= entryAsset(/^index-[\w-]+\.css$/, 100_000))

// latin1 round-trips bytes 1:1, so the untouched 99% of a UTF-8 bundle survives verbatim.
const read = (f) => readFileSync(f, 'latin1')
const write = (f, s) => writeFileSync(f, Buffer.from(s, 'latin1'))

// --- the injected inspector -----------------------------------------------------------------
// Two rules the injected code must obey, both learned the hard way:
//
//   * `d.jsx(type, props, ...children)` is NOT the variadic form. The jsx runtime takes
//     (type, config, maybeKey) and SILENTLY DROPS everything past the third argument, so every
//     multi-child element spells its children in `config.children`. Getting this wrong renders
//     an empty component and throws nothing.
//
//   * No backticks and no `${}` here: this string is itself a template literal, so any
//     interpolation would be evaluated at patch time instead of landing in the bundle.
//
// It closes over three module-scope identifiers, all declared before the injection point:
// `k` (React), `d` (the jsx runtime) and `le` (the app's Icon component).
export const INSPECT =
  `function fbInspEsc(s){try{return CSS.escape(s)}catch{return s}}` +
  `function fbInspSel(el){if(!el||el.nodeType!==1)return"";` +
  `if(el.id)return "#"+fbInspEsc(el.id);` +
  `const p=[];` +
  `for(let n=el;n&&n.nodeType===1&&n!==document.body&&p.length<6;n=n.parentElement){` +
  `if(n.id){p.unshift("#"+fbInspEsc(n.id));break}` +
  `let s=n.tagName.toLowerCase();` +
  `const k=[...n.classList].filter(x=>!/^(is-|has-)/.test(x)).slice(0,2);` +
  `if(k.length)s+="."+k.map(fbInspEsc).join(".");` +
  `const par=n.parentElement;` +
  `if(par){const all=[...par.children],same=all.filter(c=>c.tagName===n.tagName);` +
  `if(same.length>1)s+=":nth-of-type("+(all.indexOf(n)+1)+")"}` +
  `p.unshift(s)}` +
  `return p.join(" > ")||"html"}` +
  `function fbInspDesc(el){const r=el.getBoundingClientRect();` +
  `const cn=typeof el.className==="string"?el.className.trim():"";` +
  `return el.tagName.toLowerCase()+(cn?"."+cn.split(/\\s+/).slice(0,2).join("."):"")+"  "` +
  `+Math.round(r.width)+"x"+Math.round(r.height)}` +
  // The picker. Listeners go on `window` in the CAPTURE phase so they see the event before any
  // React handler, and the pick click is consumed (preventDefault + stopPropagation) so that
  // selecting an element never also activates it - the thing DevTools does.
  `function fbInspPick(on){` +
  `const oc=document.createElement("div"),lb=document.createElement("div");` +
  `for(const x of[oc,lb]){x.setAttribute("data-fb-inspect","");document.body.appendChild(x)}` +
  `oc.style.cssText="position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #7c5cff;background:rgba(124,92,255,.12);display:none";` +
  `lb.style.cssText="position:fixed;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:4px;background:#5b3ee4;color:#fff;font:11px/1.4 ui-monospace,Menlo,monospace;white-space:nowrap;display:none";` +
  `const RAF=window.requestAnimationFrame?window.requestAnimationFrame.bind(window):f=>window.setTimeout(f,16);` +
  `const prev=document.body.style.cursor;document.body.style.cursor="crosshair";` +
  `let raf=0,last=null,over=false;` +
  `const paint=()=>{raf=0;if(!last)return;const r=last.getBoundingClientRect();` +
  `if(!r.width&&!r.height){oc.style.display="none";lb.style.display="none";return}` +
  `oc.style.display="block";oc.style.left=r.left+"px";oc.style.top=r.top+"px";` +
  `oc.style.width=r.width+"px";oc.style.height=r.height+"px";` +
  `lb.style.display="block";lb.textContent=fbInspDesc(last);` +
  `lb.style.left=Math.max(0,Math.min(r.left,window.innerWidth-lb.offsetWidth-8))+"px";` +
  `lb.style.top=Math.max(0,r.top-lb.offsetHeight-6)+"px"};` +
  `const skip=t=>!t||t.nodeType!==1||t.closest("[data-fb-inspect],[data-fb-inspect-ui]");` +
  `const move=e=>{if(!over||skip(e.target))return;last=e.target;if(!raf)raf=RAF(paint)};` +
  `const click=e=>{if(!over||skip(e.target))return;const el=e.target;` +
  `e.preventDefault();e.stopPropagation();done();on(el)};` +
  `const key=e=>{if(!over||e.key!=="Escape")return;e.preventDefault();e.stopPropagation();done();on(null)};` +
  `const done=()=>{over=false;` +
  `window.removeEventListener("mousemove",move,true);` +
  `window.removeEventListener("click",click,true);` +
  `window.removeEventListener("keydown",key,true);` +
  `document.body.style.cursor=prev;oc.remove();lb.remove();last=null};` +
  `over=true;` +
  `window.addEventListener("mousemove",move,true);` +
  `window.addEventListener("click",click,true);` +
  `window.addEventListener("keydown",key,true);` +
  `return done}` +
  // Clipboard. The app's own Cmd+C in the terminal calls navigator.clipboard.writeText
  // unguarded, so that is the API that works here - but an unguarded call cannot tell you it
  // failed, and a picker that silently copies nothing is worse than one that does not. So the
  // write is reported back and the readout says so, with a textarea+execCommand fallback for
  // when the async Clipboard API is unavailable or refuses.
  `function fbInspCopyFallback(s){try{` +
  `const ta=document.createElement("textarea");ta.value=s;` +
  `ta.setAttribute("readonly","");` +
  `ta.style.cssText="position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;pointer-events:none";` +
  `document.body.appendChild(ta);ta.select();` +
  `const ok=!!(document.execCommand&&document.execCommand("copy"));` +
  `ta.remove();return ok}catch{return !1}}` +
  `function fbInspCopy(s){try{` +
  // window.navigator, NOT a bare navigator: a bare global throws ReferenceError in any scope
  // where it is not defined, and that throw would be swallowed by this very catch and read as
  // "copy failed" on every pick.
  `const c=window.navigator&&window.navigator.clipboard;` +
  `if(c&&c.writeText)` +
  `return Promise.resolve(c.writeText(s)).then(()=>!0,()=>fbInspCopyFallback(s));` +
  `return Promise.resolve(fbInspCopyFallback(s))}catch{return Promise.resolve(!1)}}` +
  `function fbInspect(){` +
  `const[b,R]=k.useState(!1),[out,S]=k.useState(null),stop=k.useRef(null);` +
  `const cancel=()=>{if(stop.current){stop.current();stop.current=null}};` +
  `k.useEffect(()=>()=>cancel(),[]);` +
  // Picking copies the selector straight away - that is the whole point of the tool - and the
  // outcome is written back onto THIS pick only, guarded by the selector, so a slow write from
  // an earlier pick cannot relabel a newer one.
  `const show=o=>{S(o);fbInspCopy(o.sel).then(ok=>S(p=>p&&p.sel===o.sel?{...p,copied:ok?"ok":"fail"}:p))};` +
  `const toggle=()=>{if(b){cancel();R(!1);return}S(null);R(!0);` +
  `stop.current=fbInspPick(el=>{stop.current=null;R(!1);if(!el)return;` +
  `const r=el.getBoundingClientRect();` +
  `show({sel:fbInspSel(el),desc:el.tagName.toLowerCase()+"  "+Math.round(r.width)+"x"+Math.round(r.height),copied:""})})};` +
  `const copy=()=>{const s=out?out.sel:"";if(!s)return;fbInspCopy(s).then(()=>S(null))};` +
  `return d.jsxs("div",{className:"fb-inspect","data-fb-inspect-ui":"",children:[` +
  `d.jsx("button",{type:"button",className:b?"panel-add fb-inspect-btn on":"panel-add fb-inspect-btn",` +
  `"aria-label":b?"Cancel element selection":"Inspect an element in the app","aria-pressed":b,` +
  `title:b?"Esc also cancels":"Pick any element in Freebuff",onClick:toggle,children:d.jsx(le,{name:"inspect"})}),` +
  `b?d.jsx("span",{className:"fb-inspect-hint",role:"status",children:"Click an element · Esc to cancel"}):null,` +
  `out?d.jsxs("div",{className:"fb-inspect-out",children:[` +
  `d.jsx("input",{className:"fb-inspect-sel",readOnly:!0,value:out.sel,` +
  `onFocus:s=>s.target.select(),onClick:s=>s.target.select(),title:out.sel,` +
  `"aria-label":"Selected element CSS selector"}),` +
  `d.jsx("span",{className:"fb-inspect-meta",children:out.desc}),` +
  // role=status so a screen reader announces the copy result, since there is no other cue.
  `out.copied?d.jsx("span",{className:"fb-inspect-status "+out.copied,role:"status",` +
  `children:out.copied==="ok"?"Copied":"Copy failed - select and copy manually"}):null,` +
  `d.jsx("button",{type:"button",className:"fb-inspect-copy","aria-label":"Copy selector and close",` +
  `title:"Copy selector",onClick:copy,children:d.jsx(le,{name:"x"})})]}):null]})}`

// --- tier 2: the fallback that survives a renumbered bundle ----------------------------------
// Tier 1 above injects a React component and depends on three MINIFIED identifiers - `k` (React),
// `d` (the jsx runtime) and `le` (the app's Icon). Those are assigned by the bundler, so a
// rebuild can rename any of them and the patch silently fails to mount.
//
// This tier depends on nothing minified. It is appended to the bundle, mounts a plain-DOM button
// beside the panel launcher's "+", and finds that button by `className:"panel-add"` plus
// `aria-label:"Open panel tab"` - strings that come from the app's SOURCE and survive
// minification. The picker itself is pure DOM, so the behaviour is identical.
//
// It is only used when tier 1's anchors do not resolve, so the two can never both mount.
export const DOMFALLBACK =
  `/*fb-dom*/function fbInspSelD(el){if(!el||el.nodeType!==1)return"";` +
  `if(el.id)return "#"+el.id.replace(/([^\w-])/g,"\\$1");` +
  `var p=[];` +
  `for(var n=el;n&&n.nodeType===1&&n!==document.body&&p.length<6;n=n.parentElement){` +
  `if(n.id){p.unshift("#"+n.id);break}` +
  `var s=n.tagName.toLowerCase();` +
  `var cls=Array.prototype.slice.call(n.classList||[]).filter(function(x){return !/^(is-|has-)/.test(x)}).slice(0,2);` +
  `if(cls.length)s+="."+cls.join(".");` +
  `var par=n.parentElement;` +
  `if(par){var all=Array.prototype.slice.call(par.children);` +
  `var same=all.filter(function(c){return c.tagName===n.tagName});` +
  `if(same.length>1)s+=":nth-of-type("+(all.indexOf(n)+1)+")"}` +
  `p.unshift(s)}` +
  `return p.join(" > ")||"html"}` +
  `function fbInspCopyD(s){try{` +
  `if(window.navigator&&window.navigator.clipboard&&window.navigator.clipboard.writeText)` +
  `return Promise.resolve(window.navigator.clipboard.writeText(s)).then(function(){return true},function(){return false});` +
  `return Promise.resolve(false)}catch{return Promise.resolve(false)}}` +
  // The picker is pure DOM, so it is shared with the React tier verbatim - same behaviour,
  // same capture-phase click consumption, same Escape.
  `function fbInspPickD(on){` +
  `var oc=document.createElement("div"),lb=document.createElement("div");` +
  `for(var i=0;i<2;i++){var x=i?lb:oc;x.setAttribute("data-fb-inspect","");document.body.appendChild(x)}` +
  `oc.style.cssText="position:fixed;z-index:2147483646;pointer-events:none;border:2px solid #7c5cff;background:rgba(124,92,255,.12);display:none";` +
  `lb.style.cssText="position:fixed;z-index:2147483647;pointer-events:none;padding:2px 6px;border-radius:4px;background:#5b3ee4;color:#fff;font:11px/1.4 ui-monospace,Menlo,monospace;white-space:nowrap;display:none";` +
  `var RAF=window.requestAnimationFrame?window.requestAnimationFrame.bind(window):function(f){return window.setTimeout(f,16)};` +
  `var prev=document.body.style.cursor;document.body.style.cursor="crosshair";` +
  `var raf=0,last=null,over=false;` +
  `function desc(el){var r=el.getBoundingClientRect();` +
  `var cn=typeof el.className==="string"?el.className.trim():"";` +
  `return el.tagName.toLowerCase()+(cn?"."+cn.split(/\s+/).slice(0,2).join("."):"")+"  "+Math.round(r.width)+"x"+Math.round(r.height)}` +
  `var paint=function(){raf=0;if(!last)return;var r=last.getBoundingClientRect();` +
  `if(!r.width&&!r.height){oc.style.display="none";lb.style.display="none";return}` +
  `oc.style.display="block";oc.style.left=r.left+"px";oc.style.top=r.top+"px";` +
  `oc.style.width=r.width+"px";oc.style.height=r.height+"px";` +
  `lb.style.display="block";lb.textContent=desc(last);` +
  `lb.style.left=Math.max(0,Math.min(r.left,window.innerWidth-lb.offsetWidth-8))+"px";` +
  `lb.style.top=Math.max(0,r.top-lb.offsetHeight-6)+"px"};` +
  `var skip=function(t){return !t||t.nodeType!==1||(t.closest&&t.closest("[data-fb-inspect],[data-fb-inspect-ui]"))};` +
  `var move=function(e){if(!over||skip(e.target))return;last=e.target;if(!raf)raf=RAF(paint)};` +
  `var done=function(){over=false;` +
  `window.removeEventListener("mousemove",move,true);` +
  `window.removeEventListener("click",click,true);` +
  `window.removeEventListener("keydown",key,true);` +
  `document.body.style.cursor=prev;oc.remove();lb.remove();last=null};` +
  `var click=function(e){if(!over||skip(e.target))return;var el=e.target;` +
  `e.preventDefault();e.stopPropagation();done();on(el)};` +
  `var key=function(e){if(!over||e.key!=="Escape")return;e.preventDefault();e.stopPropagation();done();on(null)};` +
  `over=true;` +
  `window.addEventListener("mousemove",move,true);` +
  `window.addEventListener("click",click,true);` +
  `window.addEventListener("keydown",key,true);` +
  `return done}` +
  // The UI. Plain DOM, no React: this is the whole point of the tier, so it must not touch a
  // single minified identifier.
  `function fbInspUi(){` +
  `var wrap=document.createElement("div");` +
  `wrap.className="fb-inspect";wrap.setAttribute("data-fb-inspect-ui","");` +
  `var btn=document.createElement("button");` +
  `btn.type="button";btn.className="panel-add fb-inspect-btn";` +
  `btn.title="Pick any element in Freebuff";` +
  `btn.setAttribute("aria-label","Inspect an element in the app");` +
  `btn.setAttribute("aria-pressed","false");` +
  `btn.innerHTML='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';` +
  `wrap.appendChild(btn);` +
  `var armed=false,cancel=null,out=null,status=null;` +
  `function teardown(){if(cancel){cancel();cancel=null}armed=false;` +
  `btn.classList.remove("on");btn.setAttribute("aria-pressed","false");` +
  `if(hint&&hint.parentNode)hint.remove();hint=null}` +
  `function render(){if(out){wrap.appendChild(out)}` +
  `if(status){wrap.appendChild(status)}}` +
  `var hint=null;` +
  `btn.addEventListener("click",function(ev){` +
  `ev.stopPropagation();` +
  `if(armed){teardown();return}` +
  `if(out){out.remove();out=null}` +
  `if(status){status.remove();status=null}` +
  `armed=true;btn.classList.add("on");btn.setAttribute("aria-pressed","true");` +
  `hint=document.createElement("span");` +
  `hint.className="fb-inspect-hint";hint.setAttribute("role","status");` +
  `hint.textContent="Click an element · Esc to cancel";` +
  `document.body.appendChild(hint);` +
  `cancel=fbInspPickD(function(el){teardown();` +
  `if(!el)return;` +
  `var r=el.getBoundingClientRect();` +
  `var sel=fbInspSelD(el);` +
  `out=document.createElement("div");out.className="fb-inspect-out";` +
  `var inp=document.createElement("input");` +
  `inp.className="fb-inspect-sel";inp.readOnly=true;inp.value=sel;` +
  `inp.title=sel;inp.setAttribute("aria-label","Selected element CSS selector");` +
  `inp.addEventListener("focus",function(){inp.select()});` +
  `inp.addEventListener("click",function(){inp.select()});` +
  `var meta=document.createElement("span");` +
  `meta.className="fb-inspect-meta";` +
  `meta.textContent=el.tagName.toLowerCase()+"  "+Math.round(r.width)+"x"+Math.round(r.height);` +
  `status=document.createElement("span");status.className="fb-inspect-status";status.setAttribute("role","status");` +
  `var x=document.createElement("button");` +
  `x.type="button";x.className="fb-inspect-copy";x.title="Copy selector";` +
  `x.setAttribute("aria-label","Copy selector and close");x.textContent="✕";` +
  `x.addEventListener("click",function(ev){ev.stopPropagation();fbInspCopyD(sel).then(function(){teardown()})});` +
  `out.appendChild(inp);out.appendChild(meta);` +
  `wrap.appendChild(out);render();` +
  `fbInspCopyD(sel).then(function(ok){` +
  `if(!out||out.getAttribute("data-sel")!==sel&&out.dataset.sel!==sel){}` +
  `status.className="fb-inspect-status "+(ok?"ok":"fail");` +
  `status.textContent=ok?"Copied":"Copy failed - select and copy manually";` +
  `wrap.appendChild(status)})})});` +
  `return wrap}` +
  // Mount beside the panel launcher's "+". That button is found by its class and its aria-label,
  // which are SOURCE strings - they survive minification, which is the entire reason this tier
  // exists. A MutationObserver covers the panel appearing after load.
  `(function fbInspDom(){` +
  `var wrap=null;` +
  `function host(){return document.querySelector('button.panel-add[aria-label="Open panel tab"]')}` +
  `function tryMount(){` +
  `if(wrap&&wrap.isConnected)return true;` +
  `var b=host();` +
  `if(!b||!b.parentNode)return false;` +
  `wrap=fbInspUi();` +
  `b.parentNode.insertBefore(wrap,b);` +
  `return true}` +
  `function start(){if(tryMount())return;` +
  `var mo=new MutationObserver(function(){if(tryMount())mo.disconnect()});` +
  `mo.observe(document.documentElement,{childList:true,subtree:true});` +
  `window.setTimeout(function(){mo.disconnect()},60000)}` +
  `if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start);else start()})()`

// Each edit: an anchor that must exist exactly once, and the text that replaces it.
export const EDITS = [
  {
    // Put the inspector in module scope, immediately before the panel tab list it renders into.
    // Declared there so that `k`, `d` and `le` are already in scope.
    id: 'inject',
    from: 'const nU=[{id:"preview"',
    to: `${INSPECT}const nU=[{id:"preview"`,
  },
  {
    // Left of the "+" in the tab strip. `,ae.id)})]})` closes the tab map, so the button has to
    // land between that and the panel-add button to sit on its left.
    id: 'mount',
    from: ',ae.id)})]}),d.jsx("button",{className:"panel-add","aria-label":"Open panel tab"',
    to: ',ae.id)})]}),d.jsx(fbInspect,{}),d.jsx("button",{className:"panel-add","aria-label":"Open panel tab"',
  },
]

// The button reuses the app's own `.panel-add` chrome class so it matches the "+" it sits beside
// for free; these rules only cover what `.panel-add` does not do.
export const CSS =
  `/*${MARK}*/` +
  `.fb-inspect{position:relative;display:flex;align-items:center;flex:0 0 auto;margin-left:auto}` +
  `.fb-inspect-btn.on{background:var(--raised);color:var(--accent)}` +
  // The hint is a banner, not a strip item: at strip width it would shove the tabs around.
  `.fb-inspect-hint{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;padding:5px 10px;border-radius:999px;background:var(--text);color:var(--bg);font-size:var(--font-size-label);pointer-events:none}` +
  // The readout drops below the strip so it never resizes it, and the selector takes the slack.
  `.fb-inspect-out{position:absolute;top:calc(100% + 6px);right:0;z-index:60;display:flex;align-items:center;gap:var(--space-2);max-width:min(420px,60vw);padding:6px 8px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface);box-shadow:0 8px 24px rgba(0,0,0,.28)}` +
  `.fb-inspect-sel{flex:1;min-width:0;padding:3px 6px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--text);font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}` +
  `.fb-inspect-sel:focus{outline:none;border-color:var(--accent)}` +
  `.fb-inspect-meta{flex:0 0 auto;color:var(--faint);font-size:var(--font-size-label);white-space:nowrap}` +
  // The copy result is shown rather than assumed: an unguarded writeText that silently fails
  // would make a broken copy look exactly like a working one.
  `.fb-inspect-status{flex:0 0 auto;font-size:var(--font-size-label);white-space:nowrap}` +
  `.fb-inspect-status.ok{color:var(--accent)}` +
  `.fb-inspect-status.fail{color:var(--danger)}` +
  `.fb-inspect-copy{flex:0 0 auto;display:flex;align-items:center;justify-content:center;width:22px;height:22px;border:0;border-radius:var(--radius-sm);background:transparent;color:var(--muted);cursor:pointer}` +
  `.fb-inspect-copy:hover{background:var(--raised);color:var(--text)}`

function backup(name, from) {
  mkdirSync(BACKUP, { recursive: true })
  copyFileSync(from ?? name, path.join(BACKUP, name))
}

// The bundle is content-hashed, so the app expects an unguessable name. Renaming to
// `-fb-inspect.js` gives the renderer a URL it has never cached, which is the difference between
// "reload and see it" and "reload and still see the last UI".
const SUFFIX = '-fb-inspect'
const renamed = (file) => file.replace(/(\.[a-z]+)$/, `${SUFFIX}$1`)
const unrenamed = (file) => file.replace(`${SUFFIX}.`, '.')
const isRenamed = (file) => path.basename(file).includes(SUFFIX)
const INDEX_HTML = path.join(ASSETS, '..', 'index.html')

function unrename() {
  if (!isRenamed(JS_FILE())) return
  for (const file of [JS_FILE(), CSS_FILE()]) {
    const orig = unrenamed(file)
    if (existsSync(file) && file !== orig) renameSync(file, orig)
  }
}

function revert() {
  if (!existsSync(BACKUP)) throw new Error(`no backup in ${BACKUP}`)
  const saved = path.join(BACKUP, 'index.html')
  if (existsSync(saved)) {
    // Guard against restoring a backup that references assets which do not exist. A poisoned
    // index.html in the backup is self-perpetuating: --revert copies it straight back, so the
    // app is left pointing at a renderer that was never written. This is not hypothetical - it
    // happened here, and it silently undid a manual repair on the next revert.
    const want = [unrenamed(JS_FILE()), unrenamed(CSS_FILE())].map((f) => path.basename(f))
    const backupHtml = readFileSync(saved, 'utf8')
    const missing = want.filter((f) => backupHtml.includes(f) === false)
    const alien = [...backupHtml.matchAll(/assets\/index-[\w-]+\.(?:js|css)/g)]
      .map((m) => m[0])
      .filter((ref) => !want.some((f) => ref.endsWith(f)))
    if (missing.length || alien.length) {
      throw new Error(
        `refusing to restore ${saved}: it does not reference the real assets.\n` +
          `  missing: ${missing.join(', ') || 'none'}\n` +
          `  unknown: ${[...new Set(alien)].join(', ') || 'none'}\n` +
          '  restoring it would leave the app pointing at files that do not exist',
      )
    }
    copyFileSync(saved, INDEX_HTML)
    console.error(`restored ${INDEX_HTML}`)
  }
  // Put the patched files back under their real names first, then overwrite them with the copy
  // taken BEFORE the first write. The `.orig` copies are no good here: those are what the files
  // held at rename time, which is already patched.
  unrename()
  for (const orig of [unrenamed(JS_FILE()), unrenamed(CSS_FILE())]) {
    const pristine = path.join(BACKUP, path.basename(orig))
    if (!existsSync(pristine)) {
      console.error(`fb-element-selector: no pristine copy of ${path.basename(orig)} to restore`)
      continue
    }
    copyFileSync(pristine, orig)
    console.error(`restored ${orig}`)
  }
  return 0
}

function renameAssets() {
  backup(`${path.basename(unrenamed(JS_FILE()))}.orig`, JS_FILE())
  backup(`${path.basename(unrenamed(CSS_FILE()))}.orig`, CSS_FILE())
  backup('index.html', INDEX_HTML)
  let html = readFileSync(INDEX_HTML, 'utf8')
  for (const file of [JS_FILE(), CSS_FILE()]) {
    html = html.split(path.basename(file)).join(path.basename(renamed(file)))
    renameSync(file, renamed(file))
  }
  writeFileSync(INDEX_HTML, html)
  console.error(`renamed assets to *${SUFFIX}.* and pointed index.html at them`)
}

// Parse `src` the way the renderer loads it. `node --check` is useless for this: it exits 0 on
// ANY file containing ESM syntax (measured - `export const x=1` followed by broken code passes),
// because it cannot decide whether the file is a module without a resolution step.
// SourceTextModule parses it as one, which is what the app's own `import` does.
//
// It exists only under --experimental-vm-modules, and a patcher run without that flag must still
// patch. So a missing SourceTextModule means "cannot check", NOT "broken": that returns null and
// the patch proceeds. ensure.sh and the tests both pass the flag.
async function esmProblem(src) {
  const { SourceTextModule } = await import('node:vm')
  if (typeof SourceTextModule !== 'function') return null
  try {
    // eslint-disable-next-line no-new
    new SourceTextModule(src, { identifier: 'patched bundle' })
    return null
  } catch (error) {
    return String(error.message).slice(0, 200)
  }
}

// Which tier-1 anchors are missing, and how many places each one was found. Computed on every
// run, not just the first: after a fallback patch the file is `original + DOMFALLBACK`, so the
// anchors are still absent and the same answer comes back - which is what lets ensure.sh
// fingerprint the breakage identically on a re-run and stay quiet.
function missingAnchors(src) {
  const missing = []
  for (const edit of EDITS) {
    const hits = src.split(edit.from).length - 1
    if (hits !== 1) missing.push({ id: edit.id, hits })
  }
  return missing
}

// The banner is the ONLY signal ensure.sh has, because exit 0 no longer distinguishes the tiers.
// It is printed on a first patch AND on every later no-op run, or an idempotent re-run would read
// as "tier 1, all well" and undo the degraded state.
function tier2Banner(missing) {
  console.error(
    `fb-element-selector: tier-1 anchors did not resolve, using the DOM fallback:\n` +
      missing.map((m) => `  ${m.id} (${m.hits} matches for its anchor)`).join('\n') +
      `\n  The inspector will still work, but it mounts as plain DOM rather than as a React\n` +
      `  component. Re-anchor EDITS to get tier 1 back.`,
  )
  // One machine-readable line, on its own, so a caller can fingerprint the breakage WITHOUT the
  // surrounding prose or the file names (both of which vary between a first run and a re-run).
  console.error(
    `fb-element-selector: tier=2 missing=` + missing.map((m) => `${m.id}:${m.hits}`).join(','),
  )
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--revert')) return revert()

  const js = read(JS_FILE())
  const css = read(CSS_FILE())
  // Two independent markers, because either tier may be the one that landed. `fbInspPick(on)` is
  // tier 1's picker; `fbInspDom` is tier 2's bootstrap. Checking only one would make the patcher
  // re-append on every run after a fallback patch.
  const alreadyJs = js.includes(`function fbInspPick(on){`) || js.includes('function fbInspDom()')
  const alreadyCss = css.includes('.fb-inspect-out')
  const needsRename = !isRenamed(JS_FILE())
  const renamedOk = readFileSync(INDEX_HTML, 'utf8').includes(
    path.basename(needsRename ? renamed(JS_FILE()) : JS_FILE()),
  )

  if (alreadyJs && alreadyCss && renamedOk) {
    console.error(`already patched: ${path.basename(JS_FILE())}, ${path.basename(CSS_FILE())}`)
    // An install patched via the fallback keeps reporting fallback mode forever, however many
    // times the agent fires. Without this the second run would look like tier 1 and the user
    // would never be told to re-anchor.
    if (js.includes('function fbInspDom()')) tier2Banner(missingAnchors(js))
    return argv.includes('--check') ? 1 : 0
  }
  // Patched in a previous run that died before re-anchoring: finish that step, touch nothing else.
  if (alreadyJs && alreadyCss) {
    if (js.includes('function fbInspDom()')) tier2Banner(missingAnchors(js))
    if (argv.includes('--check')) {
      console.error('patched but not re-anchored: index.html still points at the old asset URL')
      return 1
    }
    if (needsRename) renameAssets()
    return 0
  }

  // Tier 1 first: the React component, which integrates properly. If ANY anchor fails to resolve
  // exactly once, fall back to tier 2 rather than writing a half-patched bundle - a working
  // inspector that survives renumbering beats a prettier one that does not.
  let out = js
  const missing = []
  for (const edit of EDITS) {
    const hits = out.split(edit.from).length - 1
    if (hits !== 1) missing.push({ id: edit.id, hits })
    else out = out.replace(edit.from, edit.to)
  }
  const tier = missing.length ? 2 : 1
  if (tier === 2) {
    // Tier 2 needs no anchors at all: it is appended, so "insertion-only" still holds and
    // reversing it is a suffix removal.
    out = `${js}${DOMFALLBACK}`
    tier2Banner(missing)
  }

  const outCss = alreadyCss ? css : `${css}${CSS}`

  if (argv.includes('--check')) {
    console.error(`not patched: ${path.basename(JS_FILE())}, ${path.basename(CSS_FILE())}`)
    return 1
  }

  // Parse BEFORE the result can reach the app. This is the last line of defence between a bad
  // anchor producing valid-looking output and that output blanking the window on next launch.
  if (!alreadyJs) {
    const problem = await esmProblem(out)
    if (problem) {
      console.error(
        `fb-element-selector: the patched bundle would not parse, nothing written:\n  ${problem}`,
      )
      return 3
    }
  }

  // Atomic-ish: both backups first, so a failure between the two writes is still recoverable.
  if (!alreadyJs) backup(path.basename(JS_FILE()), JS_FILE())
  if (!alreadyCss) backup(path.basename(CSS_FILE()), CSS_FILE())
  if (!alreadyJs) write(JS_FILE(), out)
  if (!alreadyCss) write(CSS_FILE(), outCss)
  console.error(`patched ${path.basename(JS_FILE())} + ${path.basename(CSS_FILE())} (backup in ${BACKUP})`)
  // Re-anchor after the writes, so a crash between the two leaves a patched bundle the next run
  // can still rename (the marker check above is what makes that run idempotent).
  if (needsRename) renameAssets()
  return 0
}

// Imported by the tests for the edit table, so only this file decides what the patch is.
//
// The comparison resolves symlinks on BOTH sides. Without that it silently fails whenever the
// repo sits under a symlinked path - and on macOS /var is a symlink to /private/var, so running
// this from a mktemp -d directory made import.meta.url ("file:///private/var/...") differ from
// process.argv[1] ("/var/..."). The effect was the worst kind of failure: main() never ran and
// the script exited 0 having done nothing, so a clone in /tmp reported a successful patch that
// had not happened.
if (process.argv[1] && import.meta.url === url.pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`fb-element-selector: ${error.message}`)
    process.exitCode = 2
  }
}