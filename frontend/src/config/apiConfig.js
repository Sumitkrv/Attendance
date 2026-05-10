function sanitizeBaseUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  if (!raw) return ''

  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (!parsed.hostname || parsed.hostname === ':') {
        const host = typeof window !== 'undefined' && window?.location?.hostname
          ? formatHostForUrl(window.location.hostname)
          : '127.0.0.1'
        return `http://${host}:5001`
      }
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.replace(/\/+$/, '')
    } catch {
      const host = typeof window !== 'undefined' && window?.location?.hostname
        ? formatHostForUrl(window.location.hostname)
        : '127.0.0.1'
      return `http://${host}:5001`
    }
  }

  if (raw.startsWith(':')) {
    const host = typeof window !== 'undefined' && window?.location?.hostname
      ? formatHostForUrl(window.location.hostname)
      : '127.0.0.1'
    return `http://${host}${raw}`
  }

  if (/^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|[a-z0-9.-]+):(\d+)$/i.test(raw)) {
    return `http://${raw}`
  }

  if (/^\d+$/.test(raw)) {
    const host = typeof window !== 'undefined' && window?.location?.hostname
      ? formatHostForUrl(window.location.hostname)
      : '127.0.0.1'
    return `http://${host}:${raw}`
  }

  return raw
}

const PROD_FALLBACK_API_BASE = 'https://attendance-production-bb51.up.railway.app'

function formatHostForUrl(hostname) {
  const value = String(hostname || '').trim()
  if (!value) return '127.0.0.1'
  if (value === '0.0.0.0' || value === '::' || value === '[::]') return '127.0.0.1'
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`
  return value
}

function getDevFallbackApiBase() {
  if (typeof window === 'undefined' || !window.location) {
    return 'http://127.0.0.1:5001'
  }

  return `http://${formatHostForUrl(window.location.hostname)}:5001`
}

const envBase = sanitizeBaseUrl(import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE)
const fallbackBase = import.meta.env.PROD ? PROD_FALLBACK_API_BASE : getDevFallbackApiBase()

export const BASE_URL = sanitizeBaseUrl(envBase || fallbackBase)

export const API_CONNECTION_ERROR_MESSAGE = 'Unable to connect to server. Please try again later.'

if (!BASE_URL && typeof console !== 'undefined') {
  console.warn('VITE_API_URL/VITE_API_BASE is missing. Falling back to default API URL.')
}
