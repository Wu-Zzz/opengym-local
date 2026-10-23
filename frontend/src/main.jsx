import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LOCAL_ONLY } from './lib/local-mode.js'
import { createLocalUpdateGate, showLocalUpdateMessage } from './lib/local-update-gate.js'
import './index.css'
import { hideBoot } from './lib/boot.js'

// App.jsx restores per-route scroll itself; the browser's own attempt races it.
// A script that dies before the app draws would otherwise leave the boot logo lifting forever.
window.addEventListener('error', hideBoot, { once: true })

if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

async function startApp() {
  // Importing the store already opens local state. Keep it, App and media cleanup behind
  // the compatibility check, not merely behind a screen rendered over the running app.
  const [{ default: App }, { MOBILE }, { useStore }, { startMediaSync }, { startNativeKeyboard }] = await Promise.all([
    import('./App.jsx'), import('./lib/mobile.js'), import('./store/useStore.js'),
    import('./lib/media-sync.js'), import('./lib/native-keyboard.js'),
  ])
  createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>)

  // The photos and videos of custom exercises, in every build (the phone and the demo included):
  // uploads of what the server lacks, the local clean-up, and the plan's files kept offline.
  startMediaSync(useStore)

  // Android 15 does not resize the page for the soft keyboard; the app says how much it covers and
  // this keeps the focused field above it. Idle everywhere else.
  startNativeKeyboard()

  // Not in the mobile build: the native shell already serves everything from disk.
  if (!MOBILE && 'serviceWorker' in navigator && location.protocol === 'https:') {
    if (!LOCAL_ONLY) navigator.serviceWorker.register('sw.js').catch(() => {})
    // The plan's exercise media, kept by the worker for a workout opened without a network (#281).
    // It only fetches ahead while the page runs as the installed app; a tab keeps what it has shown.
    import('./lib/media-prefetch.js').then(m => m.startMediaPrefetch(useStore)).catch(() => {})
  }
}

if (LOCAL_ONLY) {
  const gate = createLocalUpdateGate()
  const root = document.getElementById('root')
  // A restored new document must check again before its UI can be used. Never reload an
  // older document from the worker: it may be in the middle of someone's workout.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload() })
  let checking = false
  const open = async () => {
    if (checking) return
    checking = true
    showLocalUpdateMessage(root, 'checking')
    hideBoot()
    const result = await gate.check()
    checking = false
    if (result.ok) { root.replaceChildren(); await startApp() }
    else showLocalUpdateMessage(root, result.reason, open)
  }
  open()
} else {
  startApp()
}
