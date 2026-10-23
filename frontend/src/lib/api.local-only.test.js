// @vitest-environment happy-dom
// Data transports are an independent backstop: a hidden UI or an old paired-server value
// must never let the static build send records, media or activity to a backend.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let transport
let fetch
let XHR
let sendBeacon
let originalBeacon

beforeEach(async () => {
  vi.resetModules()
  vi.stubEnv('VITE_LOCAL', '1')
  vi.stubEnv('VITE_MOBILE', '0')
  fetch = vi.fn().mockRejectedValue(new Error('Unexpected network request'))
  XHR = vi.fn(function XMLHttpRequest() { throw new Error('Unexpected upload') })
  sendBeacon = vi.fn(() => true)
  vi.stubGlobal('fetch', fetch)
  vi.stubGlobal('XMLHttpRequest', XHR)
  originalBeacon = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon')
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true })
  transport = await import('./api.js')
})

afterEach(() => {
  transport.setRemoteAuth('', null)
  if (originalBeacon) Object.defineProperty(navigator, 'sendBeacon', originalBeacon)
  else delete navigator.sendBeacon
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const denied = { code: 'local-only', status: 0 }

describe.each([false, true])('local-only data transports (remote configured: %s)', paired => {
  beforeEach(() => { if (paired) transport.setRemoteAuth('https://gym.example.com', 'OLD-TOKEN') })

  it('rejects JSON reads and writes before fetch', async () => {
    await expect(transport.api('/api/me')).rejects.toMatchObject(denied)
    await expect(transport.api('/api/data', { method: 'PUT', body: JSON.stringify({ workouts: [{ id: 'private' }] }) }))
      .rejects.toMatchObject(denied)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects media downloads before either the default or injected fetch runs', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Unexpected media request'))
    await expect(transport.apiBlob('/api/media/private-photo')).rejects.toMatchObject(denied)
    await expect(transport.apiBlob('/api/media/private-photo', { expectSize: 10, fetchImpl })).rejects.toMatchObject(denied)
    expect(fetch).not.toHaveBeenCalled()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('rejects media uploads before creating either the default or injected XMLHttpRequest', async () => {
    const injectedXHR = vi.fn(function XMLHttpRequest() { throw new Error('Unexpected media upload') })
    const photo = new Blob(['private photo'], { type: 'image/jpeg' })
    await expect(transport.apiUpload('/api/media/private-photo', photo, photo.type)).rejects.toMatchObject(denied)
    await expect(transport.apiUpload('/api/media/private-photo', photo, photo.type, { XHR: injectedXHR })).rejects.toMatchObject(denied)
    expect(XHR).not.toHaveBeenCalled()
    expect(injectedXHR).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not send activity beacons', () => {
    expect(transport.beacon('/api/activity', { active: false, reason: 'closed' })).toBe(false)
    expect(sendBeacon).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects pairing before requesting or probing the supplied server', async () => {
    await expect(transport.pairRedeem('https://gym.example.com', '123456')).rejects.toMatchObject(denied)
    expect(fetch).not.toHaveBeenCalled()
    expect(XHR).not.toHaveBeenCalled()
  })
})
