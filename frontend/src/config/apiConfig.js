function sanitizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '')
}

export const BASE_URL = sanitizeBaseUrl(import.meta.env.VITE_API_BASE || 'http://127.0.0.1:5001')

export const API_CONNECTION_ERROR_MESSAGE = 'Unable to connect to server. Please try again later.'

if (!BASE_URL && typeof console !== 'undefined') {
  console.warn('VITE_API_BASE is missing. Falling back to local API URL.')
}
