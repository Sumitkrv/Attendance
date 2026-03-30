function sanitizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

const PROD_FALLBACK_API_BASE = 'https://attendance-production-bb51.up.railway.app'
const DEV_FALLBACK_API_BASE = 'http://127.0.0.1:5001'

const envBase = sanitizeBaseUrl(import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE)
const fallbackBase = import.meta.env.PROD ? PROD_FALLBACK_API_BASE : DEV_FALLBACK_API_BASE

export const BASE_URL = sanitizeBaseUrl(envBase || fallbackBase)

export const API_CONNECTION_ERROR_MESSAGE = 'Unable to connect to server. Please try again later.'

if (!BASE_URL && typeof console !== 'undefined') {
  console.warn('VITE_API_URL/VITE_API_BASE is missing. Falling back to default API URL.')
}
