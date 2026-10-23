// Static hosting: each browser owns its records; there is no account or data server.
export const LOCAL_ONLY = import.meta.env.VITE_LOCAL === '1'
export const LOCAL_CONFIG = Object.freeze({ allow_guest: true, default_lang: 'zh', coach: { enabled: false } })
export const LOCAL_SOURCE = 'https://github.com/Wu-Zzz/opengym-local'
