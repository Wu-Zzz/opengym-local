// Runs only trusted maintenance code. Candidate application code runs in the read-only test job.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { evaluateUpdate, parseNameStatus } from './update-policy.mjs'

const SITE = 'https://wu-zzz.github.io/opengym-local/'
const REPO = 'Wu-Zzz/opengym-local'
const INITIAL = '84e2465c7b2372ca9e262b2c08cd4e26adb9d39a'
// Fingerprints of the verified pre-automation deployment. A missing manifest later is an error.
const INITIAL_FILES = {
  'index.html': 'ab947aac653b1d423f8480217fbc557ec10f7fc4361eb272b668280d4d001c4b',
  'sw.js': '8adfd2b865327e263fd19d291ef1e1585e4bd1bd6ca09358c01ab4afb9bfa63f'
}
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim()
const sha = value => {
  if (!/^[a-f0-9]{40}$/.test(value || '')) throw new Error('Invalid commit identity')
  return value
}
const summary = text => {
  console.log(text)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n')
}
const output = (key, value) => {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
const api = async (path, method = 'GET', body) => {
  const res = await fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    method, headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000)
  })
  if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status}`)
  return res.status === 204 ? null : res.json()
}
const remoteMain = () => api('git/ref/heads/main').then(r => sha(r.object.sha))

function changesBetween(before, after) {
  const raw = execFileSync('git', ['diff', '--name-status', '-z', '--no-renames', before, after], { encoding: 'utf8' })
  return parseNameStatus(raw).map(change => ({
    ...change,
    mode: git('ls-tree', after, '--', change.path).split(' ')[0],
    oldMode: git('ls-tree', before, '--', change.path).split(' ')[0] || undefined,
    patch: git('diff', '--no-ext-diff', '--no-textconv', '--unified=3', before, after, '--', change.path)
  }))
}
function requireSafe(before, after) {
  const verdict = evaluateUpdate(changesBetween(before, after))
  if (!verdict.allowed) {
    summary('Automatic update stopped; the live site was not changed.\n' + verdict.reasons.map(r => `- ${r.path}: ${r.message}`).join('\n'))
    throw new Error('Upstream changes require compatibility review')
  }
}

export async function prepare({ site = SITE, upstreamURL = 'https://github.com/DuarteSantos8/openGym.git', initial = INITIAL } = {}) {
  mkdirSync('maintenance-transfer', { recursive: true })
  const checkUpstream = process.env.EVENT_NAME !== 'push'
  if (checkUpstream && existsSync('.github/maintenance-paused.json')) throw new Error('Automatic updates are paused after a failed release; review and remove the pause record first')
  const base = sha(git('rev-parse', 'HEAD'))
  const response = await fetch(site + 'release.json?check=' + Date.now(), { signal: AbortSignal.timeout(30000), cache: 'no-store' })
  let baseline
  if (response.status === 404) {
    for (const [file, expected] of Object.entries(INITIAL_FILES)) {
      const res = await fetch(site + file + '?bootstrap=' + Date.now(), { signal: AbortSignal.timeout(30000), cache: 'no-store' })
      if (!res.ok || createHash('sha256').update(Buffer.from(await res.arrayBuffer())).digest('hex') !== expected) {
        throw new Error('Production manifest is missing and this is not the verified original deployment')
      }
    }
    baseline = initial
  }
  else {
    if (!response.ok) throw new Error(`Cannot identify the currently served release: ${response.status}`)
    const release = await response.json()
    if (release.localOnly !== true || release.site !== SITE) throw new Error('Unexpected production release identity')
    baseline = sha(release.commit)
  }
  git('cat-file', '-e', `${baseline}^{commit}`)
  git('merge-base', '--is-ancestor', baseline, base)
  if (checkUpstream && process.env.VERIFY_CURRENT !== 'true' && git('diff', '--name-only', baseline, base, '--', 'frontend', 'catalogue', 'scripts/catalogue')) {
    throw new Error('main has application changes that are not the current live release; verify and publish them before merging upstream')
  }
  git('fetch', '--no-tags', upstreamURL, 'main:refs/remotes/upstream/main')
  const upstream = sha(git('rev-parse', 'refs/remotes/upstream/main'))
  const ancestor = sha(git('merge-base', base, upstream))
  const update = checkUpstream && ancestor !== upstream
  let candidate = base
  if (update) {
    requireSafe(ancestor, upstream)
    git('config', 'user.name', 'openGym maintenance')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    git('merge', '--no-ff', '--no-edit', upstream)
    candidate = sha(git('rev-parse', 'HEAD'))
    requireSafe(base, candidate)
    git('bundle', 'create', resolve('maintenance-transfer/candidate.bundle'), 'HEAD', `^${base}`)
  }
  const verify = update || process.env.EVENT_NAME === 'push' || process.env.VERIFY_CURRENT === 'true'
  const metadata = { base, baseline, candidate, upstream, update, verify, site: SITE }
  writeFileSync('maintenance-transfer/release.json', JSON.stringify(metadata, null, 2) + '\n')
  for (const [key, value] of Object.entries(metadata)) output(key, value)
  summary(update ? `Candidate ${candidate} prepared from upstream ${upstream}. No production change yet.` : 'No new upstream commits. ' + (verify ? 'Verifying the current release.' : 'Live site unchanged.'))
}

export async function promote() {
  const m = JSON.parse(readFileSync('maintenance-transfer/release.json', 'utf8'))
  for (const key of ['base', 'baseline', 'candidate', 'upstream']) sha(m[key])
  if (await remoteMain() !== m.base) throw new Error('main changed during testing; release cancelled')
  if (!m.update) {
    if (m.candidate !== m.base) throw new Error('Unexpected non-update candidate')
    summary(`Verified ${m.candidate}; ready to deploy the tested artifact.`)
    return
  }
  git('fetch', resolve('maintenance-transfer/candidate.bundle'), 'HEAD')
  if (sha(git('rev-parse', 'FETCH_HEAD')) !== m.candidate) throw new Error('Candidate bundle identity mismatch')
  if (git('show', '-s', '--format=%P', m.candidate) !== `${m.base} ${m.upstream}`) throw new Error('Unexpected merge parents')
  requireSafe(m.base, m.candidate)
  // The first parent check proves a fast-forward. The lease adds an atomic exact-head check;
  // it cannot discard an intervening commit, including a concurrent fast-forward.
  try { git('push', `--force-with-lease=refs/heads/main:${m.base}`, 'origin', `${m.candidate}:refs/heads/main`) }
  catch (error) {
    // A lost response is not proof the push failed. Resolve the exact remote state before recovery.
    if (await remoteMain() !== m.candidate) throw error
  }
  summary(`Promoted tested candidate ${m.candidate}.`)
}

async function smoke() {
  const m = JSON.parse(readFileSync('maintenance-transfer/release.json', 'utf8'))
  const expected = process.env.ROLLBACK === 'true' ? m.baseline : m.candidate
  const deadline = Date.now() + 180000
  let last
  while (Date.now() < deadline) {
    try {
      const request = path => fetch(new URL(path, SITE).href + '?verify=' + Date.now(), {
        signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - Date.now()))), cache: 'no-store'
      })
      const release = await request('release.json')
      const manifest = await release.json()
      if (!release.ok || manifest.commit !== expected || manifest.localOnly !== true || manifest.site !== SITE) throw new Error('Published release identity has not reached the site')
      const html = await request('index.html')
      const content = await html.text()
      if (!html.ok || !content.includes('id="root"')) throw new Error('Published HTML is unavailable')
      const digest = bytes => createHash('sha256').update(bytes).digest('hex')
      if (digest(content) !== manifest.indexSha256) throw new Error('Published HTML belongs to a different build')
      const worker = await request('sw.js')
      if (!worker.ok || digest(Buffer.from(await worker.arrayBuffer())) !== manifest.swSha256) throw new Error('Published service worker belongs to a different build')
      const assets = [...content.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g)].map(m => m[1])
      if (!assets.some(a => a.endsWith('.js'))) throw new Error('No application script in published HTML')
      for (const asset of assets) {
        const url = new URL(asset, SITE)
        if (!url.href.startsWith(SITE)) throw new Error('Unexpected external executable asset')
        const res = await request(asset)
        if (!res.ok) throw new Error(`Published asset unavailable: ${asset}`)
      }
      summary(`Public HTTPS release verified: ${expected} at ${SITE}`)
      return
    } catch (error) { last = error; await new Promise(r => setTimeout(r, 5000)) }
  }
  throw last
}

export async function rollback() {
  const m = JSON.parse(readFileSync('maintenance-transfer/release.json', 'utf8'))
  if (!m.update) return summary('The previous website artifact was restored. The manually pushed source was left intact for review.')
  if (await remoteMain() !== m.candidate) throw new Error('Concurrent main change: source rollback stopped; previous website restored')
  git('fetch', 'origin', 'main')
  git('checkout', '--detach', m.candidate)
  git('config', 'user.name', 'openGym maintenance')
  git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
  git('revert', '--no-commit', '-m', '1', m.candidate)
  writeFileSync('.github/maintenance-paused.json', JSON.stringify({ failedCandidate: m.candidate, restored: m.baseline, run: process.env.GITHUB_RUN_ID }, null, 2) + '\n')
  git('add', '.github/maintenance-paused.json')
  git('commit', '-m', 'Revert failed automatic update and pause automatic promotion')
  git('push', `--force-with-lease=refs/heads/main:${m.candidate}`, 'origin', 'HEAD:refs/heads/main')
  summary('Previous application restored. Automatic promotion paused pending review. No browser data was modified.')
}

async function heartbeat() {
  // A real monthly check record keeps the public repository schedule active during quiet upstream periods.
  const branch = 'maintenance-checks'
  let ref = await fetch(`https://api.github.com/repos/${REPO}/git/ref/heads/${branch}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` }, signal: AbortSignal.timeout(30000) })
  if (ref.status === 404) await api('git/refs', 'POST', { ref: `refs/heads/${branch}`, sha: await remoteMain() })
  else if (!ref.ok) throw new Error(`Cannot inspect maintenance branch: ${ref.status}`)
  const path = '.github/last-cloud-check.json'
  const old = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}?ref=${branch}`, { headers: { Authorization: `Bearer ${process.env.GH_TOKEN}` }, signal: AbortSignal.timeout(30000) })
  let previous
  if (old.ok) previous = await old.json()
  else if (old.status !== 404) throw new Error(`Cannot read maintenance record: ${old.status}`)
  const month = new Date().toISOString().slice(0, 7)
  if (previous && JSON.parse(Buffer.from(previous.content, 'base64').toString()).month === month) return
  const content = Buffer.from(JSON.stringify({ month, checkedAt: new Date().toISOString(), run: process.env.GITHUB_RUN_ID, result: process.env.PREPARE_RESULT }, null, 2) + '\n').toString('base64')
  await api(`contents/${path}`, 'PUT', { branch, message: `Record cloud maintenance check for ${month}`, content, ...(previous ? { sha: previous.sha } : {}) })
}

const commands = { prepare, promote, smoke, rollback, heartbeat }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!commands[process.argv[2]]) throw new Error('Unknown maintenance command')
  await commands[process.argv[2]]()
}
