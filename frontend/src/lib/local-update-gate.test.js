// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createLocalUpdateGate, showLocalUpdateMessage } from './local-update-gate.js'

const scope = 'https://gym.test/opengym-local/'
const result = (ok = true, reason = null) => ({ type: 'opengym:local-check', mediaRefsDayPhotos: 1, ok, reason })
const gates = []
class Channel {
  constructor() {
    const port = () => ({ onmessage: null, closed: false, close() { this.closed = true } })
    this.port1 = port(); this.port2 = port()
    this.port1.postMessage = data => queueMicrotask(() => { if (!this.port2.closed) this.port2.onmessage?.({ data }) })
    this.port2.postMessage = data => queueMicrotask(() => { if (!this.port1.closed) this.port1.onmessage?.({ data }) })
  }
}
function environment(answer = result()) {
  const serviceWorker = new EventTarget()
  serviceWorker.controller = { scriptURL: scope + 'sw.js', postMessage: vi.fn((_, ports) => { if (answer) ports[0].postMessage(answer) }) }
  serviceWorker.register = vi.fn(async () => ({ scope }))
  serviceWorker.getRegistration = vi.fn(async () => ({ scope }))
  const gate = createLocalUpdateGate({ serviceWorker, location: { href: scope + '#/home' }, Channel, timeout: 100 })
  gates.push(gate)
  return { gate, serviceWorker }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { for (const gate of gates.splice(0)) gate.dispose(); vi.useRealTimers() })

it('answers capability requests before checking, so simultaneous new documents can recognize each other', () => {
  const { serviceWorker } = environment()
  const source = { postMessage: vi.fn() }
  const event = new Event('message')
  Object.assign(event, { data: { type: 'opengym:local-capability', nonce: 'peer-1' }, source })
  serviceWorker.dispatchEvent(event)
  expect(source.postMessage).toHaveBeenCalledWith({ type: 'opengym:local-capability-reply', nonce: 'peer-1', mediaRefsDayPhotos: 1 })
})

it('admits only an explicit compatible answer from the current, same-scoped worker', async () => {
  const { gate, serviceWorker } = environment()
  await expect(gate.check()).resolves.toEqual({ ok: true, reason: null })
  expect(serviceWorker.register).toHaveBeenCalledWith(scope + 'sw.js', { scope, updateViaCache: 'none' })
})

it('keeps old pages running and returns a retryable block when a peer is incompatible', async () => {
  const { gate } = environment(result(false, 'old-pages'))
  await expect(gate.check()).resolves.toEqual({ ok: false, reason: 'old-pages' })
})

it('an older worker without the protocol times out closed', async () => {
  const { gate } = environment(null)
  const pending = gate.check()
  await vi.advanceTimersByTimeAsync(101)
  await expect(pending).resolves.toEqual({ ok: false, reason: 'unavailable' })
})

it('does not accept malformed or wrong-capability replies', async () => {
  for (const answer of [{ ok: true }, { ...result(), mediaRefsDayPhotos: 0 }, { ...result(), ok: 'yes' }]) {
    await expect(environment(answer).gate.check()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  }
})

it('no worker, failed registration, and another scope all remain blocked', async () => {
  const missing = createLocalUpdateGate({ serviceWorker: null, location: { href: scope }, Channel, timeout: 100 })
  await expect(missing.check()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  const { gate, serviceWorker } = environment()
  serviceWorker.register.mockRejectedValue(new Error('disabled'))
  serviceWorker.getRegistration.mockResolvedValue(undefined)
  await expect(gate.check()).resolves.toEqual({ ok: false, reason: 'unavailable' })
  serviceWorker.register.mockResolvedValue({ scope: 'https://gym.test/' })
  await expect(gate.check()).resolves.toEqual({ ok: false, reason: 'unavailable' })
})

it('an already-installed compatible registration can verify offline', async () => {
  const { gate, serviceWorker } = environment()
  serviceWorker.register.mockRejectedValue(new Error('offline'))
  await expect(gate.check()).resolves.toEqual({ ok: true, reason: null })
})

it('waits for first-install control instead of using a nonexistent controller', async () => {
  const { gate, serviceWorker } = environment()
  const controller = serviceWorker.controller
  serviceWorker.controller = null
  const pending = gate.check()
  await vi.advanceTimersByTimeAsync(1)
  serviceWorker.controller = controller
  serviceWorker.dispatchEvent(new Event('controllerchange'))
  await expect(pending).resolves.toEqual({ ok: true, reason: null })
})

it('a controller change invalidates the pending answer and rechecks with the new worker', async () => {
  const { gate, serviceWorker } = environment(null)
  const pending = gate.check()
  await vi.advanceTimersByTimeAsync(1)
  const replacement = { scriptURL: scope + 'sw.js', postMessage: vi.fn((_, ports) => ports[0].postMessage(result(false, 'old-pages'))) }
  serviceWorker.controller = replacement
  serviceWorker.dispatchEvent(new Event('controllerchange'))
  await expect(pending).resolves.toEqual({ ok: false, reason: 'old-pages' })
  expect(replacement.postMessage).toHaveBeenCalledOnce()
})

it('the blocked screen offers a manual retry without clearing or navigating any page', () => {
  const root = document.createElement('div'), retry = vi.fn()
  showLocalUpdateMessage(root, 'old-pages', retry)
  expect(root.textContent).toContain('请先关闭旧版页面')
  expect(root.textContent).toContain('正在训练的旧页面可以继续使用')
  root.querySelector('button').click()
  expect(retry).toHaveBeenCalledOnce()
})
