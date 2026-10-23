// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const calls = vi.hoisted(() => ({ check: vi.fn(), message: vi.fn(), appImport: vi.fn(), storeImport: vi.fn(), sync: vi.fn(), render: vi.fn() }))
vi.mock('./lib/local-mode.js', () => ({ LOCAL_ONLY: true }))
vi.mock('./lib/local-update-gate.js', () => ({ createLocalUpdateGate: () => ({ check: calls.check }), showLocalUpdateMessage: (...args) => calls.message(...args) }))
vi.mock('./lib/boot.js', () => ({ hideBoot: vi.fn() }))
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: calls.render }) }))
vi.mock('./App.jsx', () => { calls.appImport(); return { default: () => null } })
vi.mock('./store/useStore.js', () => { calls.storeImport(); return { useStore: {} } })
vi.mock('./lib/mobile.js', () => ({ MOBILE: false }))
vi.mock('./lib/media-sync.js', () => ({ startMediaSync: calls.sync }))
vi.mock('./lib/native-keyboard.js', () => ({ startNativeKeyboard: vi.fn() }))
vi.mock('./lib/media-prefetch.js', () => ({ startMediaPrefetch: vi.fn() }))

let listen
beforeEach(() => {
  vi.resetModules()
  for (const call of Object.values(calls)) call.mockReset()
  document.body.innerHTML = '<div id="root"></div>'
  listen = vi.spyOn(window, 'addEventListener')
})
afterEach(() => {
  for (const [event, callback] of listen.mock.calls) window.removeEventListener(event, callback)
  listen.mockRestore()
})

it('a blocked startup does not even import the stateful application or start media cleanup', async () => {
  calls.check.mockResolvedValue({ ok: false, reason: 'old-pages' })
  await import('./main.jsx')
  await vi.waitFor(() => expect(calls.message).toHaveBeenLastCalledWith(document.getElementById('root'), 'old-pages', expect.any(Function)))
  expect(calls.appImport).not.toHaveBeenCalled()
  expect(calls.storeImport).not.toHaveBeenCalled()
  expect(calls.sync).not.toHaveBeenCalled()
  expect(calls.render).not.toHaveBeenCalled()
})

it('only a successful retry may import state and start the app', async () => {
  calls.check.mockResolvedValueOnce({ ok: false, reason: 'old-pages' }).mockResolvedValueOnce({ ok: true })
  await import('./main.jsx')
  await vi.waitFor(() => expect(calls.message).toHaveBeenLastCalledWith(document.getElementById('root'), 'old-pages', expect.any(Function)))
  const retry = calls.message.mock.calls.at(-1)[2]
  expect(calls.storeImport).not.toHaveBeenCalled()
  await retry()
  expect(calls.appImport).toHaveBeenCalledOnce()
  expect(calls.storeImport).toHaveBeenCalledOnce()
  expect(calls.sync).toHaveBeenCalledOnce()
  expect(calls.render).toHaveBeenCalledOnce()
})
