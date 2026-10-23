// @vitest-environment happy-dom
// The static site keeps real records on this device: no demo history, restored account or
// background sync may turn a local-only boot into a request to a data server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ api: vi.fn(), setRemoteAuth: vi.fn() }))
vi.mock('../lib/api.js', () => ({ api: h.api, setRemoteAuth: h.setRemoteAuth }))
vi.mock('./useUI.js', () => ({ useUI: { getState: () => ({ toast: () => {} }) } }))

const STATE_KEY = 'gym_state_v1'
const saved = () => JSON.parse(localStorage.getItem(STATE_KEY))
const workout = (id, d = '2026-10-23') => ({ id, d, name: 'My workout', start: 1, entries: [] })
let opened = []
let fetch

async function openStore() {
  vi.resetModules()
  const { useStore } = await import('./useStore.js')
  opened.push(useStore)
  return useStore
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('VITE_LOCAL', '1')
  vi.stubEnv('VITE_DEMO', '0')
  vi.stubEnv('VITE_MOBILE', '0')
  localStorage.clear()
  opened = []
  h.api.mockReset().mockRejectedValue(new Error('No data server exists'))
  h.setRemoteAuth.mockReset()
  fetch = vi.fn().mockRejectedValue(new Error('Unexpected network request'))
  vi.stubGlobal('fetch', fetch)
})

afterEach(() => {
  for (const store of opened) store.setState({ user: null, ready: false })
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  localStorage.clear()
})

describe('the local-only static site', () => {
  it('opens an empty guest profile in Chinese without seeding examples or asking a server', async () => {
    const store = await openStore()
    const resetDemo = vi.spyOn(store.getState(), 'resetDemo')
    const { LOCAL_ONLY, LOCAL_CONFIG } = await import('../lib/local-mode.js')
    const { effectiveLang } = await import('../lib/default-lang.js')

    expect(LOCAL_ONLY).toBe(true)
    await store.getState().boot()

    const st = store.getState()
    expect(st.ready).toBe(true)
    expect(st.user).toBeNull()
    expect(st.isGuest()).toBe(true)
    expect(st.needsMobileOnboarding).toBe(false)
    expect(st.S.workouts).toEqual([])
    expect(st.S.routines).toEqual([])
    expect(st.S.bodyweight).toEqual([])
    expect(st.S.customEx).toEqual([])
    expect(st.config).toEqual(LOCAL_CONFIG)
    expect(effectiveLang(st.S, st.config, ['en-US'])).toBe('zh')
    expect(resetDemo).not.toHaveBeenCalled()
    expect(localStorage.getItem('gym_demo_seeded_v1')).toBeNull()
    expect(h.api).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not restore a saved signed-in account or send its records after boot, focus or reconnect', async () => {
    const existing = workout('my-saved-workout')
    localStorage.setItem(STATE_KEY, JSON.stringify({ workouts: [existing] }))
    localStorage.setItem('gym_user', JSON.stringify({ id: 'old-account', name: 'Previous account', admin: true }))
    localStorage.setItem('gym_owner', 'old-account')
    localStorage.setItem('gym_dirty', '1')
    localStorage.setItem('gym_sync', JSON.stringify({ rev: 4, ts: 100 }))
    // Even an unfinished sign-out from a previous deployment must not contact its server.
    localStorage.setItem('gym_logout_owed', '1')

    const store = await openStore()
    expect(store.getState().user).toBeNull()
    await store.getState().boot()
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await vi.advanceTimersByTimeAsync(31000)

    expect(store.getState().user).toBeNull()
    expect(store.getState().isGuest()).toBe(true)
    expect(store.getState().S.workouts).toEqual([existing])
    expect(saved().workouts).toEqual([existing])
    expect(h.api).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps existing records and language choices, persists edits, and reads them back on the next open', async () => {
    const original = workout('first')
    const added = workout('second', '2026-10-24')
    localStorage.setItem(STATE_KEY, JSON.stringify({ workouts: [original], lang: 'en', langAuto: false }))

    const first = await openStore()
    await first.getState().boot()
    first.getState().update(s => { s.workouts.push(added); s.restSec = 90 })
    await vi.advanceTimersByTimeAsync(2000)

    const persisted = saved()
    expect(persisted.workouts).toMatchObject([original, added])
    expect(persisted.restSec).toBe(90)
    first.setState({ ready: false })

    const reopened = await openStore()
    await reopened.getState().boot()
    const { effectiveLang } = await import('../lib/default-lang.js')
    const st = reopened.getState()
    expect(st.S.workouts).toEqual(persisted.workouts)
    expect(st.S.restSec).toBe(90)
    expect(effectiveLang(st.S, st.config, ['zh-CN'])).toBe('en')
    expect(h.api).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('answers both configuration methods locally even when asked to refresh', async () => {
    const store = await openStore()
    const { LOCAL_CONFIG } = await import('../lib/local-mode.js')
    expect(LOCAL_CONFIG).toMatchObject({ allow_guest: true, default_lang: 'zh', coach: { enabled: false } })

    await expect(store.getState().loadConfig()).resolves.toEqual(LOCAL_CONFIG)
    await expect(store.getState().refreshConfig()).resolves.toEqual(LOCAL_CONFIG)
    await expect(store.getState().refreshConfig()).resolves.toEqual(LOCAL_CONFIG)
    expect(store.getState().config).toEqual(LOCAL_CONFIG)
    expect(h.api).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
