// Exercise Vite's real HTML transform and service-worker stamping with a tiny application.
// Maintenance-only releases must still get a new cache without putting a SHA in the version UI.
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = fileURLToPath(new URL('../../', import.meta.url))
const version = JSON.parse(readFileSync(join(frontend, 'package.json'), 'utf8')).version
const worker = readFileSync(join(frontend, 'public/sw.js'), 'utf8')
const directories = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

async function buildFixture(local, buildId) {
  vi.stubEnv('VITE_LOCAL', local ? '1' : '0')
  vi.stubEnv('VITE_MOBILE', '0')
  vi.stubEnv('VITE_UMAMI_SRC', '')
  vi.stubEnv('VITE_UMAMI_ID', '')
  vi.stubEnv('APP_BUILD', buildId)
  vi.resetModules()
  const [{ default: config }, { build }] = await Promise.all([import('../../vite.config.js'), import('vite')])
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'opengym-version-')))
  directories.push(root)
  mkdirSync(join(root, 'public'))
  writeFileSync(join(root, 'public/sw.js'), worker)
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="./main.js"></script></body></html>')
  writeFileSync(join(root, 'main.js'), 'document.body.textContent = "v" + __APP_VERSION__')
  await build({ ...config, configFile: false, root, logLevel: 'silent', build: { ...config.build, outDir: 'dist' } })
  const output = join(root, 'dist')
  const html = readFileSync(join(output, 'index.html'), 'utf8')
  const sw = readFileSync(join(output, 'sw.js'), 'utf8')
  const js = readdirSync(join(output, 'assets')).filter(file => file.endsWith('.js'))
    .map(file => readFileSync(join(output, 'assets', file), 'utf8')).join('\n')
  return { html, sw, js, version: JSON.parse(config.define.__APP_VERSION__) }
}

it('local builds show the release version while different build identities change HTML and worker caches', async () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40)
  const first = await buildFixture(true, a)
  const second = await buildFixture(true, b)
  expect(first.version).toBe(version)
  expect(second.version).toBe(version)
  expect(first.js).toContain(version)
  expect(first.js).not.toContain(a)
  expect(second.js).not.toContain(b)
  expect(first.html).toContain(`name="opengym-build" content="${a}"`)
  expect(second.html).toContain(`name="opengym-build" content="${b}"`)
  expect(first.html).not.toBe(second.html)
  const cache = source => source.match(/const CACHE = '(opengym-rt-[a-f0-9]{10})'/)?.[1]
  expect(cache(first.sw)).toBeTruthy()
  expect(cache(second.sw)).toBeTruthy()
  expect(cache(first.sw)).not.toBe(cache(second.sw))
  expect(first.sw).not.toContain('__BUILD__')
  expect(first.sw).toContain("const LOCAL_ONLY = '1' === '1'")
}, 20000)

it('ordinary upstream builds retain their version metadata and do not get the local build tag', async () => {
  const buildId = 'original-build'
  const output = await buildFixture(false, buildId)
  expect(output.version).toBe(`${version}+${buildId}`)
  expect(output.js).toContain(`${version}+${buildId}`)
  expect(output.html).not.toContain('opengym-build')
  expect(output.sw).toContain("const LOCAL_ONLY = '0' === '1'")
}, 20000)
