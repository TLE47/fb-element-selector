#!/usr/bin/env node
// test/update-drill.mjs — prove the patch survives an app update.
//
// A real update replaces the bundle wholesale under a NEW content hash, so the honest test is
// not "re-run against the same file" but: take a pristine copy of the app's bundle, rename it
// the way a new release would, patch that, and check the result actually works. Anything that
// only passes against the already-patched bundle proves nothing.
//
// It also proves the part that is easy to get catastrophically wrong: that none of those staged
// operations reached the INSTALLED app. An earlier revision of this harness had a hardcoded
// backup directory, so staging a fake release overwrote the real index.html and left the app
// serving a URL that did not exist. The isolation assertions at the end are the regression test
// for that, and they are proven to be able to fail.
//
// It needs the pristine pre-patch bytes, which live in the patcher's backup directory. On a
// machine where the app has never been patched there is nothing to stage from and it exits 2
// with an explanation; bash test/run-isolated.sh is the path that needs no prior state.
//
// USAGE  node --experimental-vm-modules test/update-drill.mjs

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_UI = '/Applications/Freebuff.app/Contents/Resources/orchestrator/ui'
const BACKUP = process.env.FREEBUFF_PATCH_BACKUP || path.join(os.homedir(), '.fb-scratch', 'fb-element-selector')

let failed = 0
const ok = (name, pass, detail = '') => {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}

// The pristine, never-patched originals: that is what a new release would ship.
//
// existsSync BEFORE readdirSync. Without it a missing backup directory threw at module scope and
// surfaced as a raw Node stack trace - so a fresh clone, where the drill legitimately cannot run,
// looked like a crash rather than the instruction it actually is. This is the same bug the patcher
// had with its asset lookup; check the precondition, then say what to do about it.
if (!existsSync(BACKUP)) {
  console.error(
    `fb-element-selector: no pristine backup in ${BACKUP}\n` +
      `  The drill needs the pre-patch bytes to stage a fake release from.\n` +
      `  Either patch the app once (node src/patch.mjs) so a backup exists, or run\n` +
      `  bash test/run-isolated.sh - which stages its own pristine copy and needs none.`,
  )
  process.exit(2)
}
const backupFiles = readdirSync(BACKUP)
const pristineJs = backupFiles.find((f) => /^index-[\w-]+\.js$/.test(f) && !f.endsWith('.orig'))
const pristineCss = backupFiles.find((f) => /^index-[\w-]+\.css$/.test(f) && !f.endsWith('.orig'))
if (!pristineJs || !pristineCss) {
  console.error(
    `fb-element-selector: ${BACKUP} holds no pristine index-*.js / index-*.css pair\n` +
      `  found: ${backupFiles.join(', ') || '(empty)'}\n` +
      `  The *.orig files are NOT it - those are the bytes as they were at RENAME time, so on\n` +
      `  an already-patched app they are already patched. Use \`node src/patch.mjs --revert\`, which\n` +
      `  restores the true originals and leaves a usable backup, or run bash test/run-isolated.sh.`,
  )
  process.exit(2)
}

const work = mkdtempSync(path.join(os.tmpdir(), 'fb-element-selector-drill-'))
const assets = path.join(work, 'assets')
const drillBackup = path.join(work, 'backup')
const newJs = 'index-NEWbuild7.js'
const newCss = 'index-NEWbuild7.css'

// The drill must not be able to touch the installed app or the real backup directory.
const realIndexHtml = path.join(APP_UI, 'index.html')
const realBackupDir = BACKUP
const realIndexBefore = readFileSync(realIndexHtml, 'utf8')
const realBackupBefore = readdirSync(realBackupDir).sort().join(',')
const drillEnv = { FREEBUFF_PATCH_BACKUP: drillBackup }

try {
  // Stage a fake "new release": the entry assets under hashes this install has never seen, and
  // index.html pointing at those new names.
  cpSync(APP_UI, work, { recursive: true })
  const liveJs = readdirSync(assets).find((f) => /^index-[\w-]+\.js$/.test(f) && statSync(path.join(assets, f)).size > 1e6)
  const liveCss = readdirSync(assets).find((f) => /^index-[\w-]+\.css$/.test(f) && statSync(path.join(assets, f)).size > 1e5)
  renameSync(path.join(assets, liveJs), path.join(assets, newJs))
  renameSync(path.join(assets, liveCss), path.join(assets, newCss))
  cpSync(path.join(BACKUP, pristineJs), path.join(assets, newJs))
  cpSync(path.join(BACKUP, pristineCss), path.join(assets, newCss))
  let html = readFileSync(path.join(work, 'index.html'), 'utf8')
  html = html.split(liveJs).join(newJs).split(liveCss).join(newCss)
  writeFileSync(path.join(work, 'index.html'), html)

  const pristineBytes = readFileSync(path.join(assets, newJs), 'latin1')
  ok('drill: the staged bundle really is unpatched', !pristineBytes.includes('function fbInspPick(on){'))

  const patcher = path.join(ROOT, 'src', 'patch.mjs')
  const ensure = path.join(ROOT, 'src', 'ensure.sh')
  const run = (args, env = {}) =>
    execFileSync(process.execPath, args, {
      env: { ...process.env, ASSETS: assets, ...drillEnv, ...env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })

  let checkFailed = false
  try {
    run([patcher, '--check'])
  } catch (error) {
    checkFailed = error.status === 1
  }
  ok('drill: --check reports not patched on a fresh release', checkFailed)
  ok('drill: --check wrote nothing', readFileSync(path.join(assets, newJs), 'latin1') === pristineBytes)

  run([patcher])
  // The patcher renames the entry to escape the app's cache, so read it where it now lives.
  const patchedPath = path.join(assets, newJs.replace('.js', '-fb-inspect.js'))
  const patched = readFileSync(patchedPath, 'latin1')
  ok('drill: the patch applies to a bundle it has never seen', patched.includes('function fbInspPick(on){') && patched.includes('function fbInspect(){'))
  ok(
    'drill: the new asset hash is re-anchored so no cached URL serves old code',
    readFileSync(path.join(work, 'index.html'), 'utf8').includes(newJs.replace('.js', '-fb-inspect.js')),
  )

  const afterFirst = patched
  run([patcher])
  ok('drill: re-running is a no-op', readFileSync(patchedPath, 'latin1') === afterFirst)
  let checkPatched = false
  try {
    run([patcher, '--check'])
  } catch (error) {
    checkPatched = error.status === 1
  }
  ok('drill: --check now reports patched (exit 1)', checkPatched)

  // The patched bytes must still be a loadable module, not just text that contains our code.
  const { SourceTextModule } = await import('node:vm')
  let parseError = null
  try {
    new SourceTextModule(patched, { identifier: 'patched drill bundle' })
  } catch (error) {
    parseError = error.message.slice(0, 120)
  }
  ok('drill: the patched bundle parses as an ES module', parseError === null, parseError)

  // Every injected blob must survive the latin1 write. The patcher reads and writes latin1 so the
  // untouched 99% of a UTF-8 bundle round-trips byte for byte - which means ANY non-ASCII character
  // in injected code is silently corrupted: a bare 0xB7 for the middot (invalid UTF-8, so the
  // browser shows a replacement character) and 0x15 for the cross (out of latin1 range entirely).
  // Neither throws, and a screenshot is the only place you would notice.
  // Bounded to the injected region ONLY, from the marker to the end of that blob - never to the end
  // of the bundle. The app's own text is legitimately full of multi-byte UTF-8 (emoji, accents) and
  // the latin1 round-trip preserves it byte for byte; scanning past our own code would flag the
  // app's characters as if they were ours. The blobs are delimited by their own closing braces.
  const blobEnd = (from, terminator) => {
    const at = patched.indexOf(terminator, from)
    return at < 0 ? '' : patched.slice(from, at + terminator.length)
  }
  const injectedBytes = [
    blobEnd(patched.indexOf('function fbInspPick(on){'), 'return done}'),
    // Tier 2 is appended last, so it runs to the end of the file.
    patched.slice(patched.indexOf('/*fb-dom*/')),
  ].filter(Boolean)
  ok('drill: the injected code carries no non-ASCII bytes',
    injectedBytes.every((seg) => seg !== '' && ![...seg].some((c) => c.codePointAt(0) > 0x7f)),
    injectedBytes.map((s, i) => `${i}:${[...new Set([...s].filter((c) => c.codePointAt(0) > 0x7f))].join('')}`).join(' '))
  // The escapes must arrive as six ASCII characters and be interpreted by the JS engine, so the
  // bytes on disk are `c2 b7` - correct UTF-8 - not a bare `b7`. Checking the RAW BYTES is the
  // whole point: read as latin1 the same bytes look like "Â·", which reads fine and would pass an
  // assertion written against the decoded string. This is asserted on the buffer, not on `patched`.
  {
    const rawPatched = readFileSync(patchedPath)
    // Locate the middot by what FOLLOWS it rather than by a hand-counted offset - "Esc to cancel"
    // is unique to our hint and cannot drift if the text is ever reworded.
    const escAt = rawPatched.indexOf('Esc to cancel')
    const before = [...rawPatched.slice(escAt - 3, escAt)]
    ok('drill: the middot reaches disk as valid UTF-8 (c2 b7), not a bare latin1 byte',
      before[0] === 0xc2 && before[1] === 0xb7, before.map((b) => b.toString(16)).join(' '))
  }
  ok('drill: the app decode would not see a stray continuation byte',
    !/[\x80-\xBF]/.test(injectedBytes.join('')), 'no lone UTF-8 continuation byte in injected code')

  const { EDITS } = await import('../src/patch.mjs')
  let restored = patched
  for (const edit of EDITS) restored = restored.replace(edit.to, edit.from)
  ok('drill: reversing the edits restores the new release byte for byte', restored === pristineBytes)

  // --- the ensure script, and the notification contract ---------------------------------------
  const ensureLog = path.join(work, 'ensure.log')
  const ensureState = path.join(work, 'ensure.state')
  const inbox = path.join(work, 'notify-inbox.txt')
  writeFileSync(inbox, '')
  const env = {
    ...process.env,
    ...drillEnv,
    ASSETS: assets,
    FREEBUFF_PATCH_LOG: ensureLog,
    FREEBUFF_PATCH_STATE: ensureState,
    FREEBUFF_PATCH_NOTIFY_CMD: path.join(ROOT, 'test', 'notify-sink.sh'),
    NOTIFY_INBOX: inbox,
  }
  const runEnsure = (e = env) => execFileSync('/bin/bash', [ensure], { encoding: 'utf8', env: e })
  const inboxText = () => readFileSync(inbox, 'utf8')

  const healthy = runEnsure()
  ok('drill: ensure runs clean against the patched release', /OK: patch is in place/.test(healthy), healthy.trim().split('\n').pop()?.slice(0, 80))
  ok('drill: a healthy release notifies nothing', inboxText() === '')
  ok('drill: a healthy release records ok as its state', readFileSync(ensureState, 'utf8').trim() === 'ok')

  // A bundle with no recognisable anchor must be refused, not half-patched.
  const brokenDir = mkdtempSync(path.join(os.tmpdir(), 'fb-es-broken-'))
  const brokenAssets = path.join(brokenDir, 'assets')
  const brokenDir2 = mkdtempSync(path.join(os.tmpdir(), 'fb-es-notify-'))
  const brokenAssets2 = path.join(brokenDir2, 'assets')
  mkdirSync(brokenAssets, { recursive: true })
  // Valid JS with BOTH tier-1 anchors defeated - which is what an update that renumbers the
  // bundle actually looks like. Two earlier fixtures were wrong in instructive ways: a buffer of
  // 'x' is rejected by the parse guard, and blanking each anchor's text with a comment leaves a
  // dangling comma (`...{id:"preview"` -> `/*gone*/,{id:...`), which is ALSO a parse failure. Both
  // looked like a broken fallback and were really a broken test.
  //
  // Renumbering is the honest simulation, and it is what a rebuild actually does. The new names
  // are prefixed so they cannot collide with an existing binding - a plain rename like nU -> xQ
  // fails to parse with "Identifier 'xQ' has already been declared".
  const { EDITS: allEdits } = await import('../src/patch.mjs')
  const renumber = (text, subs) => {
    let out = text
    for (const [from, to] of subs) out = out.replace(new RegExp(`\\b${from}\\b`, 'g'), to)
    return out
  }
  const moved = renumber(readFileSync(path.join(BACKUP, pristineJs), 'latin1'), [
    ['nU', 'fbq0'],
    ['d', 'fbq1'],
    ['le', 'fbq2'],
  ])
  let movedProblem = null
  try {
    new (await import('node:vm')).SourceTextModule(moved, { identifier: 'moved-anchor fixture' })
  } catch (error) {
    movedProblem = String(error.message).slice(0, 100)
  }
  ok('drill: the moved-anchor fixture is valid JS, so it reaches the fallback not the parse guard',
    movedProblem === null && moved.split(allEdits[0].from).length - 1 === 0,
    movedProblem || `hits=${allEdits.map((e) => moved.split(e.from).length - 1).join(',')}`)
  writeFileSync(path.join(brokenAssets, 'index-XYZZY.js'), moved)
  writeFileSync(path.join(brokenAssets, 'index-XYZZY.css'), readFileSync(path.join(BACKUP, pristineCss), 'latin1'))
  writeFileSync(path.join(brokenDir, 'index.html'), '<link rel="stylesheet" href="/assets/index-XYZZY.css"><script type="module" src="/assets/index-XYZZY.js">')
  // An unrecognisable bundle used to be REFUSED (exit 2). That contract changed on purpose: it is
  // now handled by the tier-2 DOM fallback, which needs no anchors at all. The old expectation
  // would have failed here, and the right response was to change the assertion - the behaviour
  // being asserted is the behaviour that is now wanted.
  let brokeCode = 0
  try {
    execFileSync(process.execPath, [patcher], { env: { ...process.env, ...drillEnv, ASSETS: brokenAssets }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    brokeCode = error.status
  }
  ok('drill: an unrecognisable bundle no longer fails the patch', brokeCode === 0, `exit ${brokeCode}`)
  const fallbackPath = path.join(brokenAssets, 'index-XYZZY-fb-inspect.js')
  ok('drill: it lands the DOM fallback instead', existsSync(fallbackPath) &&
    readFileSync(fallbackPath, 'latin1').includes('function fbInspDom()'))
  ok('drill: the fallback tier carries no tier-1 component', existsSync(fallbackPath) &&
    !readFileSync(fallbackPath, 'latin1').includes('function fbInspPick(on){'))

  mkdirSync(brokenAssets2, { recursive: true })
  writeFileSync(path.join(brokenAssets2, 'index-QQQQ1.css'), readFileSync(path.join(BACKUP, pristineCss), 'latin1'))
  writeFileSync(path.join(brokenDir2, 'index.html'), '<link rel="stylesheet" href="/assets/index-QQQQ1.css"><script type="module" src="/assets/index-QQQQ1.js">')
  // A DIFFERENT breakage than the one above: the real release with exactly ONE anchor's text
  // replaced. Still valid JS, so it reaches the fallback rather than the parse guard, and its
  // fingerprint differs - which is what must let it through the dedupe.
  writeFileSync(
    path.join(brokenAssets2, 'index-QQQQ1.js'),
    renumber(readFileSync(path.join(BACKUP, pristineJs), 'latin1'), [['ae', 'fbq9']]),
  )
  // The ensure stage runs against its OWN copy of the moved-anchor bundle, so its first run is a
  // genuine first patch. (An earlier revision ran it against a buffer of 'x', which the parse
  // guard rightly rejects with exit 3 - so it was testing the error path and calling it the
  // fallback path.)
  const brokenDir3 = mkdtempSync(path.join(os.tmpdir(), 'fb-es-fallback-'))
  const brokenAssets3 = path.join(brokenDir3, 'assets')
  mkdirSync(brokenAssets3, { recursive: true })
  writeFileSync(path.join(brokenAssets3, 'index-MMMM1.js'), moved)
  writeFileSync(path.join(brokenAssets3, 'index-MMMM1.css'), readFileSync(path.join(BACKUP, pristineCss), 'latin1'))
  writeFileSync(path.join(brokenDir3, 'index.html'), '<link rel="stylesheet" href="/assets/index-MMMM1.css"><script type="module" src="/assets/index-MMMM1.js">')
  const brokenEnv = { ...env, ASSETS: brokenAssets3 }
  const brokenRun = (e = brokenEnv) => execFileSync('/bin/bash', [ensure], { encoding: 'utf8', env: e })

  brokenRun()
  const firstNotice = inboxText()
  ok('drill: a moved anchor raises a degraded-mode notification', /fallback mode/.test(firstNotice), firstNotice.trim().split('\n')[0]?.slice(0, 80))
  ok('drill: the notification says it still works and points at the log', /still works/.test(firstNotice) && /fb-element-selector\.log|ensure\.log/.test(firstNotice))
  ok('drill: the fallback state is recorded for dedupe', readFileSync(ensureState, 'utf8').trim().startsWith('fallback:'))

  // The reason the fingerprint exists: a WatchPaths agent can fire repeatedly while the breakage
  // persists, and re-blaming the user each time trains them to ignore the banner.
  brokenRun()
  brokenRun()
  ok('drill: the same breakage does not notify again', inboxText() === firstNotice)
  ok('drill: the repeat run says so in the log', /not notifying again/.test(readFileSync(ensureLog, 'utf8')))
  // The re-run banner. Without this the second agent fire reports "already patched" with no tier,
  // ensure.sh reads it as tier 1 and resets the state to `ok` - the notification would then be a
  // one-shot the user almost certainly never sees, since WatchPaths fires repeatedly.
  // spawnSync, not execFileSync: the banner goes to stderr, and execFileSync only hands stderr
  // back when the child FAILS - which here it does not.
  const again = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', patcher],
    { env: { ...process.env, ...brokenEnv, ASSETS: brokenAssets3 }, encoding: 'utf8' })
  ok('drill: an idempotent re-run still reports fallback mode',
    again.status === 0 && /using the DOM fallback/.test(again.stderr),
    `exit ${again.status}: ${(again.stderr || '').trim().split('\n').pop()?.slice(0, 60)}`)

  // A DIFFERENT breakage is new information and must get through.
  brokenRun({ ...brokenEnv, ASSETS: brokenAssets2 })
  ok('drill: a different breakage notifies again', (inboxText().match(/fallback mode/g) || []).length === 2 && /mount/.test(readFileSync(ensureLog, 'utf8')),
    `notices=${(inboxText().match(/fallback mode/g) || []).length} state=${readFileSync(ensureState, 'utf8').trim()}`)

  // And recovery must be announced, or the user never learns they can stop holding their breath.
  runEnsure()
  ok('drill: recovery raises its own notification', /recovered/i.test(inboxText()))
  ok('drill: recovery resets the state to ok', readFileSync(ensureState, 'utf8').trim() === 'ok')
  const afterRecovery = inboxText()
  runEnsure()
  ok('drill: staying healthy notifies nothing further', inboxText() === afterRecovery)

  rmSync(brokenDir, { recursive: true, force: true })
  rmSync(brokenDir2, { recursive: true, force: true })
  rmSync(brokenDir3, { recursive: true, force: true })

  // --- the isolation guard ---------------------------------------------------------------------
  // Every run above used a staged bundle; this proves none of them reached the installed app or
  // its backup directory. It is the check that would have caught the bug this harness once had.
  ok('drill: the installed app index.html was not modified', readFileSync(realIndexHtml, 'utf8') === realIndexBefore)
  ok('drill: the real backup directory was not modified', readdirSync(realBackupDir).sort().join(',') === realBackupBefore)

  // 11. --revert must REFUSE a backup whose index.html points at assets that do not exist. Such
  //     a backup is self-perpetuating: revert copies it straight back, so the app is left serving
  //     a renderer that was never written. This actually happened here - a poisoned backup
  //     silently undid a manual repair on the next revert - so it is worth a hard failure.
  {
    const poisonDir = mkdtempSync(path.join(os.tmpdir(), 'fb-es-poison-'))
    const poisonAssets = path.join(poisonDir, 'assets')
    const poisonBackup = path.join(poisonDir, 'backup')
    mkdirSync(poisonAssets, { recursive: true })
    mkdirSync(poisonBackup, { recursive: true })
    cpSync(path.join(BACKUP, pristineJs), path.join(poisonAssets, 'index-POISON1.js'))
    cpSync(path.join(BACKUP, pristineCss), path.join(poisonAssets, 'index-POISON1.css'))
    // A healthy app to begin with: index.html points at the assets that actually exist.
    writeFileSync(
      path.join(poisonDir, 'index.html'),
      '<link rel="stylesheet" href="/assets/index-POISON1.css"><script type="module" src="/assets/index-POISON1.js">',
    )
    const env2 = { ...process.env, FREEBUFF_PATCH_BACKUP: poisonBackup, ASSETS: poisonAssets }
    const appHtmlPath = path.join(poisonDir, 'index.html')
    // Patch for real, so the app is healthy and correctly renamed.
    execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', patcher], { env: env2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    const patchedHtml = readFileSync(appHtmlPath, 'utf8')
    ok('drill: the staged app points at renamed assets before any revert', patchedHtml.includes('index-POISON1-fb-inspect.js'), patchedHtml.match(/assets\/index-[^"']+/)?.[0])
    // Now poison the BACKUP, which is how the real incident arose: a staged run overwrote it.
    writeFileSync(path.join(poisonBackup, 'index.html'), '<link rel="stylesheet" href="/assets/index-GHOST1.css"><script type="module" src="/assets/index-GHOST1.js">')
    let poisonErr = null
    try {
      execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', patcher, '--revert'], { env: env2, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      poisonErr = `${error.status}:${error.stderr || ''}`
    }
    ok('drill: --revert refuses a backup pointing at non-existent assets', !!poisonErr && /refusing to restore/.test(poisonErr), (poisonErr || 'it reverted silently').slice(0, 90))
    ok('drill: the refused revert left the app index.html untouched', readFileSync(appHtmlPath, 'utf8') === patchedHtml)
    ok('drill: and it still points at the real asset, not the ghost one', readFileSync(appHtmlPath, 'utf8').includes('index-POISON1-fb-inspect.js') && !readFileSync(appHtmlPath, 'utf8').includes('GHOST'))
    rmSync(poisonDir, { recursive: true, force: true })
  }

  // 12. The exit-code contract, measured rather than assumed. Two things were wrong here:
  //     the docs said exit 2 meant "the anchors moved", which stopped being true when tier 2
  //     made that path exit 0; and a missing entry bundle threw at MODULE scope, so it escaped
  //     main()'s handler as a raw Node stack trace with exit 1 - indistinguishable, to --check,
  //     from "not patched". Both are the kind of thing nobody notices until an agent is
  //     quietly failing for a reason the log does not explain.
  {
    const noneDir = mkdtempSync(path.join(os.tmpdir(), 'fb-es-noentry-'))
    mkdirSync(path.join(noneDir, 'assets'), { recursive: true })
    const res = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', patcher],
      { env: { ...process.env, ASSETS: path.join(noneDir, 'assets'), FREEBUFF_PATCH_BACKUP: path.join(noneDir, 'backup') }, encoding: 'utf8' })
    const err = res.stderr || ''
    ok('drill: a missing entry bundle exits 2 with a clean message, not a stack trace',
      res.status === 2 && /no \/\^index/.test(err) && !/at .*\(.*:\d+:\d+\)/.test(err),
      `exit ${res.status}: ${err.trim().split('\n')[0]?.slice(0, 70)}`)
    rmSync(noneDir, { recursive: true, force: true })
  }

  // 10. The entry-point guard must work from a SYMLINKED path. On macOS /var is a symlink to
  //     /private/var, so `mktemp -d` hands out a path that differs from import.meta.url. When
  //     the guard compared them verbatim, main() never ran and the script exited 0 having done
  //     nothing - a no-op that looks like success. This is the regression test for that.
  const linkWork = mkdtempSync(path.join(os.tmpdir(), 'fb-es-symlink-'))
  try {
    mkdirSync(path.join(linkWork, 'assets'), { recursive: true })
    cpSync(path.join(BACKUP, pristineJs), path.join(linkWork, 'assets', 'index-LINK01.js'))
    cpSync(path.join(BACKUP, pristineCss), path.join(linkWork, 'assets', 'index-LINK01.css'))
    writeFileSync(path.join(linkWork, 'index.html'), '<link rel="stylesheet" href="/assets/index-LINK01.css"><script type="module" src="/assets/index-LINK01.js">')
    const patchedVia = path.join(linkWork, 'assets', 'index-LINK01-fb-inspect.js')
    const out = execFileSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', patcher], {
      env: { ...process.env, ASSETS: path.join(linkWork, 'assets'), FREEBUFF_PATCH_BACKUP: path.join(linkWork, 'backup') },
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    })
    const outText = `${out}${''}`
    ok('drill: the patcher actually runs from a symlinked path (mktemp on macOS)', existsSync(patchedVia), outText.slice(0, 120))
    if (existsSync(patchedVia)) {
      ok('drill: and what it wrote there is the real patch', readFileSync(patchedVia, 'latin1').includes('function fbInspPick(on){'))
    }
  } finally {
    rmSync(linkWork, { recursive: true, force: true })
  }
} finally {
  rmSync(work, { recursive: true, force: true })
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0