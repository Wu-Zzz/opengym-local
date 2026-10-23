import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateUpdate, parseNameStatus } from './update-policy.mjs'

const patch = body => `diff --git a/file b/file\n--- a/file\n+++ b/file\n@@ -1 +1 @@\n${body}\n`
const change = (path, body = '-const n = 1\n+const n = 2', extra = {}) =>
  ({ status: 'M', path, mode: '100644', oldMode: '100644', patch: patch(body), ...extra })
const denies = (item, code) => {
  const result = evaluateUpdate([item])
  assert.equal(result.allowed, false)
  assert.ok(result.reasons.some(reason => reason.code === code), JSON.stringify(result))
}

test('no changes and ordinary UI, translations, calculation and media can reach testing', () => {
  assert.equal(evaluateUpdate([]).allowed, true)
  for (const item of [
    change('frontend/src/views/Home.jsx', '-<h1>Old</h1>\n+<h1>New</h1>'),
    change('frontend/src/components/WeightChart.jsx'),
    change('frontend/src/views/FocusView.css'),
    change('frontend/src/index.css'),
    change('frontend/src/locales/zh.js', "-'Delete': '删',\n+'Delete': '删除',"),
    change('frontend/src/instr/zh-TW.js'),
    change('frontend/src/lib/onerm.js'),
    change('frontend/src/lib/progression.js'),
    change('catalogue/i18n/zh.json'),
    change('catalogue/media/still/1234.webp', '', { patch: undefined }),
    change('docs/FAQ.md', '+Clear storage only after exporting a backup.'),
  ]) assert.equal(evaluateUpdate([item]).allowed, true, item.path)
})

for (const path of [
  'LICENSE', 'catalogue/media/NOTICE.md',
  'frontend/src/store/useStore.js', 'frontend/src/lib/local-mode.js',
  'frontend/src/lib/api.js', 'frontend/src/lib/apiUpload.js',
  'frontend/src/lib/backup-media.js', 'frontend/src/lib/import-csv.js',
  'frontend/src/lib/export-new.js', 'frontend/src/lib/media-store-idb.js',
  'frontend/src/lib/sync-merge.js', 'frontend/src/lib/mobile.js',
  'frontend/src/lib/state.js', 'frontend/src/lib/new-schema.js',
  'frontend/src/views/Settings.jsx', 'frontend/src/views/settings-pages.js',
  'frontend/src/components/SyncBanner.jsx', 'frontend/src/components/NewBackup.jsx',
  'frontend/src/views/Login.jsx', 'frontend/src/views/Admin.jsx',
  'frontend/src/App.jsx', 'frontend/src/main.jsx', 'frontend/index.html',
  'frontend/public/sw.js', 'frontend/public/manifest.json',
  'frontend/vite.config.js', 'frontend/vitest.config.js',
  'frontend/capacitor.config.json', 'frontend/android/settings.gradle',
  '.github/workflows/new-upstream-workflow.yml', '.github/actions/new/action.yml',
  'scripts/maintenance/update-policy.mjs', 'scripts/maintenance/update-policy.test.mjs',
  'scripts/maintenance/fixtures/state.json', 'frontend/scripts/sw-stamp.mjs',
  'catalogue/exercises/0001.json', 'api/server.js', 'unknown/new-file.js',
]) test(`requires review for ${path}`, () => assert.equal(evaluateUpdate([change(path)]).allowed, false))

for (const path of [
  'package.json', 'package-lock.json', 'frontend/package.json',
  'frontend/package-lock.json', 'frontend/yarn.lock', 'frontend/pnpm-lock.yaml',
  'frontend/bun.lock', 'frontend/.npmrc',
]) test(`dependencies cannot change automatically: ${path}`, () => denies(change(path), 'dependencies'))

for (const status of ['A', 'M', 'D']) test(`tests and fixtures require review, status ${status}`, () => {
  for (const path of ['frontend/src/views/Home.test.jsx', 'frontend/src/lib/onerm.spec.js', 'frontend/src/__fixtures__/old-state.json']) {
    assert.equal(evaluateUpdate([change(path, '', { status })]).allowed, false)
  }
})

for (const status of ['D', 'R100', 'R70', 'C100', 'T', 'U', 'X', 'B', 'M100', '?']) {
  test(`does not automatically accept structural status ${status}`, () => denies(change('frontend/src/views/Home.jsx', '', { status }), 'structural-change'))
}

test('both rename endpoints are checked; a protected source cannot hide behind a UI destination', () => {
  denies(change('frontend/src/views/Home.jsx', '', { status: 'R100', oldPath: 'frontend/src/lib/local-mode.js' }), 'structural-change')
  denies(change('frontend/src/views/Home.jsx', '', { oldPath: 'frontend/src/lib/local-mode.js' }), 'structural-change')
  denies(change('frontend/src/views/Home.jsx', '', { status: 'R100', oldPath: '../secrets' }), 'invalid-path')
})

for (const path of [
  '/frontend/src/views/Home.jsx', './frontend/src/views/Home.jsx',
  'frontend//src/views/Home.jsx', 'frontend/src/views/../lib/api.js',
  'frontend\\src\\views\\Home.jsx', 'frontend/src/views/%2e%2e/api.jsx',
  'frontend/src/views/Home.jsx\n.github/workflows/unsafe.yml',
  'frontend/src/views/Home.jsx\0', 'frontend/src/views/Ｈome.jsx',
]) test(`rejects ambiguous path ${JSON.stringify(path)}`, () => denies(change(path), 'invalid-path'))

for (const mode of [undefined, '120000', '160000', '100755', '040000']) {
  test(`blocks missing or unsafe tree mode ${mode}`, () => denies(change('frontend/src/views/Home.jsx', '', { mode }), 'file-mode'))
}

test('also blocks previously executable or symbolic files changed to ordinary files', () => {
  denies(change('frontend/src/views/Home.jsx', '', { oldMode: '120000' }), 'file-mode')
})

for (const body of [
  '+localStorage.clear()', '+window.localStorage.setItem("gym_state_v1", "{}")',
  '+indexedDB.deleteDatabase("media")', '+const db = new IDBDatabase()',
  '+caches.delete("opengym-media")', '+sessionStorage.clear()',
  '+fetch("/api/sync")', '+const f = fetch', '+new XMLHttpRequest()',
  '+api("/sync", data)', '+import { api as send } from "../lib/api.js"',
  '+navigator.sendBeacon("/api/push", data)', '+new WebSocket(url)',
  '+const LOCAL_ONLY = false', '-if (LOCAL_ONLY) return',
  '+useStore.setState({ workouts: [] })', '+db.deleteObjectStore("media")',
  '+resetEverything()', '+deleteWorkout(id)', '+clearAll()',
  '+const schemaVersion = 2', '+const STATE_KEY = "new"',
  '+navigator.serviceWorker.register("/worker.js")', '+window.location = url',
  '+globalThis["local" + "Storage"].clear()', '+eval(code)',
  '+new Function(code)()', '+import(modulePath)', '+require("fs")',
  '+const key = "\\u006cocalStorage"', '+<iframe src={url}/>',
  '+<img src="https://other.example/pixel"/>', '+<div dangerouslySetInnerHTML={html}/>',
]) test(`blocks sensitive code: ${body}`, () => assert.equal(evaluateUpdate([change('frontend/src/components/Chart.jsx', body, { status: 'A' })]).allowed, false, body))

for (const body of [
  '+useStore.getState().update(s => { s.workouts = [] })',
  '+useStore(s => s.update)(s => { s.bodyweight = [] })',
  '+const state = getState(); state.S.routines = []',
  '+store.getState().S.customEx = []',
  '+update(s => { s.workouts = [] })',
  '+actions.update(s => { s.unit = "lb" })',
  '+actions.update?.(s => { s.lang = "en" })',
]) test(`store access from UI requires review: ${body}`, () => {
  denies(change('frontend/src/views/Home.jsx', body), 'persistent-store')
})

for (const body of [
  '+s.workouts = []', '+s.bodyweight = filtered', '+state.routines = replacement',
  '+s.active = null', '+s.measurements.length = 0', '+s.workouts.splice(0)',
  '+s.customEx.pop()', '+s.dayNotes = {}', '+s.exWeights = {}',
  '+delete s.workouts', '+delete s["bodyweight"]',
  '+Object.assign(s, { workouts: [] })',
]) test(`record changes with the store binding outside the patch require review: ${body}`, () => {
  denies(change('frontend/src/views/Home.jsx', body), 'record-write')
})

test('removing a store mutation or changing nearby UI still requires review', () => {
  denies(change('frontend/src/views/Home.jsx', '-update(s => { s.workouts.push(record) })\n+showDone()'), 'persistent-store')
  denies(change('frontend/src/views/Home.jsx', ' const state = useStore()\n-oldTitle()\n+newTitle()'), 'persistent-store')
})

test('removed safeguards and sensitive unchanged context stop the update', () => {
  denies(change('frontend/src/views/Home.jsx', '-if (LOCAL_ONLY) return\n+continueSync()'), 'local-mode')
  denies(change('frontend/src/views/Home.jsx', ' localStorage.setItem(key, state)\n-label()\n+newLabel()'), 'storage-api')
})

test('production to merged candidate must be checked as well as the upstream delta', () => {
  const upstream = [change('frontend/src/views/Home.jsx')]
  const merged = [...upstream, change('frontend/src/lib/local-mode.js', '-export const LOCAL_ONLY = true\n+export const LOCAL_ONLY = false')]
  assert.equal(evaluateUpdate(upstream).allowed, true)
  assert.equal(evaluateUpdate(merged).allowed, false)
})

test('requires complete text patches, rejects duplicate paths and bad input', () => {
  for (const value of [undefined, '', 'Binary files a and b differ', 'GIT binary patch\nliteral 3']) {
    denies(change('frontend/src/views/Home.jsx', '', { patch: value }), 'missing-patch')
  }
  const item = change('frontend/src/views/Home.jsx')
  assert.equal(evaluateUpdate([item, item]).allowed, false)
  assert.equal(evaluateUpdate(null).allowed, false)
  assert.equal(evaluateUpdate([null]).allowed, false)
})

test('parses NUL-delimited ordinary changes and preserves rename/copy sources', () => {
  assert.deepEqual(parseNameStatus('M\0frontend/src/views/Home.jsx\0A\0docs/FAQ.md\0R100\0old.js\0new.js\0C50\0source.js\0copy.js\0'), [
    { status: 'M', path: 'frontend/src/views/Home.jsx' },
    { status: 'A', path: 'docs/FAQ.md' },
    { status: 'R100', oldPath: 'old.js', path: 'new.js' },
    { status: 'C50', oldPath: 'source.js', path: 'copy.js' },
  ])
  assert.deepEqual(parseNameStatus(''), [])
})

test('rejects truncated or line-based name-status output instead of guessing paths', () => {
  for (const output of ['M\tfile.js\n', 'M\0file.js', 'R100\0old.js\0', 'M\0', '?\0file.js\0']) {
    assert.throws(() => parseNameStatus(output), undefined, JSON.stringify(output))
  }
})
