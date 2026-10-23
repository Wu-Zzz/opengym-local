import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepare, promote, rollback } from './cloud-update.mjs'

const SITE = 'https://wu-zzz.github.io/opengym-local/'
const startingDir = process.cwd()
const originalFetch = globalThis.fetch
const originalEnv = { ...process.env }
let root, upstream, origin, repo, base, remoteReads
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function commit(directory, path, content, message) {
  mkdirSync(join(directory, path, '..'), { recursive: true })
  writeFileSync(join(directory, path), content)
  git('-C', directory, 'add', path)
  git('-C', directory, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', message)
  return git('-C', directory, 'rev-parse', 'HEAD')
}
const main = () => git('--git-dir', origin, 'rev-parse', 'refs/heads/main')
const metadata = () => JSON.parse(readFileSync('maintenance-transfer/release.json', 'utf8'))
const runPrepare = () => prepare({ upstreamURL: upstream, initial: base })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'opengym-cloud-test-'))
  upstream = join(root, 'upstream')
  repo = join(root, 'fork')
  origin = join(root, 'origin.git')
  git('init', '-b', 'main', upstream)
  commit(upstream, 'README.md', 'Original application\n', 'Initial upstream')
  git('clone', upstream, repo)
  commit(repo, 'frontend/src/lib/local-mode.js', 'export const LOCAL_ONLY = true\n', 'Keep phone data local')
  base = commit(repo, '.github/owned.txt', 'Fork settings\n', 'Fork configuration')
  git('clone', '--bare', repo, origin)
  git('-C', repo, 'remote', 'set-url', 'origin', origin)
  process.chdir(repo)
  process.env.EVENT_NAME = 'schedule'
  delete process.env.UPDATE_UPSTREAM
  delete process.env.VERIFY_CURRENT
  delete process.env.GITHUB_OUTPUT
  delete process.env.GITHUB_STEP_SUMMARY
  remoteReads = 0
  globalThis.fetch = async url => {
    if (String(url).startsWith(SITE)) return Response.json({ commit: base, localOnly: true, site: SITE })
    if (String(url).endsWith('/git/ref/heads/main')) { remoteReads++; return Response.json({ object: { sha: main() } }) }
    throw new Error(`Unexpected network access: ${url}`)
  }
})
afterEach(() => {
  process.chdir(startingDir)
  globalThis.fetch = originalFetch
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key]
  Object.assign(process.env, originalEnv)
  rmSync(root, { recursive: true, force: true })
})

test('unchanged upstream does not promote, build or touch remote main', async () => {
  await runPrepare()
  assert.equal(metadata().verify, false)
  assert.equal(metadata().update, false)
  assert.equal(main(), base)
  assert.equal(remoteReads, 0)
})

test('a missing production manifest must not silently select an old release', async () => {
  globalThis.fetch = async url => String(url).includes('release.json')
    ? new Response('', { status: 404 }) : new Response('Unexpected application')
  await assert.rejects(runPrepare, /not the verified original deployment/)
  assert.equal(main(), base)
})

test('safe upstream change makes a precise merge bundle, preserves local protections and promotes only that commit', async () => {
  const upstreamHead = commit(upstream, 'docs/guide.md', 'A clearer guide\n', 'Improve guide')
  await runPrepare()
  const m = metadata()
  assert.equal(m.verify, true)
  assert.equal(m.update, true)
  assert.equal(m.upstream, upstreamHead)
  assert.equal(main(), base) // Preparation never publishes.
  assert.equal(git('show', '-s', '--format=%P', m.candidate), `${base} ${upstreamHead}`)
  assert.equal(git('show', `${m.candidate}:frontend/src/lib/local-mode.js`), 'export const LOCAL_ONLY = true')
  git('bundle', 'verify', 'maintenance-transfer/candidate.bundle')
  await promote()
  assert.equal(main(), m.candidate)
})

test('data-format change blocks before merge or any publication', async () => {
  commit(upstream, 'frontend/src/store/persistence.js', 'localStorage.clear()\n', 'Change storage')
  await assert.rejects(runPrepare, /compatibility review/)
  assert.equal(git('rev-parse', 'HEAD'), base)
  assert.equal(main(), base)
})

test('human push deploys its own revision without merging unrelated sensitive upstream changes', async () => {
  commit(upstream, '.github/workflows/new.yml', 'permissions: write-all\n', 'Add workflow')
  process.env.EVENT_NAME = 'push'
  await runPrepare()
  assert.equal(metadata().candidate, base)
  assert.equal(metadata().update, false)
  assert.equal(metadata().verify, true)
})

test('explicit current-fork verification does not bypass the gate by merging protected upstream changes', async () => {
  commit(upstream, 'frontend/src/store/persistence.js', 'localStorage.clear()\n', 'Change storage')
  process.env.EVENT_NAME = 'workflow_dispatch'
  process.env.UPDATE_UPSTREAM = 'false'
  process.env.VERIFY_CURRENT = 'true'
  await runPrepare()
  assert.equal(metadata().candidate, base)
  assert.equal(metadata().update, false)
  assert.equal(metadata().verify, true)
  assert.equal(main(), base)
})

test('a merge conflict leaves remote main and the production baseline intact', async () => {
  commit(upstream, 'README.md', 'Upstream rewrite\n', 'Rewrite guide')
  base = commit(repo, 'README.md', 'Fork rewrite\n', 'Custom guide')
  git('push', 'origin', 'main')
  await assert.rejects(runPrepare)
  assert.equal(main(), base)
})

test('main moving after validation is rejected atomically, without overwriting the new commit', async () => {
  commit(upstream, 'docs/guide.md', 'New documentation\n', 'Improve guide')
  await runPrepare()
  const other = join(root, 'other')
  git('clone', origin, other)
  const newer = commit(other, 'docs/user.md', 'User work\n', 'Concurrent user change')
  const oldFetch = globalThis.fetch
  let once = false
  globalThis.fetch = async url => {
    if (!once && String(url).endsWith('/git/ref/heads/main')) {
      once = true
      git('-C', other, 'push', 'origin', 'main')
      return Response.json({ object: { sha: base } }) // The snapshot was true just before the concurrent push.
    }
    return oldFetch(url)
  }
  await assert.rejects(promote)
  assert.equal(main(), newer)
})

test('a failed promoted release is reverted by a new commit and pauses future automatic updates', async () => {
  commit(upstream, 'docs/guide.md', 'Candidate documentation\n', 'Improve guide')
  await runPrepare()
  const candidate = metadata().candidate
  await promote()
  await rollback()
  assert.notEqual(main(), candidate)
  git('merge-base', '--is-ancestor', candidate, main()) // No rewritten history.
  assert.equal(git('diff', '--name-only', base, main()), '.github/maintenance-paused.json')
  assert.equal(JSON.parse(readFileSync('.github/maintenance-paused.json', 'utf8')).failedCandidate, candidate)
  await assert.rejects(runPrepare, /paused/)
})

test('rollback refuses to undo a user commit made after automatic promotion', async () => {
  commit(upstream, 'docs/guide.md', 'Candidate documentation\n', 'Improve guide')
  await runPrepare()
  await promote()
  const other = join(root, 'other')
  git('clone', origin, other)
  const newer = commit(other, 'docs/user.md', 'User work\n', 'Concurrent user change')
  git('-C', other, 'push', 'origin', 'main')
  await assert.rejects(rollback, /Concurrent main change/)
  assert.equal(main(), newer)
})
