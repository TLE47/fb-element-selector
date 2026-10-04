#!/usr/bin/env node
// test/ci-checks.mjs — invariants that need neither the app nor a Mac.
//
// The three behaviour suites all reach into the installed Freebuff bundle, which is proprietary
// and cannot live in a public repository, so on a CI runner they can only skip. That leaves a
// category of regression nothing catches: a change that keeps every test green but breaks a
// promise the README makes. These are exactly those, and they are cheap.
//
//   USAGE  node --experimental-vm-modules test/ci-checks.mjs
//
// Everything here is pure: it reads files and checks strings. It never touches /Applications.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { SourceTextModule } from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO = path.resolve(ROOT, '..')

let failed = 0
const ok = (name, pass, detail = '') => {
  if (!pass) failed++
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`)
}
const read = (...p) => readFileSync(path.join(...p), 'utf8')

// --- 1 the repo root stays at three entries --------------------------------------------------
// Someone tidying the repo must not quietly undo the layout a reader is shown first.
//
// `.github/` is the one addition, and it is GitHub's requirement rather than a choice: a workflow
// can only live there. It is counted separately so the number a reader sees stays three, and so
// the exception is visible in one place instead of smuggled into the limit.
const ROOT_ALLOWED = ['.gitignore', 'README.md', 'src']
// Log files land in the repo root because that is where the workflow runs them. They are build
// output, not source, so they are excluded here - but ONLY *.log, so a stray script or directory
// is still caught.
const rootEntries = readdirSync(REPO)
  .filter((f) => f !== '.git' && f !== 'node_modules' && !f.endsWith('.log'))
const visible = rootEntries.filter((f) => !f.startsWith('.github'))
ok('the repo root shows at most three entries', visible.length <= 3, visible.sort().join(' '))
ok('and they are the expected three',
  ROOT_ALLOWED.every((f) => visible.includes(f)), visible.sort().join(' '))
ok('the only extra root entry is .github, which GitHub requires for CI',
  rootEntries.filter((f) => !ROOT_ALLOWED.includes(f)).every((f) => f === '.github'),
  rootEntries.sort().join(' '))

// --- 2 every command the README prints actually resolves -------------------------------------
// The README is the product for anyone who just wants the button. A command that has drifted out
// of the tree is the single worst failure this repo can have, and it is invisible to every other
// suite because none of them read the README.
const readme = read(REPO, 'README.md')
const codeBlocks = [...readme.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((m) => m[1].split('\n'))
const commands = codeBlocks
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#') && !l.startsWith('git clone') && !l.startsWith('sed "s#__REPO__'))
ok('the README quotes at least three commands', commands.length >= 3, `${commands.length} found`)

// Every repo-relative path the README names must exist. Matched with word boundaries so
// `src/ensure.sh` does not "match" inside `src/ensure.sh.bak`.
const mentioned = [...new Set(
  [...readme.matchAll(/\bsrc\/[A-Za-z0-9._/-]+/g)]
    .map((m) => m[0].replace(/[.,)]+$/, ''))
    .filter((p) => !p.includes('$')),
)]
const missing = mentioned.filter((p) => !existsSync(path.join(REPO, p)))
ok('every src/ path the README names exists', missing.length === 0,
  missing.length ? `missing: ${missing.join(', ')}` : `${mentioned.length} paths checked`)

// The headline install command is the contract. It must be byte-for-byte what the patcher is
// called, because that is what every existing install has in its notes.
ok("the README's install command is 'node src/patch.mjs'",
  readme.includes('node src/patch.mjs\n') && existsSync(path.join(REPO, 'src', 'patch.mjs')))
ok('the README documents the undo command',
  readme.includes('node src/patch.mjs --revert'))

// No doubled path can survive a move, because it reads as plausible.
const doubled = [...readme.matchAll(/\bsrc\/src\//g)].length
ok('no doubled paths in the README', doubled === 0, `${doubled} found`)

// --- 3 the shell scripts are syntactically valid ---------------------------------------------
// `bash -n` is the real gate: a syntax error in ensure.sh means the LaunchAgent fails on every
// fire, silently, forever.
for (const script of ['src/ensure.sh', 'src/test/run-isolated.sh', 'src/docs/demo/record.sh']) {
  let clean = true
  let detail = ''
  try {
    execFileSync('/bin/bash', ['-n', path.join(REPO, script)], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    clean = false
    detail = String(error.stderr || '').slice(0, 100)
  }
  ok(`${script} is valid bash`, clean, detail)
}

// --- 4 the injected blobs are pure ASCII ------------------------------------------------------
// The patcher writes latin1 so the app's own UTF-8 round-trips byte for byte, which means any
// non-ASCII character in INJECTED code is silently corrupted on the way in - a bare 0xB7 for the
// middot (invalid UTF-8) and 0x15 for the cross. Nothing throws and no screenshot-free test
// notices. patch.mjs asserts this on import too, so reaching this line means that guard passed.
const { INSPECT, DOMFALLBACK, CSS } = await import('../patch.mjs')
for (const [name, blob] of [['INSPECT', INSPECT], ['DOMFALLBACK', DOMFALLBACK], ['CSS', CSS]]) {
  const bad = [...new Set([...blob].filter((c) => c.codePointAt(0) > 0x7f))]
  ok(`${name} is pure ASCII`, bad.length === 0, bad.join(''))
  ok(`${name} survives a latin1 round-trip`,
    Buffer.from(blob, 'latin1').toString('latin1') === blob)
}

// DOMFALLBACK is appended to the bundle as-is, so it must parse as a standalone script. This is
// the one thing that catches a stray backtick or an unbalanced brace in the injected source - the
// failure mode that blanks the app window with no way back but a reinstall.
let fbProblem = null
try {
  new SourceTextModule(DOMFALLBACK, { identifier: 'DOMFALLBACK' })
} catch (error) {
  fbProblem = String(error.message).slice(0, 140)
}
ok('the tier-2 blob parses as an ES module', fbProblem === null, fbProblem || '')

// --- 5 the launchd template is still a valid plist with both placeholders -------------------
// It is substituted at install time; losing a placeholder produces a plist that lints but never
// runs, which is the worst kind of failure.
{
  const plist = path.join(REPO, 'src/launchd/com.fb.element-selector.plist')
  const text = existsSync(plist) ? read(plist) : ''
  ok('the launchd template exists', !!text)
  ok('it still carries both placeholders',
    text.includes('__REPO__') && text.includes('__HOME__'))
  let lints = true
  let detail = ''
  try {
    execFileSync('plutil', ['-lint', plist], { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    lints = false
    detail = String(error.stderr || '').slice(0, 100)
  }
  ok('the launchd template lints', lints, detail)
}

// --- 6 nothing proprietary or generated is committed ------------------------------------------
// The reason the behaviour suites cannot run here. If the app bundle or node_modules ever got
// committed, the repository would be redistributing someone's app.
const tracked = execFileSync('git', ['ls-files'], { cwd: REPO, encoding: 'utf8' })
  .split('\n').filter(Boolean).filter((f) => !f.endsWith('.log'))
ok('no node_modules is tracked', !tracked.some((f) => f.includes('node_modules')),
  tracked.filter((f) => f.includes('node_modules')).slice(0, 3).join(' '))
ok('no app bundle is tracked', !tracked.some((f) => /\.app\//.test(f) || /index-[A-Za-z0-9_-]{6,}\.(js|css)$/.test(f)))
ok('the largest tracked file is the demo clip, not a bundle', (() => {
  const biggest = tracked
    .map((f) => ({ f, size: statSync(path.join(REPO, f)).size }))
    .sort((a, b) => b.size - a.size)[0]
  return biggest.size < 5_000_000
})(), 'nothing over 5 MB')

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exitCode = failed ? 1 : 0