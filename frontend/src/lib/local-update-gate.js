// No store, media or persistence imports here: this runs before any application state opens.
// Capability describes the media references this document preserves, not its release number.
const CAPABILITY = 'opengym:local-capability'
const CHECK = 'opengym:local-check'
const REPLY = 'opengym:local-capability-reply'

function bounded(promise, ms) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms) })])
    .finally(() => clearTimeout(timer))
}

export function createLocalUpdateGate({ serviceWorker = navigator.serviceWorker, location = window.location, Channel = globalThis.MessageChannel, timeout = 12000 } = {}) {
  const scope = new URL('./', location.href)
  const responder = event => {
    if (event.data?.type !== CAPABILITY || typeof event.data.nonce !== 'string') return
    try { event.source?.postMessage({ type: REPLY, nonce: event.data.nonce, mediaRefsDayPhotos: 1 }) } catch {}
  }
  serviceWorker?.addEventListener('message', responder)

  const probe = controller => new Promise(resolve => {
    const channel = new Channel()
    let timer
    const finish = result => {
      clearTimeout(timer)
      serviceWorker.removeEventListener('controllerchange', changed)
      channel.port1.close()
      channel.port2.close()
      resolve(result)
    }
    const changed = () => finish({ ok: false, reason: 'changed' })
    serviceWorker.addEventListener('controllerchange', changed, { once: true })
    timer = setTimeout(() => finish({ ok: false, reason: 'unavailable' }), timeout)
    channel.port1.onmessage = event => {
      if (serviceWorker.controller !== controller) return changed()
      const result = event.data
      finish(result?.type === CHECK && result.mediaRefsDayPhotos === 1 && typeof result.ok === 'boolean'
        ? { ok: result.ok, reason: result.ok ? null : result.reason === 'old-pages' ? 'old-pages' : 'unavailable' }
        : { ok: false, reason: 'unavailable' })
    }
    try { controller.postMessage({ type: CHECK }, [channel.port2]) } catch { finish({ ok: false, reason: 'unavailable' }) }
  })

  const waitForController = () => {
    if (serviceWorker.controller) return Promise.resolve(serviceWorker.controller)
    return new Promise(resolve => {
      const changed = () => { if (serviceWorker.controller) { clearTimeout(timer); serviceWorker.removeEventListener('controllerchange', changed); resolve(serviceWorker.controller) } }
      const timer = setTimeout(() => { serviceWorker.removeEventListener('controllerchange', changed); resolve(null) }, timeout)
      serviceWorker.addEventListener('controllerchange', changed)
      changed()
    })
  }

  return {
    async check() {
      if (!serviceWorker || !Channel || !['https:', 'http:'].includes(scope.protocol)) return { ok: false, reason: 'unavailable' }
      try {
        // register also checks for an update. An already-installed compatible worker can still
        // answer offline; a failed registration may only use that same scoped registration.
        let registration
        try { registration = await bounded(serviceWorker.register(new URL('sw.js', scope).href, { scope: scope.href, updateViaCache: 'none' }), timeout) }
        catch { registration = await bounded(serviceWorker.getRegistration(scope.href), timeout) }
        if (!registration || registration.scope !== scope.href) return { ok: false, reason: 'unavailable' }
        for (let attempts = 0; attempts < 3; attempts++) {
          const controller = await waitForController()
          if (!controller || new URL(controller.scriptURL).href !== new URL('sw.js', scope).href) return { ok: false, reason: 'unavailable' }
          const result = await probe(controller)
          if (result.reason !== 'changed') return result
        }
      } catch {}
      return { ok: false, reason: 'unavailable' }
    },
    dispose() { serviceWorker?.removeEventListener('message', responder) },
  }
}

export function showLocalUpdateMessage(root, reason, retry) {
  const panel = document.createElement('main')
  panel.className = 'narrow'
  panel.style.paddingTop = '20vh'
  const title = document.createElement('h1')
  title.textContent = reason === 'checking' ? '正在检查已有页面…' : reason === 'old-pages' ? '请先关闭旧版页面' : '暂时无法检查其他页面'
  const body = document.createElement('p')
  body.textContent = reason === 'checking' ? '请稍候，正在确认页面兼容性。'
    : reason === 'old-pages' ? '为了保留已有记录，请关闭其他 openGym 页面，再重试。正在训练的旧页面可以继续使用。'
      : '请联网后重试。检查完成前，此页面不会打开训练记录；其他已打开的页面可以继续使用。'
  panel.append(title, body)
  if (retry) {
    const button = document.createElement('button')
    button.className = 'btn primary'
    button.textContent = '重试'
    button.addEventListener('click', retry)
    panel.append(button)
  }
  root.replaceChildren(panel)
}
