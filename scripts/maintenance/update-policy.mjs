// Conservative compatibility gate, not a security sandbox or a proof of data safety.
// Run this trusted copy against BOTH base -> upstream and production -> merged candidate.
// The latter is essential: a three-way merge can change this fork's local-only protections.
// Only the caller's Git-generated, complete patches and tree modes are valid input.

const PURE_HELPERS = new Set([
  'bar', 'bodyweight', 'duration', 'effort', 'onerm', 'plates', 'progression',
  'recovery', 'recovery-view', 'rep-range', 'speed', 'structuralBalance-view',
])

const TEST_PATH = /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|fixtures|test|tests|e2e)(?:\/|$)|(?:\.|-)(?:test|spec|fixture|snap)(?:\.|$)/i
const PROTECTED_PATH = /(?:^|\/)(?:store|storage|schema|migrations?|backup|backups|maintenance|api|android|ios)(?:\/|$)|(?:^|\/)[^/]*(?:local-mode|backup|restore|import|export|sync|storage|persist|schema|migrat|media-store|media-ingest|media-owed|remote|guest|seed|auth|password|passkey|push|service.?worker)[^/]*(?:\/|$)/i
const SENSITIVE_UI = /(?:^|\/)(?:Settings|settings[^/]*|Login|Admin[^/]*|MobileOnboarding|Coach[^/]*|SyncBanner|PasswordAuth|Connect[^/]*|Account[^/]*)(?:\.|\/|$)/i
const DEPENDENCY_PATH = /(?:^|\/)(?:package(?:-lock)?\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|deno(?:\.lock|\.jsonc?)|\.npmrc|\.yarnrc(?:\.yml)?)$/i

// Check removed lines and context too: deleting a safety condition must also stop.
// False positives intentionally require review instead of weakening this gate.
const SENSITIVE_PATCH = [
  ['storage-api', /\b(?:localStorage|sessionStorage|indexedDB|IDB\w*|openDB|Dexie|localforage|gym_state_v1|caches|CacheStorage|StorageManager)\b/i],
  ['network-api', /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|apiUpload|apiBlob|pairRedeem|axios|superagent|navigator)\b|\bapi\s*\(|["'][^"'\n]*(?:\/api|\/remote|\/mobile|\/sync-[\w-]+)(?:\.js)?["']/i],
  ['local-mode', /\b(?:VITE_LOCAL|LOCAL_ONLY|LOCAL_CONFIG|serverBase|followSignIn|allow_guest|nativeSave|nativeLoad)\b/],
  // Store actions can persist data without spelling a browser storage API. Also stop a
  // changed mutation line whose useStore/update binding is outside the diff's context.
  ['persistent-store', /\b(?:useStore|getState)\b|\bupdate\s*(?:\?\.)?\s*\(/],
  ['record-write', /\.\s*(?:workouts|routines|bodyweight|measurements|customMeasurements|customEx|exWeights|dayPlan|dayNotes|active)\s*(?:=(?!=)|\.\s*(?:length\s*=(?!=)|(?:push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin)\s*\())|\bdelete\s+[\w$]+\s*(?:\.|\[)|\bObject\s*\.\s*(?:assign|defineProperty|defineProperties)\s*\(/],
  ['data-mutation', /\b(?:setState|setItem|removeItem|deleteDatabase|deleteObjectStore|clearStorage|clearData|resetData|resetState|persist|hydrate|rehydrate|migrate|migration|backup|restore|pushState|pullState)\b/i],
  ['destructive-call', /\b(?:reset|clear|remove|delete|erase|wipe|migrat|backup|restore|importData|exportData|sync)[\w$]*\s*\(/i],
  ['persistent-format', /\b(?:STATE_KEY|STATE_VERSION|DB_NAME|DB_VERSION|STORAGE_KEY|schemaVersion|databaseVersion|objectStore|onupgradeneeded)\b/i],
  ['registration-or-origin', /\b(?:serviceWorker|registerSW|importScripts)\b|\b(?:window|document|globalThis)\s*(?:\.\s*(?:location|cookie)|\[)|\blocation\s*\./i],
  ['dynamic-code', /\beval\s*\(|\bFunction\s*\(|\bimport\s*\(|\brequire\s*\(|\b(?:exec|spawn)\s*\(|\\(?:u[0-9a-f]{4}|x[0-9a-f]{2})/i],
  ['external-content', /https?:\/\/|(?:src|href)\s*=\s*["']\/\/|<\s*(?:script|iframe|form|object|embed)\b|\bdangerouslySetInnerHTML\b/i],
]

function canonicalPath(path) {
  return typeof path === 'string' && path.length > 0 &&
    /^[A-Za-z0-9_@+./-]+$/.test(path) && !path.startsWith('/') &&
    path.split('/').every(part => part && part !== '.' && part !== '..')
}

function classify(path) {
  if (/(?:^|\/)(?:LICENSE|NOTICE)(?:\.|$)/i.test(path)) return 'license-or-attribution'
  if (TEST_PATH.test(path)) return 'test-or-fixture'
  if (DEPENDENCY_PATH.test(path)) return 'dependencies'
  if (path.startsWith('.github/') || path.startsWith('scripts/') ||
      path.startsWith('frontend/scripts/') || path.startsWith('frontend/public/') ||
      path.startsWith('frontend/android/') || path.startsWith('frontend/ios/') ||
      /^frontend\/(?:index\.html|vite[^/]*|vitest[^/]*|capacitor[^/]*)$/i.test(path) ||
      /^frontend\/src\/(?:App|main|index|registerSW|sw)\.(?:[jt]sx?)$/i.test(path)) return 'runtime-or-delivery'
  if (PROTECTED_PATH.test(path) || SENSITIVE_UI.test(path)) return 'data-or-local-mode'
  if (/^(?:README(?:\.[\w-]+)?\.md|CHANGELOG\.md|docs\/[\w./-]+\.md)$/.test(path)) return 'documentation'
  if (/^catalogue\/(?:browse\/[\w./-]+\.md|i18n\/[\w-]+\.json)$/.test(path)) return 'data-text'
  if (/^catalogue\/media\/(?:still|clip)\/[\w./-]+\.(?:png|jpe?g|webp|gif|avif)$/i.test(path)) return 'media'
  if (/^frontend\/src\/(?:locales|instr)\/[\w-]+\.js$/.test(path)) return 'code'
  if (/^frontend\/src\/(?:views|components)\/[\w./-]+\.(?:jsx|css)$/.test(path) ||
      /^frontend\/src\/[\w-]+\.css$/.test(path)) return 'code'
  const helper = /^frontend\/src\/lib\/([\w-]+)\.js$/.exec(path)
  if (helper && PURE_HELPERS.has(helper[1])) return 'code'
  return 'unknown-path'
}

/** Parse `git diff --name-status -z`; never parse Git's quoted, line-based display. */
export function parseNameStatus(output) {
  if (typeof output !== 'string') throw new TypeError('Expected NUL-delimited Git output')
  if (!output) return []
  if (!output.endsWith('\0')) throw new Error('Truncated name-status output')
  const fields = output.slice(0, -1).split('\0')
  const changes = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i++]
    if (!/^(?:[AMDUTXB]|[RC]\d{1,3})$/.test(status)) throw new Error('Invalid Git status')
    const first = fields[i++]
    if (first === undefined) throw new Error('Missing Git path')
    if (/^[RC]/.test(status)) {
      const path = fields[i++]
      if (path === undefined) throw new Error('Missing Git rename/copy destination')
      changes.push({ status, oldPath: first, path })
    } else {
      changes.push({ status, path: first })
    }
  }
  return changes
}

/**
 * @param {Array<{status: string, path: string, oldPath?: string, mode: string,
 *   oldMode?: string, patch?: string}>} changes Full changes from one Git comparison.
 * @returns {{allowed: boolean, reasons: Array<{path: string, code: string, message: string}>}}
 * A/M require the candidate tree mode `100644`; all structural changes need review.
 * Passing means eligible for the independent test/build/browser gates, not safe to deploy.
 */
export function evaluateUpdate(changes) {
  const reasons = []
  const deny = (path, code, message) => reasons.push({ path, code, message })
  if (!Array.isArray(changes)) {
    deny('', 'invalid-input', 'Expected an array of complete Git changes')
    return { allowed: false, reasons }
  }
  const seen = new Set()
  for (const change of changes) {
    const path = typeof change?.path === 'string' ? change.path : ''
    if (!change || !canonicalPath(path) || (change.oldPath !== undefined && !canonicalPath(change.oldPath))) {
      deny(path, 'invalid-path', 'Path is not a canonical repository-relative ASCII path')
      continue
    }
    if (seen.has(path)) {
      deny(path, 'duplicate-path', 'Duplicate change paths require review')
      continue
    }
    seen.add(path)
    if (!['A', 'M'].includes(change.status) || change.oldPath !== undefined) {
      deny(path, 'structural-change', 'Deletion, rename, copy, conflict or type change requires review')
      continue
    }
    if (change.mode !== '100644' || (change.oldMode !== undefined && change.oldMode !== '100644')) {
      deny(path, 'file-mode', 'Only known regular, non-executable files can update automatically')
      continue
    }
    const kind = classify(path)
    if (!['documentation', 'data-text', 'media', 'code'].includes(kind)) {
      deny(path, kind, 'Protected or unclassified files require manual compatibility review')
      continue
    }
    if (kind === 'media') continue
    if (typeof change.patch !== 'string' || !/^@@ /m.test(change.patch) ||
        /^(?:GIT binary patch|Binary files )/m.test(change.patch)) {
      deny(path, 'missing-patch', 'A complete, textual Git patch is required')
      continue
    }
    if (kind !== 'code') continue
    for (const [code, pattern] of SENSITIVE_PATCH) {
      if (pattern.test(change.patch)) {
        deny(path, code, 'Changed code or surrounding context touches a sensitive capability')
        break
      }
    }
  }
  return { allowed: reasons.length === 0, reasons }
}
