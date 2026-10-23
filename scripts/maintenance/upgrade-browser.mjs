#!/usr/bin/env node
// Run against production builds, never a user's browser or the deployed website:
// BASELINE_DIST=/absolute/old CANDIDATE_DIST=/absolute/new LEGACY_DIST=/absolute/98fd50962 npm run test:upgrade
// LEGACY_DIST is the fixed pre-handshake release, not the rolling rollback baseline.
// npm ci && npx playwright install --with-deps chromium webkit  (Linux CI prerequisites)
// Optional: UPGRADE_BROWSERS=chromium,webkit; UPGRADE_REPORT=/path/report.json;
// UPGRADE_ARTIFACT_DIR=/path/artifacts (screenshots on failure, synthetic data only).
// Distinct APP_BUILD values produce distinct service-worker caches even for a smoke test.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp, rm, mkdir, realpath, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createServer } from 'node:https'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { resolve, join, extname, sep } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, webkit, devices } from 'playwright'
import { fixture, exerciseFile, dayFile, withDayPhoto } from './upgrade-fixture.mjs'

const BASE = '/opengym-local/'
const FIXTURE = '/__opengym_upgrade_fixture'
const STATE = 'gym_state_v1'
const TIMEOUT = 45000
const engines = { chromium, webkit }
const names = (process.env.UPGRADE_BROWSERS || 'chromium,webkit').split(',').map(s => s.trim()).filter(Boolean)
assert(names.length && names.every(n => engines[n]), 'UPGRADE_BROWSERS supports chromium,webkit')
const report = { passed: false, syntheticDataOnly: true, browsers: [], startedAt: new Date().toISOString() }
let server, temp
let stage = 'baseline'
let offline = false
let origin
const violations = []
const EXERCISE_FILES = [exerciseFile]
const ALL_FILES = [exerciseFile, dayFile]
const probeBytes = Buffer.from('Unreferenced synthetic GC probe, never part of a backup')
const gcProbe = { hash: hash(probeBytes), bytes: probeBytes, mime: 'application/octet-stream' }

function step(name, text) { console.log(`[upgrade:${name}] ${text}`) }
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex') }

// Import legitimately restamps conflict-resolution metadata. Dates, logged sets, media hashes
// and every other user value remain part of the comparison.
const SYNC_FIELDS = new Set(['_ts', '_f', '_rev', '_wid', 't', 'edited', 'deleted', 'resetAt', 'resetIds', 'unitSet'])
function semantic(value) {
  if (Array.isArray(value)) return value.map(semantic)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SYNC_FIELDS.has(key)).map(([key, v]) => [key, semantic(v)]))
}

async function buildAt(env) {
  assert(process.env[env], `${env} must point to an existing production build`)
  const dir = await realpath(resolve(process.env[env]))
  const html = await readFile(join(dir, 'index.html'), 'utf8')
  const sw = await readFile(join(dir, 'sw.js'), 'utf8')
  assert(html.includes('<script'), `${env}: index.html has no application script`)
  const cache = sw.match(/const CACHE\s*=\s*['"]([^'"]+)['"]/)?.[1]
  assert(cache?.startsWith('opengym-rt-') && !cache.includes('__BUILD__'), `${env}: service worker is not stamped`)
  return { dir, cache, swHash: hash(sw), htmlHash: hash(html) }
}

// Existing properties must survive; future versions may add defaults or migration metadata.
// Array lengths remain exact so a reset, dropped set or injected demo history cannot pass.
function contains(actual, expected, where = 'state') {
  if (where === 'state') {
    for (const key of ['deleted', 'resetAt', 'resetIds', 'unitSet']) {
      assert.deepEqual(actual?.[key], expected?.[key], `state.${key}: conflict metadata changed`)
    }
    if (expected?.dayPhotos) assert.deepEqual(actual?.dayPhotos, expected.dayPhotos, 'state.dayPhotos: photo references or cleared entries changed')
  }
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual), `${where} is no longer an array`)
    assert.equal(actual.length, expected.length, `${where}: record count changed`)
    expected.forEach((v, i) => contains(actual[i], v, `${where}[${i}]`))
  } else if (expected && typeof expected === 'object') {
    assert(actual && typeof actual === 'object', `${where} is missing`)
    for (const [key, value] of Object.entries(expected)) contains(actual[key], value, `${where}.${key}`)
  } else assert.deepEqual(actual, expected, `${where} changed`)
}

function containsImported(actual, expected) { contains(semantic(actual), semantic(expected)) }

async function serve(builds) {
  const key = join(temp, 'key.pem'), cert = join(temp, 'cert.pem'), config = join(temp, 'openssl.cnf')
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-config', config], { stdio: 'ignore' })
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.mp4': 'video/mp4', '.woff2': 'font/woff2' }
  server = createServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
    if (offline) { req.socket.destroy(); return }
    try {
      const url = new URL(req.url, 'https://localhost')
      if (req.method !== 'GET' && req.method !== 'HEAD' || /\/api(?:\/|$)/.test(url.pathname)) {
        violations.push({ method: req.method, path: url.pathname })
        res.writeHead(403); res.end('No data backend in this test'); return
      }
      if (url.pathname !== FIXTURE && !url.pathname.startsWith(BASE)) { res.writeHead(404); res.end(); return }
      res.setHeader('Cache-Control', 'no-store')
      // Even a future WebKit worker whose requests Playwright cannot inspect cannot connect out.
      res.setHeader('Content-Security-Policy', "connect-src 'self'; form-action 'none'")
      if (url.pathname === FIXTURE) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Synthetic test setup</title>'); return }
      const root = builds[stage].dir
      const rel = decodeURIComponent(url.pathname.slice(BASE.length)) || 'index.html'
      const file = resolve(root, rel)
      if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) { res.writeHead(404); res.end(); return }
      res.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream')
      if (req.method === 'HEAD') { res.end(); return }
      createReadStream(file).on('error', () => res.destroy()).pipe(res)
    } catch { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `https://127.0.0.1:${server.address().port}`
}

async function contextFor(name) {
  const profile = await mkdtemp(join(temp, `${name}-profile-`))
  // Dedicated temporary profiles model separate phones and give each its own worker lifetime.
  const context = await engines[name].launchPersistentContext(profile, {
    ...(name === 'webkit' ? devices['iPhone 13'] : devices['Pixel 7']),
    ...(name === 'chromium' ? { args: ['--ignore-certificate-errors'] } : {}),
    headless: true,
    locale: 'en-US', timezoneId: 'Asia/Taipei', ignoreHTTPSErrors: true, acceptDownloads: true,
    serviceWorkers: 'allow',
  })
  context.setDefaultTimeout(TIMEOUT)
  context.setDefaultNavigationTimeout(TIMEOUT)
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (/^https?:$/.test(url.protocol) && (url.origin !== origin || /\/api(?:\/|$)/.test(url.pathname) || !['GET', 'HEAD'].includes(request.method()))) {
      violations.push({ method: request.method(), url: request.url() })
      await route.abort('blockedbyclient')
    } else await route.continue()
  })
  context.on('page', page => {
    page.on('pageerror', error => {
      violations.push({ pageError: error.message })
      if (process.env.UPGRADE_DEBUG) console.error('[pageerror]', stage, page.url(), error.message)
    })
    if (process.env.UPGRADE_DEBUG) page.on('requestfailed', request => console.error('[requestfailed]', stage, offline, request.url(), request.failure()))
    page.on('console', message => {
      if (message.type() === 'error' && /Content Security Policy|connect-src/.test(message.text())) violations.push({ policy: message.text() })
    })
  })
  return context
}

async function seed(page, state, files = [], legacyBlob = false) {
  await page.goto(origin + FIXTURE)
  await page.evaluate(({ state, key }) => {
    localStorage.setItem(key, JSON.stringify(state))
    localStorage.setItem('gym_guest', '1')
  }, { state, key: STATE })
  await putMedia(page, files, legacyBlob)
}

async function putMedia(page, files, legacyBlob = false) {
  if (!files.length) return
  await page.evaluate(async ({ files, legacyBlob }) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('opengym-media', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('blobs', { keyPath: 'hash' })
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction('blobs', 'readwrite')
      // WebKit's private test contexts reject Blob writes; the app's current schema deliberately
      // stores ArrayBuffer instead. Chromium also exercises reading the former Blob schema.
      for (const { hash, bytes, mime } of files) {
        const data = new Uint8Array(bytes).buffer
        tx.objectStore('blobs').put({ hash, ...(legacyBlob ? { blob: new Blob([data], { type: mime }) } : { data }),
          mime, size: bytes.length, putAt: 1, shownAt: 1, pending: true, rejected: null })
      }
      tx.oncomplete = resolve
      tx.onerror = () => reject(new Error('Fixture media write failed: ' + (tx.error?.message || 'IndexedDB error')))
      tx.onabort = () => reject(new Error('Fixture media write aborted: ' + (tx.error?.message || 'IndexedDB abort')))
    })
    db.close()
  }, { files: files.map(f => ({ ...f, bytes: [...f.bytes] })), legacyBlob })
}

async function openData(page) {
  await page.goto(origin + BASE + '#/settings/data', { waitUntil: 'domcontentloaded' })
  try { await page.getByText('Export backup (JSON)', { exact: true }).waitFor() }
  catch (error) {
    console.error('[startup]', await page.evaluate(async () => ({ href: location.href, text: document.body.innerText,
      controller: navigator.serviceWorker.controller?.state, caches: await caches.keys(),
      registrations: (await navigator.serviceWorker.getRegistrations()).map(r => ({ scope: r.scope, active: r.active?.state, installing: r.installing?.state, waiting: r.waiting?.state })) })))
    throw error
  }
}

async function workerReady(page, cache, removedCache = null) {
  await waitForAsync(page, async ({ cache, removedCache }) => {
    const registration = await navigator.serviceWorker?.getRegistration()
    const keys = await caches.keys()
    return registration?.active?.state === 'activated' && navigator.serviceWorker.controller === registration.active &&
      keys.includes(cache) && (!removedCache || !keys.includes(removedCache))
  }, { cache, removedCache }, 'The new worker did not activate and replace the old cache')
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).scope)
  assert.equal(scope, origin + BASE, 'Service worker must own the deployed subpath')
}

// Playwright's waitForFunction polls synchronous predicates. A Promise itself is truthy, so
// using an async predicate can return its FIRST false result without waiting for the state.
// Await these IDB/Cache API checks explicitly before scheduling another bounded observation.
async function waitForAsync(page, predicate, arg, message) {
  const deadline = Date.now() + TIMEOUT
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg)) return
    await delay(100)
  }
  throw new Error(message)
}

async function records(page) { return page.evaluate(key => JSON.parse(localStorage.getItem(key)), STATE) }

async function mediaBytes(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('opengym-media', 1)
      r.onupgradeneeded = () => r.result.createObjectStore('blobs', { keyPath: 'hash' })
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    const rows = await new Promise((resolve, reject) => {
      const r = db.transaction('blobs', 'readonly').objectStore('blobs').getAll()
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    db.close()
    return Promise.all(rows.filter(r => !r.hash.startsWith('.')).map(async r => ({
      hash: r.hash, mime: r.mime, size: r.size,
      bytes: Array.from(new Uint8Array(r.data || await r.blob.arrayBuffer())),
    })))
  })
}

async function assertMedia(page, files = []) {
  const rows = await mediaBytes(page)
  assert.equal(rows.length, files.length, `Media records leaked, disappeared or duplicated: actual=${rows.map(r => r.hash)} expected=${files.map(f => f.hash)}`)
  for (const file of files) {
    const row = rows.find(r => r.hash === file.hash)
    assert(row, `IndexedDB omitted ${file.hash === dayFile.hash ? 'day-only' : 'exercise'} photo`)
    assert.equal(row.mime, file.mime)
    assert.equal(row.size, file.bytes.length)
    assert.equal(hash(Buffer.from(row.bytes)), file.hash, 'IndexedDB image bytes changed')
  }
}

// A same-origin page OUTSIDE the worker scope lets us insert an old orphan without app code or
// racing the currently running GC. It is not mistaken for an old app tab by the capability gate.
// The orphan's disappearance proves the PRODUCTION app actually ran its cleanup. Every real
// fixture file also has putAt=1, well beyond the one-hour grace period, so retention is not luck.
async function reopenThroughGc(page) {
  await page.goto(origin + FIXTURE)
  assert.equal(await page.title(), 'Synthetic test setup', 'App worker intercepted an unrelated page outside its scope')
  await putMedia(page, [gcProbe])
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('opengym-media', 1)
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction('blobs', 'readwrite'), store = tx.objectStore('blobs')
        const r = store.getAll()
        r.onsuccess = () => { for (const row of r.result) store.put({ ...row, putAt: 1 }) }
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error)
      })
    } finally { db.close() }
  })
  await openData(page)
  await waitForAsync(page, async probe => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('opengym-media', 1)
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const r = db.transaction('blobs', 'readonly').objectStore('blobs').get(probe)
        r.onsuccess = () => resolve(!r.result); r.onerror = () => reject(r.error)
      })
    } finally { db.close() }
  }, gcProbe.hash, 'Production local media cleanup did not remove the aged, unreferenced probe')
}

async function download(page, type, label) {
  const pending = page.waitForEvent('download')
  await page.getByText(type === 'json' ? 'Export backup (JSON)' : 'Export with photos & videos (.zip)', { exact: true }).click()
  const file = await pending
  assert.equal(await file.failure(), null, 'Backup download failed')
  assert(file.suggestedFilename().endsWith('.' + type), 'Backup extension changed')
  const path = join(temp, `${label}.${type}`)
  await file.saveAs(path)
  return { path, bytes: await readFile(path) }
}

// Independent inspection of the downloaded ZIP; no imports from candidate application code.
function readZip(bytes) {
  const entries = new Map()
  let pos = 0
  while (pos + 30 <= bytes.length && bytes.readUInt32LE(pos) === 0x04034b50) {
    const flags = bytes.readUInt16LE(pos + 6), method = bytes.readUInt16LE(pos + 8)
    assert.equal(flags & 9, 0, 'Encrypted/data-descriptor ZIP is unsupported by this check')
    const size = bytes.readUInt32LE(pos + 18), names = bytes.readUInt16LE(pos + 26), extra = bytes.readUInt16LE(pos + 28)
    const name = bytes.subarray(pos + 30, pos + 30 + names).toString('utf8')
    const start = pos + 30 + names + extra
    assert(start + size <= bytes.length, 'ZIP entry is truncated')
    const compressed = bytes.subarray(start, start + size)
    assert(method === 0 || method === 8, 'Unsupported ZIP compression')
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed)
    pos = start + size
  }
  assert(entries.size, 'Backup is not a readable ZIP')
  return entries
}

async function checkExports(page, expected, label, files = EXERCISE_FILES) {
  const json = await download(page, 'json', label)
  const state = JSON.parse(json.bytes.toString('utf8'))
  contains(state, expected)
  const zip = await download(page, 'zip', label)
  const entries = readZip(zip.bytes)
  assert(entries.has('opengym-backup.json'), 'ZIP has no state document')
  contains(JSON.parse(entries.get('opengym-backup.json')), state)
  const exportedFiles = [...entries.keys()].filter(n => n.startsWith('media/'))
  assert.equal(exportedFiles.length, files.length, 'ZIP media count changed')
  for (const file of files) {
    const photo = entries.get(`media/${file.hash}.png`)
    assert(photo, `ZIP omitted ${file.hash === dayFile.hash ? 'day-only' : 'exercise'} photo`)
    assert.equal(hash(photo), file.hash, 'ZIP changed photo bytes')
  }
  return { json, zip, state }
}

async function checkImport(name, file, expected, files) {
  const context = await contextFor(name)
  try {
    const page = await context.newPage()
    await seed(page, { lang: 'en', langAuto: false, routines: [], workouts: [] })
    await openData(page)
    await importInto(page, file, expected)
    containsImported(await records(page), expected)
    await assertMedia(page, files)
    await reopenThroughGc(page)
    containsImported(await records(page), expected)
    await assertMedia(page, files)
  } finally { await context.close() }
}

async function importInto(page, file, expected) {
  await page.locator('input[type=file][accept*=".json"]').setInputFiles(file)
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await page.waitForFunction(({ key, id }) => JSON.parse(localStorage.getItem(key))?.workouts?.some(w => w.id === id),
    { key: STATE, id: expected.workouts.at(-1).id })
}

async function waitForWorkoutIds(page, ids) {
  await page.waitForFunction(({ key, ids }) => {
    const workouts = JSON.parse(localStorage.getItem(key))?.workouts || []
    return JSON.stringify(workouts.map(w => w.id).sort()) === JSON.stringify(ids)
  }, { key: STATE, ids: [...ids].sort() })
}

function containsEntries(actual, expected, field) {
  assert.deepEqual(actual.map(x => x.id).sort(), expected.map(x => x.id).sort(), `${field}: imported entry ids changed`)
  for (const entry of expected) containsImported(actual.find(x => x.id === entry.id), entry)
}

// These paths were added for guests in d92ce229. Empty-device imports cannot exercise them:
// the device must own a workout absent from the selected backup, plus its own running session.
async function checkGuestImport(name, backup) {
  const context = await contextFor(name)
  try {
    const page = await context.newPage()
    const local = fixture('guest', false)
    local.restSec = 43
    local.bodyweight.push({ d: '2026-02-01', w: 62.75, t: Date.parse('2026-02-01T08:00:00Z') })
    await seed(page, local)
    await openData(page)
    const before = await records(page)
    const conflict = async () => {
      await page.locator('input[type=file][accept*=".json"]').setInputFiles(backup.zip.path)
      await page.getByText('This device has 1 workout that is not in this backup. Replacing deletes it.', { exact: true }).waitFor()
      await page.getByText('Merge them in', { exact: true }).waitFor()
      await page.getByText('Replace anyway', { exact: true }).waitFor()
    }

    await conflict()
    await page.getByText('Cancel', { exact: true }).click()
    await page.getByText('Merge them in', { exact: true }).waitFor({ state: 'hidden' })
    assert.deepEqual(await records(page), before, 'Cancelling an import changed the device profile')
    await assertMedia(page) // ZIP files must not be written before confirmation.

    await conflict()
    await page.getByText('Merge them in', { exact: true }).click()
    await waitForWorkoutIds(page, [...before.workouts, ...backup.state.workouts].map(w => w.id))
    const merged = await records(page)
    for (const field of ['workouts', 'routines', 'customEx']) {
      containsEntries(merged[field], [...backup.state[field], ...before[field]], field)
    }
    assert.equal(merged.restSec, backup.state.restSec, 'Guest merge did not keep the backup settings')
    containsImported(merged.active, before.active)
    containsImported(merged.dayPhotos, backup.state.dayPhotos)
    assert.deepEqual(merged.bodyweight.map(x => x.d).sort(), [...new Set([...before.bodyweight, ...backup.state.bodyweight].map(x => x.d))].sort())
    for (const entry of before.bodyweight) containsImported(merged.bodyweight.find(x => x.d === entry.d), entry)
    await assertMedia(page, ALL_FILES)
    await reopenThroughGc(page)
    contains(await records(page), merged)
    await assertMedia(page, ALL_FILES)

    // The destructive path is permitted only after the explicit choice, on this synthetic
    // profile. The running session must still survive, as importBackup promises in both paths.
    await conflict()
    await page.getByText('Replace anyway', { exact: true }).click()
    await waitForWorkoutIds(page, backup.state.workouts.map(w => w.id))
    const replaced = await records(page)
    containsImported(replaced, { ...backup.state, active: before.active })
    await assertMedia(page, ALL_FILES)
    await reopenThroughGc(page)
    contains(await records(page), replaced)
    await assertMedia(page, ALL_FILES)
  } finally { await context.close() }
}

async function checkLegacyTab(name, builds) {
  const context = await contextFor(name)
  try {
    stage = 'legacy'
    const oldPage = await context.newPage()
    const state = fixture('stale')
    await seed(oldPage, state, EXERCISE_FILES)
    await openData(oldPage)
    await workerReady(oldPage, builds.legacy.cache)
    await reopenThroughGc(oldPage)
    contains(await records(oldPage), state)
    await assertMedia(oldPage, EXERCISE_FILES)
    const before = await records(oldPage)
    const beforeMedia = await mediaBytes(oldPage)

    // Keep the real old document alive. Switching just the server does not refresh that tab's
    // JavaScript; its old GC is precisely why the new app must wait for this tab to close.
    stage = 'candidate'
    const candidatePage = await context.newPage()
    await candidatePage.goto(origin + BASE + '#/settings/data', { waitUntil: 'domcontentloaded' })
    await candidatePage.getByText('请先关闭旧版页面', { exact: true }).waitFor()
    assert.equal(await candidatePage.getByText('Export backup (JSON)', { exact: true }).count(), 0,
      'Candidate application started while an incompatible legacy document remained open')
    await oldPage.getByText('Export backup (JSON)', { exact: true }).waitFor()
    assert.deepEqual(await records(oldPage), before, 'Blocked candidate changed the old device profile')
    assert.deepEqual(await mediaBytes(oldPage), beforeMedia, 'Blocked candidate changed old IndexedDB media')

    await oldPage.close()
    await candidatePage.getByRole('button', { name: '重试', exact: true }).click()
    await candidatePage.getByText('Export backup (JSON)', { exact: true }).waitFor()
    await workerReady(candidatePage, builds.candidate.cache, builds.legacy.cache)
    contains(await records(candidatePage), before)
    await assertMedia(candidatePage, EXERCISE_FILES)

    const secondPage = await context.newPage()
    await openData(secondPage)
    // Compatible tabs answer one another instead of getting stuck in a permanent safety gate.
    contains(await records(secondPage), before)
    await assertMedia(secondPage, EXERCISE_FILES)
    await candidatePage.getByText('Export backup (JSON)', { exact: true }).waitFor()
  } finally { await context.close(); stage = 'candidate' }
}

async function switchBuild(pages, builds, target, previous) {
  stage = target
  for (const [i, page] of pages.entries()) {
    if (process.env.UPGRADE_DEBUG) console.log('[switch]', target, i)
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration()
      if (!reg) throw new Error('Old service worker disappeared')
      await reg.update()
    })
    await workerReady(page, builds[target].cache, builds[previous].cache)
    const shell = await page.evaluate(async () => {
      const response = await fetch('index.html', { cache: 'no-cache' })
      if (!response.ok) throw new Error('Updated worker cannot serve its application shell')
      return response.text()
    })
    assert.equal(hash(shell), builds[target].htmlHash, 'Updated worker served the wrong application shell')
    // Reopen the app in this SAME profile after the worker takes ownership. The explicit
    // offline reload below separately verifies refresh; this navigation models app reopening.
    await reopenThroughGc(page)
  }
}

async function run(name, builds) {
  stage = 'baseline'; offline = false
  const beforeViolations = violations.length
  step(name, 'launching isolated browser; no existing profiles')
  const contexts = []
  const result = { engine: name, passed: false, checks: [] }
  report.browsers.push(result)
  try {
    const a = await contextFor(name), b = await contextFor(name)
    contexts.push(a, b)
    const pa = await a.newPage(), pb = await b.newPage()
    await seed(pa, fixture('a'), EXERCISE_FILES, name === 'chromium')
    await seed(pb, fixture('b', false))
    await openData(pa); await openData(pb)
    await workerReady(pa, builds.baseline.cache); await workerReady(pb, builds.baseline.cache)
    contains(await records(pa), fixture('a')); contains(await records(pb), fixture('b', false))
    await assertMedia(pa, EXERCISE_FILES); await assertMedia(pb)
    const old = await checkExports(pa, fixture('a'), `${name}-baseline`)
    result.checks.push('baseline production UI and JSON/ZIP exports', 'separate contexts own separate records and media')
    step(name, 'baseline state, media and exports verified; replacing same-origin build')

    await switchBuild([pa, pb], builds, 'candidate', 'baseline')
    contains(await records(pa), fixture('a')); contains(await records(pb), fixture('b', false))
    await assertMedia(pa, EXERCISE_FILES); await assertMedia(pb)
    const upgraded = await checkExports(pa, old.state, `${name}-candidate`)
    result.checks.push('old service worker replaced and old shell cache removed', 'candidate production exports preserve baseline fields and media bytes')

    step(name, 'testing offline reload after the worker upgrade')
    // Cut the actual server connection as well as the browser's network. This also tests
    // WebKit worker traffic, for which Playwright exposes less network instrumentation.
    offline = true
    await a.setOffline(true); await b.setOffline(true)
    await pa.reload({ waitUntil: 'domcontentloaded' }); await pb.reload({ waitUntil: 'domcontentloaded' })
    await pa.getByText('Export backup (JSON)', { exact: true }).waitFor()
    await pb.getByText('Export backup (JSON)', { exact: true }).waitFor()
    contains(await records(pa), fixture('a')); contains(await records(pb), fixture('b', false))
    await assertMedia(pa, EXERCISE_FILES); await assertMedia(pb)
    await checkExports(pa, old.state, `${name}-offline`)
    result.checks.push('offline app reload and real backup exports after upgrade')
    offline = false
    await a.setOffline(false); await b.setOffline(false)

    step(name, 'importing old and upgraded backups into fresh browser contexts')
    await checkImport(name, old.json.path, fixture('a'), [])
    await checkImport(name, old.zip.path, fixture('a'), EXERCISE_FILES)
    await checkImport(name, upgraded.zip.path, fixture('a'), EXERCISE_FILES)
    // Importing elsewhere cannot write into either original context.
    contains(await records(pa), fixture('a')); contains(await records(pb), fixture('b', false))
    await assertMedia(pb)
    result.checks.push('baseline JSON and ZIP import in candidate production UI', 'candidate ZIP round trip', 'no cross-context writes')

    step(name, 'adding data in candidate, rolling program back, then upgrading again')
    const next = withDayPhoto(structuredClone(upgraded.state))
    next.workouts.push({ ...structuredClone(next.workouts[0]), id: 'upgrade-a-after-update', d: '2026-01-20', name: 'Added in candidate', note: 'Must survive program rollback' })
    next.bodyweight.push({ d: '2026-01-20', w: 63.5, t: Date.parse('2026-01-20T08:00:00Z') })
    next.restSec = 105
    const addition = join(temp, `${name}-candidate-addition.json`)
    await writeFile(addition, JSON.stringify(next))
    // Use the same supported production import UI that users use to add their history.
    await importInto(pa, addition, next)
    containsImported(await records(pa), next)
    await putMedia(pa, [dayFile])
    await reopenThroughGc(pa)
    const afterAddition = await records(pa)
    containsImported(afterAddition, next)
    await assertMedia(pa, ALL_FILES)
    const withPhotos = await checkExports(pa, afterAddition, `${name}-day-photos`, ALL_FILES)
    await checkImport(name, withPhotos.zip.path, afterAddition, ALL_FILES)
    await checkGuestImport(name, withPhotos)
    result.checks.push('day-only photo survives actual local garbage collection and production ZIP round trip', 'guest import cancellation, merge and explicit replacement preserve the promised local data')
    await switchBuild([pa, pb], builds, 'baseline', 'candidate')
    await assertMedia(pa, ALL_FILES)
    await checkExports(pa, afterAddition, `${name}-rollback`, ALL_FILES)
    contains(await records(pb), fixture('b', false))
    await switchBuild([pa, pb], builds, 'candidate', 'baseline')
    contains(await records(pa), afterAddition)
    await assertMedia(pa, ALL_FILES); await assertMedia(pb)
    await checkExports(pa, afterAddition, `${name}-re-upgrade`, ALL_FILES)
    result.checks.push('candidate-added history, weight and preference survive program rollback and re-upgrade', 'unfinished session and deletion/reset/unit metadata survive program changes')
    await pa.goto(origin + BASE + '#/settings/about')
    const version = pa.locator('.lrow').filter({ has: pa.getByText('Version', { exact: true }) }).locator('.lrow-v')
    await version.waitFor()
    result.displayVersion = (await version.innerText()).trim()
    assert.match(result.displayVersion, /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'About must show the release version without a build hash')
    contains(await records(pa), afterAddition)
    result.checks.push('About shows a readable release version without build metadata')
    step(name, 'keeping a real legacy tab open while the candidate attempts to start')
    await checkLegacyTab(name, builds)
    result.checks.push('fixed legacy document blocks candidate startup without changing records or media', 'closing legacy tab and retrying starts candidate; two compatible tabs can coexist')
    assert.deepEqual(violations.slice(beforeViolations), [], 'Network upload, external request or browser exception detected')
    result.checks.push('no API requests, uploads, external requests or page exceptions')
    result.passed = true
    step(name, 'PASS')
  } catch (error) {
    result.error = error.stack || String(error)
    if (process.env.UPGRADE_ARTIFACT_DIR) {
      const dir = resolve(process.env.UPGRADE_ARTIFACT_DIR)
      await mkdir(dir, { recursive: true })
      for (const [i, ctx] of contexts.entries()) {
        const page = ctx.pages().findLast(p => p.url() !== 'about:blank') || ctx.pages().at(-1)
        if (page) await page.screenshot({ path: join(dir, `${name}-${i}-failure.png`), fullPage: true }).catch(() => {})
      }
    }
    throw error
  } finally {
    offline = false
    await Promise.all(contexts.map(c => c.close().catch(() => {})))
  }
}

try {
  const builds = { baseline: await buildAt('BASELINE_DIST'), candidate: await buildAt('CANDIDATE_DIST'), legacy: await buildAt('LEGACY_DIST') }
  assert.notEqual(builds.baseline.swHash, builds.candidate.swHash, 'Builds have identical workers; use distinct APP_BUILD values to exercise an actual upgrade')
  assert.notEqual(builds.baseline.cache, builds.candidate.cache, 'Builds must have distinct shell caches')
  assert.notEqual(builds.legacy.swHash, builds.candidate.swHash, 'LEGACY_DIST must remain the fixed pre-handshake release')
  report.builds = Object.fromEntries(Object.entries(builds).map(([name, { dir: _dir, ...b }]) => [name, b]))
  temp = await mkdtemp(join(tmpdir(), 'opengym-upgrade-'))
  await serve(builds)
  for (const name of names) await run(name, builds)
  report.passed = true
} catch (error) {
  report.error = error.stack || String(error)
  console.error(report.error)
  process.exitCode = 1
} finally {
  if (server) await new Promise(resolve => server.close(resolve))
  if (temp) await rm(temp, { recursive: true, force: true })
  report.finishedAt = new Date().toISOString()
  report.violations = violations
  if (process.env.UPGRADE_REPORT) {
    const file = resolve(process.env.UPGRADE_REPORT)
    await mkdir(resolve(file, '..'), { recursive: true })
    await writeFile(file, JSON.stringify(report, null, 2) + '\n')
  }
  console.log(JSON.stringify(report))
}
