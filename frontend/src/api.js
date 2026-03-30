import { BASE_URL, API_CONNECTION_ERROR_MESSAGE } from './config/apiConfig'

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

function readLatestStoredToken() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return ''
    return localStorage.getItem('fa_user_token') || localStorage.getItem('fa_admin_token') || ''
  } catch {
    return ''
  }
}

export async function apiFetch(path, options = {}, token) {
  if (!BASE_URL) {
    throw makeApiError(API_CONNECTION_ERROR_MESSAGE, {
      retryable: false,
      status: 0,
      code: 'api_base_missing',
    })
  }

  const timeoutMs = Number(options.timeoutMs || 15000)
  const retries = Number(options.retries ?? ((options.method || 'GET').toUpperCase() === 'GET' ? 1 : 0))
  const retryDelayMs = Number(options.retryDelayMs || 450)
  const effectiveToken = token || readLatestStoredToken()
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
      const endpoint = String(path || '').startsWith('/') ? path : `/${path}`
      response = await fetch(`${BASE_URL}${endpoint}`, {
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
      const retryable = response.status === 429 || response.status >= 500
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
}
