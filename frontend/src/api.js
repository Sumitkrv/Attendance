import { BASE_URL, API_CONNECTION_ERROR_MESSAGE } from './config/apiConfig'

function formatHostForUrl(hostname) {
  const value = String(hostname || '').trim()
  if (!value) return '127.0.0.1'
  if (value === '0.0.0.0' || value === '::' || value === '[::]') return '127.0.0.1'
  if (value.includes(':') && !value.startsWith('[')) return `[${value}]`
  return value
}

function normalizeApiBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '')
  const host = typeof window !== 'undefined' && window?.location?.hostname
    ? formatHostForUrl(window.location.hostname)
    : '127.0.0.1'

  if (!raw) return `http://${host}:5001`
  if (/^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw)
      if (!parsed.hostname || parsed.hostname === ':') return `http://${host}:5001`
      return raw
    } catch {
      return `http://${host}:5001`
    }
  }
  if (raw.startsWith(':')) return `http://${host}${raw}`
  if (/^\d+$/.test(raw)) return `http://${host}:${raw}`
  if (/^(localhost|127\.0\.0\.1|\d+\.\d+\.\d+\.\d+|\[[^\]]+\]|[a-z0-9.-]+):(\d+)$/i.test(raw)) return `http://${raw}`
  if (/^\//.test(raw)) return `http://${host}:5001`
  return raw
}

function getApiBaseUrl() {
  return normalizeApiBase(BASE_URL)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeApiError(message, details = {}) {
  const err = new Error(message)
  Object.assign(err, details)
  return err
}

function buildUnreachableServerMessage() {
  return API_CONNECTION_ERROR_MESSAGE
}

function readLatestStoredToken(path = '') {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return ''
    const normalizedPath = String(path || '').trim().toLowerCase()
    const userToken = localStorage.getItem('fa_user_token') || ''
    const adminToken = localStorage.getItem('fa_admin_token') || ''

    const looksLikeUserEndpoint = normalizedPath.startsWith('/user')
      || normalizedPath.startsWith('/tasks')
      || normalizedPath.startsWith('/scan_attendance')
      || normalizedPath.startsWith('/scan_challenge')
      || normalizedPath.startsWith('/manual_attendance_request')
      || normalizedPath.startsWith('/auth/refresh_user')

    if (looksLikeUserEndpoint) return userToken || adminToken || ''
    return adminToken || userToken || ''
  } catch {
    return ''
  }
}

const MAX_CONCURRENT_REQUESTS = 5
let activeRequestsCount = 0
const requestQueue = []

function processRequestQueue() {
  if (activeRequestsCount >= MAX_CONCURRENT_REQUESTS || requestQueue.length === 0) return
  activeRequestsCount++
  const { run, resolve, reject } = requestQueue.shift()
  
  run()
    .then(resolve)
    .catch(reject)
    .finally(() => {
      activeRequestsCount--
      processRequestQueue()
    })
}

function enqueueApiRequest(run) {
  return new Promise((resolve, reject) => {
    requestQueue.push({ run, resolve, reject })
    processRequestQueue()
  })
}

export async function apiFetch(path, options = {}, token) {
  return enqueueApiRequest(async () => {
    const apiBaseUrl = getApiBaseUrl()
  if (!apiBaseUrl) {
    throw makeApiError(API_CONNECTION_ERROR_MESSAGE, {
      retryable: false,
      status: 0,
      code: 'api_base_missing',
    })
  }

  const timeoutMs = Number(options.timeoutMs || 15000)
  const retries = Number(options.retries ?? ((options.method || 'GET').toUpperCase() === 'GET' ? 1 : 0))
  const retryDelayMs = Number(options.retryDelayMs || 450)
  const endpoint = String(path || '').startsWith('/') ? String(path || '') : `/${path}`
  const effectiveToken = token || readLatestStoredToken(endpoint)
  const headers = {
    ...(options.headers || {}),
  }
  if (effectiveToken && !headers.Authorization) headers.Authorization = `Bearer ${effectiveToken}`

  const requestOptions = {
    mode: 'cors',
    ...options,
    headers,
  }
  if (typeof FormData !== 'undefined' && requestOptions.body instanceof FormData) {
    delete requestOptions.headers['Content-Type']
    delete requestOptions.headers['content-type']
  }
  delete requestOptions.retries
  delete requestOptions.retryDelayMs
  delete requestOptions.timeoutMs

  let lastErr
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    let response
    try {
      response = await fetch(`${apiBaseUrl}${endpoint}`, {
        ...requestOptions,
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timeout)
      const text = String(err?.message || '').toLowerCase()
      const aborted = err?.name === 'AbortError'
      const retryable = aborted || text.includes('failed to fetch') || text.includes('networkerror')
      lastErr = makeApiError(
        aborted
          ? 'Request timed out. Please retry.'
          : buildUnreachableServerMessage(),
        {
          retryable,
          status: 0,
          code: aborted ? 'timeout' : 'network',
          attempt,
        },
      )
      if (attempt < retries && retryable) {
        await sleep(retryDelayMs * (attempt + 1))
        continue
      }
      throw lastErr
    }

    clearTimeout(timeout)

    const raw = await response.text()
    let data = {}
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch {
      data = { message: raw || 'Invalid server response' }
    }

    if (!response.ok) {
      // Retrying 429 immediately multiplies traffic and deepens rate-limit storms
      const retryable = response.status >= 500
      lastErr = makeApiError(
        data.message || `Request failed: ${response.status}`,
        {
          retryable,
          status: response.status,
          code: response.status,
          attempt,
          data,
        },
      )
      if (attempt < retries && retryable) {
        await sleep(retryDelayMs * (attempt + 1))
        continue
      }
      throw lastErr
    }

    return data
  }

  throw lastErr || makeApiError('Unknown API error', { retryable: false, status: 0, code: 'unknown' })
  })
}
