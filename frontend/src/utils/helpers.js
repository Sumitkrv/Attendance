import { BASE_URL } from '../config/apiConfig'
import {
  APP_TIME_ZONE,
  ASSET_ALLOWED_EXTENSIONS,
  ASSET_MAX_FILE_SIZE_BYTES,
  AUTO_ABSENT_CUTOFF_HOUR,
  PASSWORD_MIN_LENGTH,
  TASK_SYNC_EVENT_KEY,
  TASK_SYNC_LOCAL_EVENT,
  UI_THEME_KEY,
  USER_ATTENDANCE_CACHE_KEY,
} from '../config/constants'

export function normalizeAttendancePolicyConfig(value = {}) {
  const shiftStartTime = String(value?.shiftStartTime || '09:00').match(/^\d{2}:\d{2}$/)
    ? String(value.shiftStartTime)
    : '09:00'
  const lateGraceMinutesRaw = Number(value?.lateGraceMinutes)
  const halfDayMinutesRaw = Number(value?.halfDayMinutes)
  const fullDayMinutesRaw = Number(value?.fullDayMinutes)
  const autoAbsentCutoffHourRaw = Number(value?.autoAbsentCutoffHour)

  return {
    shiftStartTime,
    lateGraceMinutes: Number.isFinite(lateGraceMinutesRaw) ? Math.max(0, Math.min(180, Math.round(lateGraceMinutesRaw))) : 15,
    halfDayMinutes: Number.isFinite(halfDayMinutesRaw) ? Math.max(60, Math.min(720, Math.round(halfDayMinutesRaw))) : 240,
    fullDayMinutes: Number.isFinite(fullDayMinutesRaw) ? Math.max(120, Math.min(900, Math.round(fullDayMinutesRaw))) : 480,
    autoAbsentCutoffHour: Number.isFinite(autoAbsentCutoffHourRaw)
      ? Math.max(0, Math.min(23, Math.round(autoAbsentCutoffHourRaw)))
      : AUTO_ABSENT_CUTOFF_HOUR,
    weekendWorkAllowed: !!value?.weekendWorkAllowed,
  }
}

export function fileExtensionOf(name = '') {
  const text = String(name || '').trim().toLowerCase()
  const idx = text.lastIndexOf('.')
  if (idx <= 0 || idx === text.length - 1) return ''
  return text.slice(idx)
}

export function splitFileName(name = '') {
  const text = String(name || '').trim()
  const idx = text.lastIndexOf('.')
  if (idx <= 0 || idx === text.length - 1) return { stem: text || 'file', ext: '' }
  return {
    stem: text.slice(0, idx) || 'file',
    ext: text.slice(idx),
  }
}

export function nextUniqueAssetName(name = '', usedNames = new Set()) {
  const safeName = String(name || 'file').trim() || 'file'
  if (!usedNames.has(safeName.toLowerCase())) {
    return safeName
  }
  const { stem, ext } = splitFileName(safeName)
  let i = 1
  while (i < 10000) {
    const candidate = `${stem}(${i})${ext}`
    if (!usedNames.has(candidate.toLowerCase())) return candidate
    i += 1
  }
  return `${stem}-${Math.random().toString(36).slice(2, 8)}${ext}`
}

export function validateAssetFile(file) {
  const name = String(file?.name || '').trim()
  const ext = fileExtensionOf(name)
  if (!ASSET_ALLOWED_EXTENSIONS.includes(ext)) {
    return 'Unsupported file format'
  }
  const size = Number(file?.size || 0)
  if (size <= 0) {
    return 'File is empty'
  }
  if (size > ASSET_MAX_FILE_SIZE_BYTES) {
    return 'File too large'
  }
  return ''
}

export function uploadEmployeeAssetWithProgress({ employeeId, file, token, onProgress }) {
  return new Promise((resolve, reject) => {
    const endpoint = `${String(BASE_URL || '').replace(/\/+$/, '')}/api/assets`
    const xhr = new XMLHttpRequest()
    xhr.open('POST', endpoint, true)
    xhr.timeout = 45000
    if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`)

    xhr.upload.onprogress = (event) => {
      if (!event?.lengthComputable) return
      const percent = Math.max(0, Math.min(100, Math.round((event.loaded / Math.max(1, event.total)) * 100)))
      if (typeof onProgress === 'function') onProgress(percent)
    }

    xhr.onerror = () => reject(new Error('Upload failed. Try again'))
    xhr.ontimeout = () => reject(new Error('Upload failed. Try again'))
    xhr.onload = () => {
      let data = {}
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {}
      } catch {
        data = {}
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data)
        return
      }
      reject(new Error(data?.message || 'Upload failed. Try again'))
    }

    const formData = new FormData()
    formData.append('employeeId', employeeId)
    formData.append('file', file)
    xhr.send(formData)
  })
}

export function validatePasswordInput(password, label = 'Password') {
  const text = String(password || '')
  if (text.length < PASSWORD_MIN_LENGTH) {
    return `${label} must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (!/\d/.test(text)) {
    return `${label} must include at least one number`
  }
  return ''
}

export function createTaskBlock(id = Date.now()) {
  return { id, title: '', description: '' }
}

export function publishTaskSync(source = 'unknown') {
  const payload = {
    source,
    at: Date.now(),
    rand: Math.random().toString(36).slice(2),
  }
  try {
    localStorage.setItem(TASK_SYNC_EVENT_KEY, JSON.stringify(payload))
  } catch {
    // no-op
  }
  try {
    window.dispatchEvent(new CustomEvent(TASK_SYNC_LOCAL_EVENT, { detail: payload }))
  } catch {
    // no-op
  }
}

export function readDarkModePreference() {
  try {
    return localStorage.getItem(UI_THEME_KEY) === 'dark'
  } catch {
    return false
  }
}

export function applyThemePreference(isDark) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark-mode', !!isDark)
}

export function readAttendanceCache(token) {
  try {
    const claims = decodeToken(token || '') || {}
    const loginId = String(claims.login_id || '').toLowerCase()
    if (!loginId) return { status: '', checkIn: '', checkOut: '' }
    const all = JSON.parse(localStorage.getItem(USER_ATTENDANCE_CACHE_KEY) || '{}')
    const row = all?.[loginId] || {}
    return {
      status: String(row.status || '').toLowerCase(),
      checkIn: '',
      checkOut: '',
    }
  } catch {
    return { status: '', checkIn: '', checkOut: '' }
  }
}

export function writeAttendanceCache(token, payload = {}) {
  try {
    const claims = decodeToken(token || '') || {}
    const loginId = String(claims.login_id || '').toLowerCase()
    if (!loginId) return
    const all = JSON.parse(localStorage.getItem(USER_ATTENDANCE_CACHE_KEY) || '{}')
    all[loginId] = {
      status: String(payload.status || '').toLowerCase(),
      checkIn: payload.checkIn || '',
      checkOut: payload.checkOut || '',
      updatedAt: Date.now(),
    }
    localStorage.setItem(USER_ATTENDANCE_CACHE_KEY, JSON.stringify(all))
  } catch {
    // no-op
  }
}

export function formatDateInput(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const y = parts.find((p) => p.type === 'year')?.value
    const m = parts.find((p) => p.type === 'month')?.value
    const d = parts.find((p) => p.type === 'day')?.value
    if (y && m && d) return `${y}-${m}-${d}`
  } catch {
    // fallback below
  }
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** First calendar day (YYYY-MM-01) of the month containing `date`, in APP_TIME_ZONE. */
export function calendarMonthStartDateKey(date = new Date()) {
  const key = formatDateInput(date)
  const mx = String(key || '').match(/^(\d{4})-(\d{2})-\d{2}$/)
  if (!mx) return key
  return `${mx[1]}-${mx[2]}-01`
}

export function dateKeyOffsetFromToday(offsetDays = 0) {
  const n = Number(offsetDays || 0)
  const d = new Date(Date.now() + (n * 24 * 60 * 60 * 1000))
  return formatDateInput(d)
}

export function dateKeyShift(baseDateKey = '', offsetDays = 0) {
  const text = String(baseDateKey || '').trim()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return dateKeyOffsetFromToday(offsetDays)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setDate(d.getDate() + Number(offsetDays || 0))
  return formatDateInput(d)
}

export function formatWeekdayFromDateKey(dateKey = '') {
  const text = String(dateKey || '').trim()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return '-'
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  try {
    return new Intl.DateTimeFormat('en-IN', { weekday: 'short', timeZone: APP_TIME_ZONE }).format(d)
  } catch {
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] || '-'
  }
}

export function isWeekendDateKey(dateKey = '') {
  const text = String(dateKey || '').trim()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return false
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const day = d.getDay()
  return day === 0 || day === 6
}

export function listDateKeysInRange(fromDate = '', toDate = '') {
  const fromText = String(fromDate || '').trim()
  const toText = String(toDate || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromText) || !/^\d{4}-\d{2}-\d{2}$/.test(toText)) return []
  if (fromText > toText) return []

  const keys = []
  let cursor = fromText
  let guard = 0
  while (cursor <= toText && guard < 400) {
    keys.push(cursor)
    cursor = dateKeyShift(cursor, 1)
    guard += 1
  }
  return keys
}

export function formatTimeInIST(value) {
  if (!value) return '-'
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date(value))
  } catch {
    return '-'
  }
}

export function formatTimeAgo(value) {
  const ms = parseBackendDateMs(value)
  if (!Number.isFinite(ms)) return '-'
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec} sec ago`
  const min = Math.floor(diffSec / 60)
  if (min < 60) return `${min} min ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs} hr ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return '1 day ago'
  return `${days} days ago`
}

export function formatTime12Hour(value) {
  const text = String(value || '').trim()
  const match = text.match(/^(\d{1,2}):(\d{2})/)
  if (!match) return '-'
  const h = Number(match[1])
  const m = match[2]
  if (!Number.isFinite(h) || h < 0 || h > 23) return '-'
  const period = h >= 12 ? 'PM' : 'AM'
  const hour12 = h % 12 || 12
  return `${hour12}:${m} ${period}`
}

export function formatMinutesAs12Hour(totalMinutes) {
  const minutes = Number(totalMinutes)
  if (!Number.isFinite(minutes)) return '-'
  const normalized = ((Math.round(minutes) % (24 * 60)) + (24 * 60)) % (24 * 60)
  const hh = String(Math.floor(normalized / 60)).padStart(2, '0')
  const mm = String(normalized % 60).padStart(2, '0')
  return formatTime12Hour(`${hh}:${mm}`)
}

export function formatBytes(value) {
  const size = Number(value || 0)
  if (!Number.isFinite(size) || size <= 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 * 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function assetTypeLabel(value = '') {
  const key = String(value || '').trim().toLowerCase()
  if (key === 'image') return 'Image'
  if (key === 'video') return 'Video'
  return 'Document'
}

export function assetTypeClass(value = '') {
  const key = String(value || '').trim().toLowerCase()
  if (key === 'image') return 'image'
  if (key === 'video') return 'video'
  return 'document'
}

export function formatAssetUploadDate(value) {
  const ms = parseBackendDateMs(value)
  if (!Number.isFinite(ms)) return '-'
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(new Date(ms))
  } catch {
    return String(value || '').slice(0, 10) || '-'
  }
}

export function parseBackendDateMs(value) {
  const text = String(value || '').trim()
  if (!text) return NaN
  const parsed = new Date(text).getTime()
  if (Number.isFinite(parsed)) return parsed
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/)
  if (!m) return NaN
  const ms = String(m[7] || '0').slice(0, 3).padEnd(3, '0')
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    Number(m[6]),
    Number(ms),
  ).getTime()
}

export function dateKeyInIST(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const ms = parseBackendDateMs(text)
  if (!Number.isFinite(ms)) return text.slice(0, 10)
  return formatDateInput(new Date(ms))
}

export function formatAttendanceTimeFromUtc(utcIso, fallback = '', dateHint = '') {
  const iso = String(utcIso || '').trim()
  const legacy = String(fallback || '').trim()
  const date = String(dateHint || '').trim()
  const sourceIso = iso || (/^\d{4}-\d{2}-\d{2}$/.test(date) && /^\d{2}:\d{2}:\d{2}$/.test(legacy) ? `${date}T${legacy}Z` : '')
  if (!sourceIso) return legacy
  try {
    return new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIME_ZONE,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(sourceIso))
  } catch {
    return legacy
  }
}

export function normalizeAttendanceRow(row = {}) {
  const timingStatusRaw = String(
    row?.timing_status || row?.attendance_status?.status || row?.exit_status || row?.entry_status || '',
  ).trim()
  return {
    ...row,
    timing_status: timingStatusRaw,
    check_in: formatAttendanceTimeFromUtc(row?.check_in_at, row?.check_in, row?.date),
    check_out: formatAttendanceTimeFromUtc(row?.check_out_at, row?.check_out, row?.date),
  }
}

export function getTaskReferenceMs(task = {}) {
  const candidates = [
    task?.approved_at,
    task?.completed_at,
    task?.updated_at,
    task?.start_date,
    task?.created_at,
    task?.deadline,
  ]
  for (const value of candidates) {
    const ms = parseBackendDateMs(value)
    if (Number.isFinite(ms)) return ms
  }
  return NaN
}

export function isTaskWithinLastDays(task = {}, days = 30) {
  const refMs = getTaskReferenceMs(task)
  if (!Number.isFinite(refMs)) return false
  const rangeMs = Math.max(1, Number(days || 30)) * 24 * 60 * 60 * 1000
  return refMs >= (Date.now() - rangeMs)
}

export function decodeToken(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch {
    return null
  }
}

export function tokenRemainingMs(token) {
  const payload = decodeToken(token || '')
  const expSec = Number(payload?.exp || 0)
  if (!Number.isFinite(expSec) || expSec <= 0) return 0
  return Math.max(0, (expSec * 1000) - Date.now())
}

export function readValidToken(storageKey, expectedRole, options = {}) {
  const { allowExpired = false } = options || {}
  try {
    const token = localStorage.getItem(storageKey) || ''
    if (!token) return ''
    const payload = decodeToken(token)
    if (!payload) {
      localStorage.removeItem(storageKey)
      return ''
    }
    if (String(payload.role || '').toLowerCase() !== String(expectedRole || '').toLowerCase()) {
      localStorage.removeItem(storageKey)
      return ''
    }
    if (!allowExpired && tokenRemainingMs(token) <= 0) {
      localStorage.removeItem(storageKey)
      return ''
    }
    return token
  } catch {
    return ''
  }
}

export function isRetryableError(err) {
  const text = String(err?.message || '').toLowerCase()
  return !!err?.retryable
    || text.includes('temporarily unavailable')
    || text.includes('try again')
    || text.includes('unable to connect to server')
    || text.includes('timed out')
    || text.includes('network')
}
