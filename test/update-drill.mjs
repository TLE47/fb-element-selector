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
// USAGE  node --experimental-vm-modules test/update-drill.mjs

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const APP_UI = '/Applications/Freebuff.app/Contents/Resources/orchestrator/ui'
const BACKUP = process.env.FREEBUFF_PATCH_BACKUP || path.join(os.homedir(), '.fb-scratch', 'freebuff-element-selector')

let failed = 0
const ok = (name, pass, detail = '') => {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}

// The pristine, never-patched originals: that is what a new release would ship.
const pristineJs = readdirSync(BACKUP).find((f) => /^index-[\w-]+\.js$/.test(f) && !f.endsWith('.orig'))
const pristineCss = readdirSync(BACKUP).find((f) => /^index-[\w-]+\.css$/.test(f) && !f.endsWith('.orig'))
if (!pristineJs || !pristineCss) {
  console.error(`no pristine pre-patch backup in ${BACKUP}; run \`node src/patch.mjs --revert\` first`)
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
  writeFileSync(path.join(brokenAssets, 'index-XYZZY.js'), 'x'.repeat(1_100_000))
  writeFileSync(path.join(brokenAssets, 'index-XYZZY.css'), 'y'.repeat(120_000))
  writeFileSync(path.join(brokenDir, 'index.html'), '<link rel="stylesheet" href="/assets/index-XYZZY.css"><script type="module" src="/assets/index-XYZZY.js">')
  let brokeCode = null
  try {
    execFileSync(process.execPath, [patcher], { env: { ...process.env, ...drillEnv, ASSETS: brokenAssets }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    brokeCode = error.status
  }
  ok('drill: a bundle with no matching anchor is refused, not patched', brokeCode === 2, `exit ${brokeCode}`)
  ok('drill: the refused bundle is untouched', readFileSync(path.join(brokenAssets, 'index-XYZZY.js'), 'latin1') === 'x'.repeat(1_100_000))

  mkdirSync(brokenAssets2, { recursive: true })
  writeFileSync(path.join(brokenAssets2, 'index-QQQQ1.js'), 'x'.repeat(1_100_000))
  writeFileSync(path.join(brokenAssets2, 'index-QQQQ1.css'), 'y'.repeat(120_000))
  writeFileSync(path.join(brokenDir2, 'index.html'), '<link rel="stylesheet" href="/assets/index-QQQQ1.css"><script type="module" src="/assets/index-QQQQ1.js">')
  const brokenEnv = { ...env, ASSETS: brokenAssets2 }
  const brokenRun = () => execFileSync('/bin/bash', [ensure], { encoding: 'utf8', env: brokenEnv })

  brokenRun()
  const firstNotice = inboxText()
  ok('drill: a moved anchor raises a notification', /needs re-anchoring/.test(firstNotice), firstNotice.trim().split('\n')[0]?.slice(0, 80))
  ok('drill: the notification names the app version and the log', /Freebuff/.test(firstNotice) && /freebuff-element-selector\.log|ensure\.log/.test(firstNotice))
  ok('drill: the broken state is recorded for dedupe', readFileSync(ensureState, 'utf8').trim().startsWith('broken:'))

  // The reason the fingerprint exists: a WatchPaths agent can fire repeatedly while the breakage
  // persists, and re-blaming the user each time trains them to ignore the banner.
  brokenRun()
  brokenRun()
  ok('drill: the same breakage does not notify again', inboxText() === firstNotice)
  ok('drill: the repeat run says so in the log', /not notifying again/.test(readFileSync(ensureLog, 'utf8')))

  // A DIFFERENT breakage is new information and must get through. The fingerprint is over the
  // patcher's OUTPUT, so the bundle has to actually fail differently: take the real release and
  // remove one anchor's text, so exactly one anchor goes missing instead of all of them.
  const { EDITS: table } = await import('../src/patch.mjs')
  const victim = table.find((e) => e.id === 'mount')
  writeFileSync(
    path.join(brokenAssets2, 'index-QQQQ1.js'),
    readFileSync(path.join(BACKUP, pristineJs), 'latin1').replace(victim.from, ']}'),
  )
  brokenRun()
  ok('drill: a different breakage notifies again', (inboxText().match(/needs re-anchoring/g) || []).length === 2 && /mount/.test(readFileSync(ensureLog, 'utf8')))

  // And recovery must be announced, or the user never learns they can stop holding their breath.
  runEnsure()
  ok('drill: recovery raises its own notification', /recovered/i.test(inboxText()))
  ok('drill: recovery resets the state to ok', readFileSync(ensureState, 'utf8').trim() === 'ok')
  const afterRecovery = inboxText()
  runEnsure()
  ok('drill: staying healthy notifies nothing further', inboxText() === afterRecovery)

  rmSync(brokenDir, { recursive: true, force: true })
  rmSync(brokenDir2, { recursive: true, force: true })

  // --- the isolation guard ---------------------------------------------------------------------
  // Every run above used a staged bundle; this proves none of them reached the installed app or
  // its backup directory. It is the check that would have caught the bug this harness once had.
  ok('drill: the installed app index.html was not modified', readFileSync(realIndexHtml, 'utf8') === realIndexBefore)
  ok('drill: the real backup directory was not modified', readdirSync(realBackupDir).sort().join(',') === realBackupBefore)

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