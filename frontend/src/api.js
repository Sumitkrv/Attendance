export const API_BASE = import.meta.env.VITE_API_BASE || import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:5001'

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function makeApiError(message, details = {}) {
  const err = new Error(message)
  Object.assign(err, details)
  return err
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
  const timeoutMs = Number(options.timeoutMs || 15000)
  const retries = Number(options.retries ?? ((options.method || 'GET').toUpperCase() === 'GET' ? 1 : 0))
  const retryDelayMs = Number(options.retryDelayMs || 450)
  const effectiveToken = token || readLatestStoredToken()
  const headers = {
    'Cache-Control': 'no-cache',
    ...(options.headers || {}),
  }
  if (effectiveToken && !headers.Authorization) headers.Authorization = `Bearer ${effectiveToken}`

  const requestOptions = {
    ...options,
    headers,
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
      response = await fetch(`${API_BASE}${path}`, {
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
          : 'Unable to reach server. Please ensure backend is running on http://127.0.0.1:5001 and retry.',
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
