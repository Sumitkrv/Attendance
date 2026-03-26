const FALLBACK_API_BASE = 'https://attendance-production-bb51.up.railway.app'

function sanitizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

const envApiBase = sanitizeBaseUrl(import.meta.env.VITE_API_BASE)
const fallbackApiBase = sanitizeBaseUrl(FALLBACK_API_BASE)
const candidateBase = envApiBase || fallbackApiBase

export const API_BASE = /^https:\/\//i.test(candidateBase) ? candidateBase : ''
export const API_CONNECTION_ERROR_MESSAGE = 'Unable to connect to server. Please try again later.'

if (!API_BASE && typeof console !== 'undefined') {
  console.warn('VITE_API_BASE is missing or not HTTPS. API requests are disabled.')
}
