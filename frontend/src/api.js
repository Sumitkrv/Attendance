export const API_BASE = import.meta.env.VITE_API_BASE || import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:5001'

export async function apiFetch(path, options = {}, token) {
  const headers = {
    ...(options.headers || {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`

  let response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    })
  } catch (err) {
    const text = String(err?.message || '').toLowerCase()
    if (text.includes('failed to fetch') || text.includes('networkerror')) {
      throw new Error('Unable to reach server. Please ensure backend is running on http://127.0.0.1:5001 and retry.')
    }
    throw err
  }

  const raw = await response.text()
  let data = {}
  try {
    data = raw ? JSON.parse(raw) : {}
  } catch {
    data = { message: raw || 'Invalid server response' }
  }

  if (!response.ok) {
    throw new Error(data.message || `Request failed: ${response.status}`)
  }
  return data
}
