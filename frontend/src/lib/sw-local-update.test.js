import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash, webcrypto } from 'node:crypto'
import vm from 'node:vm'

const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
const scope = 'https://gym.test/opengym-local/'
function worker(profiles = [{ id: 'new', compatible: true }], local = true) {
  const handlers = {}, clients = new Map(), cache = new Map()
  const environment = {
    self: { addEventListener: (type, handler) => { handlers[type] = handler }, registration: { scope }, clients: {
      matchAll: vi.fn(async () => [...clients.values()]),
      get: vi.fn(async id => clients.get(id)),
    } },
    caches: { open: vi.fn(async () => ({ match: async key => cache.get(key)?.clone() })) },
    fetch: vi.fn(async () => new Response('old network document')),
    location: new URL(scope + 'sw.js'), URL, Response, setTimeout, clearTimeout, Date,
  }
  vm.runInNewContext(source.replace('__LOCAL_ONLY__', local ? '1' : '0'), environment)
  const add = profile => {
    const client = { type: 'window', url: scope, ...profile, navigate: vi.fn() }
    client.postMessage = vi.fn(data => {
      if (client.compatible) handlers.message({ source: client, data: { type: 'opengym:local-capability-reply', nonce: data.nonce, mediaRefsDayPhotos: 1 } })
    })
    clients.set(client.id, client)
    return client
  }
  profiles.forEach(add)
  const check = (id = 'new') => {
    let pending
    const reply = vi.fn()
    handlers.message({ source: clients.get(id), data: { type: 'opengym:local-check' }, ports: [{ postMessage: reply }], waitUntil: promise => { pending = promise } })
    return { reply, done: () => pending }
  }
  const navigate = async url => {
    let response
    handlers.fetch({ request: { url, method: 'GET', mode: 'navigate' }, respondWith: promise => { response = promise } })
    return response
  }
  return { ...environment, handlers, clients, cache, add, check, navigate }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it('new documents recognize one another, including uncontrolled windows in the same scope', async () => {
  const env = worker([{ id: 'new', compatible: true }, { id: 'peer', compatible: true }])
  const check = env.check()
  await check.done()
  expect(check.reply).toHaveBeenCalledWith({ type: 'opengym:local-check', mediaRefsDayPhotos: 1, ok: true, reason: null })
  expect(env.self.clients.matchAll).toHaveBeenCalledWith({ type: 'window', includeUncontrolled: true })
  expect(env.clients.get('peer').postMessage).toHaveBeenCalledOnce()
})

it('a silent old or hidden page blocks the new app without navigating or changing that page', async () => {
  const env = worker([{ id: 'new', compatible: true }, { id: 'old', visibilityState: 'hidden' }])
  const check = env.check()
  await vi.advanceTimersByTimeAsync(1801)
  await check.done()
  expect(check.reply).toHaveBeenCalledWith({ type: 'opengym:local-check', mediaRefsDayPhotos: 1, ok: false, reason: 'old-pages' })
  expect(env.clients.get('old').navigate).not.toHaveBeenCalled()
  expect(env.caches.open).not.toHaveBeenCalled()
})

it('a page actually closed during the wait no longer blocks startup', async () => {
  const env = worker([{ id: 'new', compatible: true }, { id: 'old' }])
  const check = env.check()
  await vi.advanceTimersByTimeAsync(1)
  env.clients.delete('old')
  await vi.advanceTimersByTimeAsync(1800)
  await check.done()
  expect(check.reply.mock.calls[0][0].ok).toBe(true)
})

it('does not ask other origins, adjacent path prefixes, or non-window clients', async () => {
  const env = worker([{ id: 'new', compatible: true },
    { id: 'other-origin', url: 'https://elsewhere.test/opengym-local/' },
    { id: 'other-path', url: 'https://gym.test/opengym-local-other/' },
    { id: 'not-window', type: 'worker' },
  ])
  const check = env.check()
  await check.done()
  expect(check.reply.mock.calls[0][0].ok).toBe(true)
  for (const id of ['other-origin', 'other-path', 'not-window']) expect(env.clients.get(id).postMessage).not.toHaveBeenCalled()
})

it('binds each nonce response to its client rather than trusting a reply from another window', async () => {
  const env = worker([{ id: 'new', compatible: true }, { id: 'old' }])
  env.clients.get('old').postMessage.mockImplementation(data => {
    env.handlers.message({ source: env.clients.get('new'), data: { type: 'opengym:local-capability-reply', nonce: data.nonce, mediaRefsDayPhotos: 1 } })
  })
  const check = env.check()
  await vi.advanceTimersByTimeAsync(1801)
  await check.done()
  expect(check.reply.mock.calls[0][0].ok).toBe(false)
})

it('re-enumerates so an old document appearing during a check is not missed', async () => {
  const env = worker()
  const answer = env.clients.get('new').postMessage.getMockImplementation()
  env.clients.get('new').postMessage.mockImplementation(data => { env.add({ id: 'late-old' }); answer(data) })
  const check = env.check()
  await vi.advanceTimersByTimeAsync(1801)
  await check.done()
  expect(env.clients.get('late-old').postMessage).toHaveBeenCalledOnce()
  expect(check.reply.mock.calls[0][0].ok).toBe(false)
})

it('enumeration and client lookup failures fail closed', async () => {
  const env = worker()
  env.self.clients.matchAll.mockRejectedValue(new Error('unavailable'))
  const check = env.check()
  await check.done()
  expect(check.reply.mock.calls[0][0]).toMatchObject({ ok: false, reason: 'unavailable' })
  const broken = worker([{ id: 'new', compatible: true }, { id: 'old' }])
  broken.self.clients.get.mockRejectedValue(new Error('unavailable'))
  const waiting = broken.check()
  await vi.advanceTimersByTimeAsync(1801)
  await waiting.done()
  expect(waiting.reply.mock.calls[0][0].ok).toBe(false)
})

it('ordinary non-local workers do not use the local startup protocol', () => {
  const env = worker(undefined, false)
  const check = env.check()
  expect(check.done()).toBeUndefined()
  expect(env.self.clients.matchAll).not.toHaveBeenCalled()
})

it('local navigations use only this worker build shell, never old network HTML', async () => {
  const env = worker()
  env.cache.set('index.html', new Response('compatible cached document'))
  const response = await env.navigate(scope)
  expect(await response.text()).toBe('compatible cached document')
  expect(env.fetch).not.toHaveBeenCalled()
})

it('a controlled local page can navigate outside its scope without receiving the app shell', async () => {
  const env = worker()
  env.cache.set('index.html', new Response('compatible cached document'))
  for (const url of ['https://gym.test/__opengym_upgrade_fixture', 'https://gym.test/opengym-local-other/']) {
    expect(await env.navigate(url)).toBeUndefined()
  }
  expect(env.caches.open).not.toHaveBeenCalled()
  expect(env.fetch).not.toHaveBeenCalled()
})

it('a missing local shell is an explicit unavailable response, not an unverified network document', async () => {
  const env = worker()
  const response = await env.navigate(scope)
  expect(response.status).toBe(503)
  expect(env.fetch).not.toHaveBeenCalled()
})

it('an index.html fetch cannot overwrite the verified local navigation shell with network HTML', async () => {
  const env = worker()
  env.cache.set('index.html', new Response('verified shell'))
  let result
  env.handlers.fetch({ request: { url: scope + 'index.html?refresh=1', method: 'GET', mode: 'cors' }, respondWith: response => { result = response } })
  expect(await (await result).text()).toBe('verified shell')
  expect(env.fetch).not.toHaveBeenCalled()
})

async function installFixture({ failedChunk = false, redirectedChunk = false, wrongHTML = false, brokenCrypto = false, local = true } = {}) {
  const shell = '<html><head><script src="./assets/main.js"></script></head></html>'
  const hash = createHash('sha256').update(shell).digest('hex').slice(0, 10)
  const cacheName = 'opengym-rt-' + hash
  const handlers = {}, stores = new Map([['opengym-rt-previous', new Map([['index.html', new Response('working previous shell')]])]])
  const caches = {
    open: async name => {
      if (!stores.has(name)) stores.set(name, new Map())
      const store = stores.get(name)
      return { match: async key => store.get(key)?.clone(), put: async (key, value) => { store.set(key, value) }, keys: async () => [...store.keys()], add: async () => {} }
    },
    keys: async () => [...stores.keys()],
    delete: vi.fn(async name => stores.delete(name)),
  }
  const self = { addEventListener: (type, handler) => { handlers[type] = handler }, skipWaiting: vi.fn(), clients: { claim: vi.fn() }, registration: { scope } }
  const fetch = vi.fn(async url => {
    if (url === 'index.html') return new Response(wrongHTML ? 'old HTTP-cached shell' : shell)
    if (url === './assets/App.js' && failedChunk) return new Response('missing', { status: 404 })
    const response = new Response('working JavaScript', { headers: { 'content-type': 'text/javascript' } })
    if (url === './assets/App.js' && redirectedChunk) Object.defineProperty(response, 'redirected', { value: true })
    return response
  })
  const script = source.replace('__LOCAL_ONLY__', local ? '1' : '0').replace('__BUILD__', hash)
    .replace("'__LAZY__'", JSON.stringify(JSON.stringify(['./assets/App.js'])))
  vm.runInNewContext(script, { self, caches, fetch, crypto: brokenCrypto ? {} : webcrypto, TextDecoder, Uint8Array, Response, URL, location: new URL(scope + 'sw.js'), setTimeout, clearTimeout })
  const fire = type => { let pending; handlers[type]({ waitUntil: promise => { pending = promise } }); return pending }
  return { self, stores, cacheName, caches, fetch, fire }
}

for (const failure of ['failedChunk', 'redirectedChunk', 'wrongHTML', 'brokenCrypto']) {
  it(`a local install with ${failure} keeps the previous working build and never activates`, async () => {
    const env = await installFixture({ [failure]: true })
    await expect(env.fire('install')).rejects.toThrow()
    expect(env.self.skipWaiting).not.toHaveBeenCalled()
    expect(env.stores.get(env.cacheName).has('index.html')).toBe(false)
    // Even an unexpected activation must not sweep the old cache without a verified shell.
    await env.fire('activate')
    expect(env.caches.delete).not.toHaveBeenCalled()
    expect(await env.stores.get('opengym-rt-previous').get('index.html').text()).toBe('working previous shell')
  })
}

it('a server build missing its dynamically imported App code also preserves its previous offline shell', async () => {
  const env = await installFixture({ failedChunk: true, local: false })
  await expect(env.fire('install')).rejects.toThrow()
  expect(env.self.skipWaiting).not.toHaveBeenCalled()
  expect(env.stores.get(env.cacheName).has('index.html')).toBe(false)
  await env.fire('activate')
  expect(env.caches.delete).not.toHaveBeenCalled()
  expect(await env.stores.get('opengym-rt-previous').get('index.html').text()).toBe('working previous shell')
})

it('a local install only admits the matching HTML after its dynamically imported App code is cached', async () => {
  const env = await installFixture()
  await env.fire('install')
  expect(env.self.skipWaiting).toHaveBeenCalledOnce()
  expect(env.stores.get(env.cacheName).has('./assets/App.js')).toBe(true)
  expect(env.stores.get(env.cacheName).has('index.html')).toBe(true)
  await env.fire('activate')
  expect(env.stores.has('opengym-rt-previous')).toBe(false)
})
