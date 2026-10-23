// Synthetic data only. Stable dates and real image bytes make loss visible without borrowing
// a personal browser profile or connecting to a deployed instance.
import { createHash } from 'node:crypto'

export const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64')
export const imageHash = createHash('sha256').update(image).digest('hex')
// A different, valid PNG referenced ONLY by dayPhotos. Reusing the exercise's hash would let
// an older app accidentally keep this file for the wrong reason and hide unsafe rollback GC.
export const dayImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
export const dayImageHash = createHash('sha256').update(dayImage).digest('hex')
export const exerciseFile = { hash: imageHash, bytes: image, mime: 'image/png' }
export const dayFile = { hash: dayImageHash, bytes: dayImage, mime: 'image/png' }
const at = Date.parse('2026-01-12T08:00:00Z')

export function withDayPhoto(state) {
  const removed = createHash('sha256').update('Previously removed synthetic day photo').digest('hex')
  return { ...state, dayPhotos: { ...(state.dayPhotos || {}), [removed]: { _ts: at - 1000 }, [dayImageHash]: {
    d: '2026-01-21', _ts: at,
    m: { kind: 'image', hash: dayImageHash, mime: 'image/png', size: dayImage.length, width: 1, height: 1, at },
  } } }
}

export function fixture(who = 'a', withMedia = true) {
  const exercise = `upgrade-${who}-exercise`
  const routine = `upgrade-${who}-routine`
  const media = { kind: 'image', hash: imageHash, mime: 'image/png', size: image.length, width: 1, height: 1, at }
  return {
    lang: 'en', langAuto: false, unit: 'kg', theme: 'dark', accent: 'lime', body: 'female',
    restSec: 75, restPauseSec: 20, sound: false, vibrate: false, weekStart: 0, wdec: 2,
    targetW: 61.5, weighIn: false, gifSize: 'mini', workoutView: 'compact', checkIn: false,
    reminder: { on: false, time: '09:15', tz: 'Asia/Taipei', nudge: false, tone: 'friendly' },
    customEx: [{ id: exercise, n: `Upgrade ${who.toUpperCase()} custom row`, bp: 'back', eq: 'dumbbell',
      custom: true, primary: ['lats'], secondary: ['biceps'], ...(withMedia ? { media } : {}) }],
    routines: [{ id: routine, name: `Upgrade ${who.toUpperCase()} plan`, prog: 'linear',
      ex: [{ id: exercise, sets: 2, reps: 8, weight: 22.5, rest: 75, note: 'Synthetic plan note' }] }],
    week: { 1: [routine], 4: [routine] }, dayPlan: { '2026-01-15': [routine] },
    workouts: [{ id: `upgrade-${who}-workout`, d: '2026-01-12', name: `Upgrade ${who.toUpperCase()} history`,
      rid: routine, start: at, end: at + 1800000, duration: 1800, bw: 64.25, note: 'Synthetic history note',
      entries: [{ id: exercise, sets: [{ w: 22.5, r: 8, done: true, rir: 2 }, { w: 22.5, r: 7, done: true, rir: 1 }], topW: 22.5 }],
      ...(withMedia ? { media: [media] } : {}) }],
    bodyweight: [{ d: '2026-01-10', w: 64.75, t: at - 172800000 }, { d: '2026-01-12', w: 64.25, t: at }],
    exWeights: { [exercise]: { w: 22.5, d: '2026-01-12' } },
    exNotes: { [exercise]: 'Synthetic equipment note' }, favEx: [exercise],
    active: { rid: routine, name: `Upgrade ${who.toUpperCase()} unfinished session`, d: '2026-01-13', start: at + 86400000, cur: 0,
      entries: [{ id: exercise, target: 22.5, sets: [{ w: 22.5, r: 8, done: true }, { w: 22.5, r: 8, done: false }] }] },
    // These are part of the saved copy, not just display values: losing a deletion/reset mark
    // during a program upgrade could bring an intentionally removed record back later.
    deleted: { workouts: { [`upgrade-${who}-deleted`]: at - 1000 } },
    resetAt: at - 10000, resetIds: { workouts: [`upgrade-${who}-old-reset`] },
    unitSet: { at: at - 5000, convert: false }, _ts: at,
  }
}
