import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { apiFetch } from './api'

const ADMIN_KEY = 'fa_admin_token'
const USER_KEY = 'fa_user_token'
const USER_ATTENDANCE_CACHE_KEY = 'fa_user_attendance_cache'
const UI_THEME_KEY = 'fa_ui_theme'
const SESSION_REFRESH_CHECK_MS = 60 * 1000
const SESSION_REFRESH_BEFORE_MS = 15 * 60 * 1000
const SESSION_EXPIRING_SOON_MS = 5 * 60 * 1000

function readDarkModePreference() {
  try {
    return localStorage.getItem(UI_THEME_KEY) === 'dark'
  } catch {
    return false
  }
}

function applyThemePreference(isDark) {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('dark-mode', !!isDark)
}

function readAttendanceCache(token) {
  try {
    const claims = decodeToken(token || '') || {}
    const loginId = String(claims.login_id || '').toLowerCase()
    if (!loginId) return { status: '', checkIn: '', checkOut: '' }
    const all = JSON.parse(localStorage.getItem(USER_ATTENDANCE_CACHE_KEY) || '{}')
    const row = all?.[loginId] || {}
    return {
      status: String(row.status || '').toLowerCase(),
      checkIn: row.checkIn || '',
      checkOut: row.checkOut || '',
    }
  } catch {
    return { status: '', checkIn: '', checkOut: '' }
  }
}

function writeAttendanceCache(token, payload = {}) {
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

function formatDateInput(date = new Date()) {
  const y = date.getFullYear()
  const m = `${date.getMonth() + 1}`.padStart(2, '0')
  const d = `${date.getDate()}`.padStart(2, '0')
  return `${y}-${m}-${d}`
}

function decodeToken(token) {
  try {
    return JSON.parse(atob(token.split('.')[1]))
  } catch {
    return null
  }
}

function tokenRemainingMs(token) {
  const payload = decodeToken(token || '')
  const expSec = Number(payload?.exp || 0)
  if (!Number.isFinite(expSec) || expSec <= 0) return 0
  return Math.max(0, (expSec * 1000) - Date.now())
}

function readValidToken(storageKey, expectedRole) {
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
    if (tokenRemainingMs(token) <= 0) {
      localStorage.removeItem(storageKey)
      return ''
    }
    return token
  } catch {
    return ''
  }
}

function isRetryableError(err) {
  const text = String(err?.message || '').toLowerCase()
  return !!err?.retryable
    || text.includes('temporarily unavailable')
    || text.includes('try again')
    || text.includes('unable to reach server')
    || text.includes('timed out')
    || text.includes('network')
}

function LoginCard({ title, fields, onSubmit, message }) {
  const [loading, setLoading] = useState(false)
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, f.defaultValue || ''])))

  async function submit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      await onSubmit(values)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card auth-card">
      <h2>{title}</h2>
      <form onSubmit={submit} className="stack">
        {fields.map((field) => (
          <input
            key={field.name}
            type={field.type || 'text'}
            placeholder={field.placeholder}
            value={values[field.name]}
            onChange={(e) => setValues((old) => ({ ...old, [field.name]: e.target.value }))}
            autoComplete={field.autoComplete}
            required
          />
        ))}
        <button disabled={loading}>{loading ? 'Please wait...' : 'Login'}</button>
      </form>
      <p className="muted">{message}</p>
    </div>
  )
}

function AdminPage() {
  const navigate = useNavigate()
  const ENROLLMENT_IMAGE_COUNT = 10
  const [darkMode, setDarkMode] = useState(readDarkModePreference)
  const [token, setToken] = useState(() => readValidToken(ADMIN_KEY, 'admin'))
  const [sessionRefreshedAt, setSessionRefreshedAt] = useState(null)
  const [sessionExpiringSoon, setSessionExpiringSoon] = useState('')
  const [username, setUsername] = useState('admin')
  const [error, setError] = useState('')
  const [retryLabel, setRetryLabel] = useState('')
  const [retryAction, setRetryAction] = useState(null)
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)
  const [date, setDate] = useState(formatDateInput())
  const [employees, setEmployees] = useState([])
  const [attendance, setAttendance] = useState([])
  const [manualRequests, setManualRequests] = useState([])
  const [manualStatusFilter, setManualStatusFilter] = useState('pending')
  const [directorySearch, setDirectorySearch] = useState('')
  const [directoryDeptFilter, setDirectoryDeptFilter] = useState('all')
  const [directorySort, setDirectorySort] = useState({ key: 'name', direction: 'asc' })
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState([])
  const [logsSearch, setLogsSearch] = useState('')
  const [logsStatusFilter, setLogsStatusFilter] = useState('all')
  const [logsSort, setLogsSort] = useState({ key: 'employee_name', direction: 'asc' })
  const [liveTrackingOn] = useState(true)
  const [requestsSearch, setRequestsSearch] = useState('')
  const [requestsDateFilter, setRequestsDateFilter] = useState('all')
  const [selectedRequestIds, setSelectedRequestIds] = useState([])
  const [view, setView] = useState('overview')
  const [newEmp, setNewEmp] = useState({ name: '', login_id: '', department: 'General', password: '' })
  const [recognition, setRecognition] = useState(null)
  const [recognitionInitial, setRecognitionInitial] = useState(null)
  const [geofence, setGeofence] = useState(null)
  const [geofenceInitial, setGeofenceInitial] = useState(null)
  const [cameraStatus, setCameraStatus] = useState(null)
  const [trainStatus, setTrainStatus] = useState(null)
  const [settingsFeedback, setSettingsFeedback] = useState({ type: '', text: '' })
  const [settingsLastUpdated, setSettingsLastUpdated] = useState(null)
  const [recognitionSaving, setRecognitionSaving] = useState(false)
  const [geofenceSaving, setGeofenceSaving] = useState(false)
  const [recognitionTesting, setRecognitionTesting] = useState(false)
  const [geofenceTesting, setGeofenceTesting] = useState(false)
  const [geofenceFetching, setGeofenceFetching] = useState(false)
  const [recognitionTestResult, setRecognitionTestResult] = useState({ type: '', text: '' })
  const [geofenceTestResult, setGeofenceTestResult] = useState({ type: '', text: '' })
  const [confirmModal, setConfirmModal] = useState({
    open: false,
    title: 'Are you sure?',
    message: '',
    confirmText: 'Confirm',
    onConfirm: null,
  })
  const [confirmSubmitting, setConfirmSubmitting] = useState(false)
  const [requestDetailsModal, setRequestDetailsModal] = useState({ open: false, request: null })
  const [rejectReasonModal, setRejectReasonModal] = useState({
    open: false,
    requestId: '',
    reason: 'Rejected by admin',
    saving: false,
  })
  const [editEmployeeModal, setEditEmployeeModal] = useState({
    open: false,
    row: null,
    name: '',
    loginId: '',
    department: 'General',
    saving: false,
  })
  const [resetPasswordModal, setResetPasswordModal] = useState({
    open: false,
    employeeId: '',
    employeeName: '',
    password: '',
    saving: false,
  })
  const [tableActionBusy, setTableActionBusy] = useState({})
  const [enrollmentCameraOn, setEnrollmentCameraOn] = useState(false)
  const [enrollmentCapturing, setEnrollmentCapturing] = useState(false)
  const [enrollmentProgress, setEnrollmentProgress] = useState(0)
  const [addEmployeeFeedback, setAddEmployeeFeedback] = useState({ type: '', text: '' })
  const enrollmentVideoRef = useRef(null)
  const enrollmentCanvasRef = useRef(null)
  const enrollmentStreamRef = useRef(null)
  const adminRefreshInFlightRef = useRef(false)

  function clearRetryAction() {
    setRetryAction(null)
    setRetryLabel('')
  }

  const counts = useMemo(() => {
    const checkedOut = attendance.filter((a) => !!a.check_out).length
    const checkedInOnly = attendance.filter((a) => !a.check_out).length
    return {
      total: attendance.length,
      checkedOut,
      checkedInOnly,
    }
  }, [attendance])

  const alerts = useMemo(() => {
    const pendingRequests = manualRequests.filter((r) => String(r.status || '').toLowerCase() === 'pending').length
    const outsideGeofenceCount = manualRequests.filter((r) => {
      const reqType = String(r.request_type || '').toLowerCase()
      const reason = String(r.reason || '').toLowerCase()
      return reqType === 'outside_office' || reason.includes('outside geofence') || reason.includes('outside office')
    }).length

    const geofenceDataAvailable = manualRequests.length > 0
    const cameraDataAvailable = typeof cameraStatus?.running === 'boolean'

    return {
      pendingRequests,
      outsideGeofenceCount,
      geofenceDataAvailable,
      cameraDataAvailable,
      cameraInactive: cameraStatus?.running === false,
    }
  }, [manualRequests, cameraStatus])

  const directoryDepartments = useMemo(() => {
    const set = new Set((employees || []).map((e) => (e.department || 'General').trim() || 'General'))
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [employees])

  const filteredEmployees = useMemo(() => {
    const q = directorySearch.trim().toLowerCase()
    const filtered = (employees || []).filter((e) => {
      const byDept = directoryDeptFilter === 'all' || (e.department || 'General') === directoryDeptFilter
      if (!byDept) return false
      if (!q) return true
      return [e.name, e.login_id, e.department].some((v) => String(v || '').toLowerCase().includes(q))
    })

    if (!directorySort?.key) return filtered

    const sorted = [...filtered].sort((a, b) => {
      const av = String(a?.[directorySort.key] || '').toLowerCase()
      const bv = String(b?.[directorySort.key] || '').toLowerCase()
      if (av < bv) return directorySort.direction === 'asc' ? -1 : 1
      if (av > bv) return directorySort.direction === 'asc' ? 1 : -1
      return 0
    })

    return sorted
  }, [employees, directorySearch, directoryDeptFilter, directorySort])

  function toggleDirectorySort(key) {
    setDirectorySort((old) => {
      if (old.key === key) {
        return { key, direction: old.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key, direction: 'asc' }
    })
  }

  function exportAttendanceCsv() {
    const rows = Array.isArray(filteredAttendance) ? filteredAttendance : []
    if (!rows.length) {
      setError('No attendance logs to export for selected filters')
      return
    }

    const headers = ['Name', 'Check In', 'Check Out', 'Status', 'Mode']
    const escapeCsv = (value) => {
      const text = String(value ?? '')
      if (/[",\n]/.test(text)) {
        return `"${text.replace(/"/g, '""')}"`
      }
      return text
    }

    const lines = [
      headers.join(','),
      ...rows.map((a) => [
        a.employee_name || '',
        a.check_in || '',
        a.check_out || '',
        a.status || '',
        a.manual_entry ? 'manual' : 'auto',
      ].map(escapeCsv).join(',')),
    ]

    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `attendance_logs_${date || formatDateInput()}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    flash('Attendance CSV exported')
  }

  const visibleEmployeeIds = useMemo(() => filteredEmployees.map((e) => e.id), [filteredEmployees])
  const selectedVisibleCount = useMemo(
    () => visibleEmployeeIds.filter((id) => selectedEmployeeIds.includes(id)).length,
    [visibleEmployeeIds, selectedEmployeeIds],
  )
  const allVisibleSelected = visibleEmployeeIds.length > 0 && selectedVisibleCount === visibleEmployeeIds.length

  useEffect(() => {
    const visibleSet = new Set(visibleEmployeeIds)
    setSelectedEmployeeIds((old) => old.filter((id) => visibleSet.has(id)))
  }, [visibleEmployeeIds])

  function toggleEmployeeSelection(employeeId) {
    setSelectedEmployeeIds((old) => (old.includes(employeeId) ? old.filter((id) => id !== employeeId) : [...old, employeeId]))
  }

  function toggleSelectAllVisible() {
    setSelectedEmployeeIds((old) => {
      if (allVisibleSelected) {
        return old.filter((id) => !visibleEmployeeIds.includes(id))
      }
      const set = new Set(old)
      visibleEmployeeIds.forEach((id) => set.add(id))
      return Array.from(set)
    })
  }

  async function deleteSelectedEmployees() {
    const ids = [...selectedEmployeeIds]
    if (!ids.length) return
    setConfirmModal({
      open: true,
      title: 'Are you sure?',
      message: 'Are you sure you want to delete selected employees?',
      confirmText: 'Delete',
      onConfirm: async () => {
        try {
          await Promise.all(ids.map((id) => apiFetch(`/employees/${id}`, { method: 'DELETE' }, token)))
          setSelectedEmployeeIds([])
          flash(`${ids.length} employee(s) deleted`)
          await loadAll()
        } catch (err) {
          setError(err.message)
        }
      },
    })
  }

  const filteredAttendance = useMemo(() => {
    const q = logsSearch.trim().toLowerCase()
    const filtered = (attendance || []).filter((a) => {
      const byStatus = logsStatusFilter === 'all' || String(a.status || '').toLowerCase() === logsStatusFilter
      if (!byStatus) return false
      if (!q) return true
      return [a.employee_name, a.status, a.check_in, a.check_out].some((v) => String(v || '').toLowerCase().includes(q))
    })

    const parseTimeToMinutes = (value) => {
      const str = String(value || '').trim()
      const m = str.match(/(\d{1,2}):(\d{2})/)
      if (!m) return Number.POSITIVE_INFINITY
      const h = Number(m[1])
      const mm = Number(m[2])
      if (!Number.isFinite(h) || !Number.isFinite(mm)) return Number.POSITIVE_INFINITY
      return (h * 60) + mm
    }

    if (!logsSort?.key) return filtered

    const sorted = [...filtered].sort((a, b) => {
      let av
      let bv
      if (logsSort.key === 'employee_name') {
        av = String(a.employee_name || '').toLowerCase()
        bv = String(b.employee_name || '').toLowerCase()
      } else if (logsSort.key === 'check_in' || logsSort.key === 'check_out') {
        av = parseTimeToMinutes(a[logsSort.key])
        bv = parseTimeToMinutes(b[logsSort.key])
      } else {
        av = String(a?.[logsSort.key] || '').toLowerCase()
        bv = String(b?.[logsSort.key] || '').toLowerCase()
      }

      if (av < bv) return logsSort.direction === 'asc' ? -1 : 1
      if (av > bv) return logsSort.direction === 'asc' ? 1 : -1
      return 0
    })

    return sorted
  }, [attendance, logsSearch, logsStatusFilter, logsSort])

  function toggleLogsSort(key) {
    setLogsSort((old) => {
      if (old.key === key) {
        return { key, direction: old.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key, direction: 'asc' }
    })
  }

  const attendanceSummary = useMemo(() => {
    const rows = Array.isArray(attendance) ? attendance : []
    const hasAttendanceData = rows.length > 0
    const checkedIn = rows.filter((a) => String(a.status || '').toLowerCase() === 'checked_in').length
    const checkedOut = rows.filter((a) => String(a.status || '').toLowerCase() === 'checked_out').length
    const absent = rows.filter((a) => String(a.status || '').toLowerCase() === 'absent').length

    return {
      totalEmployees: Array.isArray(employees) && employees.length ? employees.length : null,
      checkedIn: hasAttendanceData ? checkedIn : null,
      checkedOut: hasAttendanceData ? checkedOut : null,
      absent: hasAttendanceData ? absent : null,
    }
  }, [attendance, employees])

  const requestDates = useMemo(() => {
    const set = new Set((manualRequests || []).map((r) => String(r.date || '').trim()).filter(Boolean))
    return Array.from(set).sort((a, b) => b.localeCompare(a))
  }, [manualRequests])

  const filteredManualRequests = useMemo(() => {
    const q = requestsSearch.trim().toLowerCase()
    return (manualRequests || []).filter((r) => {
      const byDate = requestsDateFilter === 'all' || String(r.date || '') === requestsDateFilter
      if (!byDate) return false
      if (!q) return true
      return [r.employee_name, r.reason, r.status, r.request_type, r.work_mode].some((v) => String(v || '').toLowerCase().includes(q))
    })
  }, [manualRequests, requestsSearch, requestsDateFilter])

  const visibleRequestIds = useMemo(() => filteredManualRequests.map((r) => r.id), [filteredManualRequests])
  const selectedVisibleRequestsCount = useMemo(
    () => visibleRequestIds.filter((id) => selectedRequestIds.includes(id)).length,
    [visibleRequestIds, selectedRequestIds],
  )
  const allVisibleRequestsSelected = visibleRequestIds.length > 0 && selectedVisibleRequestsCount === visibleRequestIds.length

  useEffect(() => {
    const visibleSet = new Set(visibleRequestIds)
    setSelectedRequestIds((old) => old.filter((id) => visibleSet.has(id)))
  }, [visibleRequestIds])

  function toggleRequestSelection(requestId) {
    setSelectedRequestIds((old) => (old.includes(requestId) ? old.filter((id) => id !== requestId) : [...old, requestId]))
  }

  function toggleSelectAllVisibleRequests() {
    setSelectedRequestIds((old) => {
      if (allVisibleRequestsSelected) {
        return old.filter((id) => !visibleRequestIds.includes(id))
      }
      const set = new Set(old)
      visibleRequestIds.forEach((id) => set.add(id))
      return Array.from(set)
    })
  }

  const requestsSummary = useMemo(() => {
    const rows = Array.isArray(manualRequests) ? manualRequests : []
    if (!rows.length) {
      return { total: null, pending: null, approved: null, rejected: null }
    }
    return {
      total: rows.length,
      pending: rows.filter((r) => String(r.status || '').toLowerCase() === 'pending').length,
      approved: rows.filter((r) => String(r.status || '').toLowerCase() === 'approved').length,
      rejected: rows.filter((r) => String(r.status || '').toLowerCase() === 'rejected').length,
    }
  }, [manualRequests])

  const addEmployeeStep = useMemo(() => {
    if (enrollmentCapturing) return 4
    if (enrollmentCameraOn) return 3
    if (newEmp.name && newEmp.login_id && newEmp.department && newEmp.password) return 2
    return 1
  }, [enrollmentCapturing, enrollmentCameraOn, newEmp])

  const isEnrollmentNameReady = useMemo(() => !!String(newEmp.name || '').trim(), [newEmp.name])
  const canSubmitEnrollment = isEnrollmentNameReady && enrollmentCameraOn && !enrollmentCapturing

  function toFiniteNumber(value) {
    if (value === '' || value == null) return NaN
    const n = Number(value)
    return Number.isFinite(n) ? n : NaN
  }

  function normalizeRecognitionSettings(value) {
    return {
      tolerance: Number(value?.tolerance),
      process_every_n_frames: Number(value?.process_every_n_frames),
      resize_scale: Number(value?.resize_scale),
    }
  }

  function normalizeGeofenceSettings(value) {
    return {
      enabled: !!value?.enabled,
      office_lat: Number(value?.office_lat),
      office_lng: Number(value?.office_lng),
      office_radius_meters: Number(value?.office_radius_meters),
    }
  }

  const recognitionErrors = useMemo(() => {
    const tolerance = toFiniteNumber(recognition?.tolerance)
    const processFrames = toFiniteNumber(recognition?.process_every_n_frames)
    const resizeScale = toFiniteNumber(recognition?.resize_scale)

    return {
      tolerance: Number.isNaN(tolerance)
        ? 'Tolerance is required'
        : (tolerance < 0.3 || tolerance > 0.7 ? 'Tolerance must be between 0.3 and 0.7' : ''),
      process_every_n_frames: Number.isNaN(processFrames)
        ? 'Process frames is required'
        : (processFrames <= 0 ? 'Process frames must be a positive number' : ''),
      resize_scale: Number.isNaN(resizeScale)
        ? 'Resize scale is required'
        : (resizeScale < 0.1 || resizeScale > 1 ? 'Resize scale must be between 0.1 and 1' : ''),
    }
  }, [recognition])

  const geofenceErrors = useMemo(() => {
    const lat = toFiniteNumber(geofence?.office_lat)
    const lng = toFiniteNumber(geofence?.office_lng)
    const radius = toFiniteNumber(geofence?.office_radius_meters)

    return {
      office_lat: Number.isNaN(lat)
        ? 'Latitude is required'
        : (lat < -90 || lat > 90 ? 'Latitude must be between -90 and 90' : ''),
      office_lng: Number.isNaN(lng)
        ? 'Longitude is required'
        : (lng < -180 || lng > 180 ? 'Longitude must be between -180 and 180' : ''),
      office_radius_meters: Number.isNaN(radius)
        ? 'Radius is required'
        : (radius < 50 || radius > 1000 ? 'Radius must be between 50 and 1000 meters' : ''),
    }
  }, [geofence])

  const recognitionWarnings = useMemo(() => {
    const tolerance = toFiniteNumber(recognition?.tolerance)
    return {
      tolerance: !Number.isNaN(tolerance) && tolerance < 0.3
        ? 'Low tolerance may cause false positives'
        : '',
    }
  }, [recognition])

  const geofenceWarnings = useMemo(() => {
    const radius = toFiniteNumber(geofence?.office_radius_meters)
    return {
      office_radius_meters: !Number.isNaN(radius) && radius > 800
        ? 'Large radius reduces location accuracy'
        : '',
    }
  }, [geofence])

  const recognitionHasChanges = useMemo(() => {
    if (!recognition || !recognitionInitial) return false
    return JSON.stringify(normalizeRecognitionSettings(recognition)) !== JSON.stringify(normalizeRecognitionSettings(recognitionInitial))
  }, [recognition, recognitionInitial])

  const geofenceHasChanges = useMemo(() => {
    if (!geofence || !geofenceInitial) return false
    return JSON.stringify(normalizeGeofenceSettings(geofence)) !== JSON.stringify(normalizeGeofenceSettings(geofenceInitial))
  }, [geofence, geofenceInitial])

  const canSaveRecognitionSettings = !!recognition && recognitionHasChanges && !Object.values(recognitionErrors).some(Boolean)
  const canSaveGeofenceSettings = !!geofence && geofenceHasChanges && !Object.values(geofenceErrors).some(Boolean)

  const settingsLastUpdatedLabel = useMemo(() => {
    if (!settingsLastUpdated) return '-'
    try {
      return new Intl.DateTimeFormat('en-IN', {
        day: '2-digit',
        month: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(settingsLastUpdated)
    } catch {
      return '-'
    }
  }, [settingsLastUpdated])

  function parseTimeToMinutes(value) {
    const str = String(value || '').trim()
    if (!str) return null
    const m = str.match(/(\d{1,2}):(\d{2})/)
    if (!m) return null
    const h = Number(m[1])
    const mm = Number(m[2])
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
    if (h < 0 || h > 23 || mm < 0 || mm > 59) return null
    return (h * 60) + mm
  }

  function getTimingFlags(row) {
    // UI-only heuristic thresholds; no backend/business logic change
    const OFFICE_START_MIN = 9 * 60 + 30
    const OFFICE_END_MIN = 18 * 60
    const inMinutes = parseTimeToMinutes(row?.check_in)
    const outMinutes = parseTimeToMinutes(row?.check_out)
    return {
      isLate: inMinutes != null ? inMinutes > OFFICE_START_MIN : null,
      leftEarly: outMinutes != null ? outMinutes < OFFICE_END_MIN : null,
    }
  }

  async function loadAll() {
    if (!token) return
    setError('')
    setLoading(true)
    try {
      const [e, a, req, rec, geo, cam, train] = await Promise.all([
        apiFetch('/employees', {}, token),
        apiFetch(`/attendance?date=${encodeURIComponent(date)}`, {}, token),
        apiFetch(`/manual_requests${manualStatusFilter ? `?status=${encodeURIComponent(manualStatusFilter)}` : ''}`, {}, token),
        apiFetch('/recognition_settings', {}, token),
        apiFetch('/geofence_settings', {}, token),
        apiFetch('/camera_status', {}, token),
        apiFetch('/train_model/status', {}, token),
      ])
      setEmployees(e)
      setAttendance(a)
      setManualRequests(req)
      setRecognition(rec)
      setRecognitionInitial(rec)
      setGeofence(geo)
      setGeofenceInitial(geo)
      setCameraStatus(cam)
      setTrainStatus(train)
      setSettingsLastUpdated(new Date())
      clearRetryAction()
    } catch (err) {
      setError(err.message)
      if (isRetryableError(err)) {
        setRetryLabel('Retry loading dashboard')
        setRetryAction(() => () => loadAll())
      }
      if (String(err.message).toLowerCase().includes('invalid token')) {
        logout()
      }
    } finally {
      setLoading(false)
    }
  }

  async function refreshAttendanceLogsOnly(nextToken = token) {
    if (!nextToken) return
    try {
      const rows = await apiFetch(`/attendance?date=${encodeURIComponent(date)}`, {}, nextToken)
      setAttendance(rows)
    } catch {
      // UI polling should fail silently
    }
  }

  useEffect(() => {
    loadAll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, date, manualStatusFilter])

  useEffect(() => {
    applyThemePreference(darkMode)
    try {
      localStorage.setItem(UI_THEME_KEY, darkMode ? 'dark' : 'light')
    } catch {
      // no-op
    }
  }, [darkMode])

  useEffect(() => {
    if (!token || view !== 'logs' || !liveTrackingOn) return undefined
    const id = setInterval(() => {
      refreshAttendanceLogsOnly(token)
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view, date, liveTrackingOn])

  async function handleLogin(values) {
    setError('')
    try {
      const data = await apiFetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: values.username, password: values.password }),
      })
      localStorage.setItem(ADMIN_KEY, data.token)
      setToken(data.token)
      setUsername(values.username)
      setMessage('Login successful')
      clearRetryAction()
    } catch (err) {
      setError(err.message)
      if (isRetryableError(err)) {
        setRetryLabel('Retry login')
        setRetryAction(() => () => handleLogin(values))
      }
    }
  }

  function logout() {
    stopEnrollmentCamera()
    localStorage.removeItem(ADMIN_KEY)
    setToken('')
    clearRetryAction()
  }

  useEffect(() => {
    if (!token) return
    const claims = decodeToken(token)
    if (!claims || String(claims.role || '').toLowerCase() !== 'admin' || tokenRemainingMs(token) <= 0) {
      logout()
      setError('Session invalid. Please login again.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function refreshAdminSessionIfNeeded(nextToken = token) {
    if (!nextToken) return
    if (adminRefreshInFlightRef.current) return
    const remaining = tokenRemainingMs(nextToken)
    if (remaining > SESSION_REFRESH_BEFORE_MS) return

    adminRefreshInFlightRef.current = true
    try {
      const data = await apiFetch('/auth/refresh_admin', { method: 'POST' }, nextToken)
      const newToken = String(data?.token || '')
      if (newToken && newToken !== nextToken) {
        localStorage.setItem(ADMIN_KEY, newToken)
        setToken(newToken)
        setSessionRefreshedAt(Date.now())
      }
    } catch (err) {
      const text = String(err?.message || '').toLowerCase()
      if (text.includes('invalid token') || text.includes('please log in again') || text.includes('unauthorized')) {
        logout()
      }
    } finally {
      adminRefreshInFlightRef.current = false
    }
  }

  useEffect(() => {
    if (!token) return undefined
    refreshAdminSessionIfNeeded(token)
    const id = setInterval(() => {
      refreshAdminSessionIfNeeded(token)
    }, SESSION_REFRESH_CHECK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) {
      setSessionExpiringSoon('')
      return undefined
    }
    const apply = () => {
      const remainingMs = tokenRemainingMs(token)
      if (remainingMs > 0 && remainingMs <= SESSION_EXPIRING_SOON_MS) {
        const mins = Math.max(1, Math.ceil(remainingMs / 60000))
        setSessionExpiringSoon(`Session expiring soon (${mins} min left)`)
      } else {
        setSessionExpiringSoon('')
      }
    }
    apply()
    const id = setInterval(apply, SESSION_REFRESH_CHECK_MS)
    return () => clearInterval(id)
  }, [token])

  function flash(msg) {
    setMessage(msg)
    setError('')
  }

  async function startEnrollmentCamera() {
    setError('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 960, max: 1280 },
          height: { ideal: 540, max: 720 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: 'user',
        },
        audio: false,
      })
      enrollmentStreamRef.current = stream
      if (enrollmentVideoRef.current) {
        enrollmentVideoRef.current.srcObject = stream
      }
      setEnrollmentCameraOn(true)
      flash('Enrollment camera ready')
    } catch {
      setError('Unable to access camera for enrollment')
    }
  }

  function stopEnrollmentCamera() {
    enrollmentStreamRef.current?.getTracks()?.forEach((t) => t.stop())
    enrollmentStreamRef.current = null
    if (enrollmentVideoRef.current) {
      enrollmentVideoRef.current.srcObject = null
    }
    setEnrollmentCameraOn(false)
  }

  async function captureEnrollmentFrame(index) {
    const video = enrollmentVideoRef.current
    const canvas = enrollmentCanvasRef.current
    if (!video || !canvas || !enrollmentCameraOn) {
      throw new Error('Start enrollment camera first')
    }

    const srcW = video.videoWidth || 960
    const srcH = video.videoHeight || 540
    canvas.width = srcW
    canvas.height = srcH
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92))
    if (!blob) {
      throw new Error('Failed to capture image from camera')
    }
    return new File([blob], `capture_${String(index).padStart(2, '0')}.jpg`, { type: 'image/jpeg' })
  }

  async function createEmployee(e) {
    e.preventDefault()
    setError('')
    setAddEmployeeFeedback({ type: '', text: '' })
    if (!enrollmentCameraOn) {
      const msg = 'Start camera and auto-capture images before creating employee'
      setError(msg)
      setAddEmployeeFeedback({ type: 'error', text: msg })
      return
    }
    if (enrollmentCapturing) return

    setEnrollmentCapturing(true)
    setEnrollmentProgress(0)
    try {
      const files = []
      for (let i = 1; i <= ENROLLMENT_IMAGE_COUNT; i += 1) {
        const file = await captureEnrollmentFrame(i)
        files.push(file)
        setEnrollmentProgress(i)
        await new Promise((resolve) => setTimeout(resolve, 220))
      }

      const formData = new FormData()
      formData.append('name', newEmp.name)
      formData.append('login_id', newEmp.login_id)
      formData.append('department', newEmp.department)
      formData.append('password', newEmp.password)
      formData.append('require_face_images', 'true')
      formData.append('required_images_count', String(ENROLLMENT_IMAGE_COUNT))
      files.forEach((f) => formData.append('files', f))

      const data = await apiFetch('/register_employee', {
        method: 'POST',
        body: formData,
      }, token)

      if (Number(data.saved_images || 0) < ENROLLMENT_IMAGE_COUNT) {
        throw new Error(`Only ${Number(data.saved_images || 0)} images were saved. Please rescan.`)
      }
      setNewEmp({ name: '', login_id: '', department: 'General', password: '' })
      setEnrollmentProgress(0)
      setEnrollmentCapturing(false)
      stopEnrollmentCamera()
      setAddEmployeeFeedback({ type: 'success', text: 'Employee created successfully' })
      flash('Employee created successfully')
      await loadAll()
      setView('directory')
    } catch (err) {
      setError(err.message)
      setAddEmployeeFeedback({ type: 'error', text: err.message || 'Employee creation failed' })
    } finally {
      setEnrollmentCapturing(false)
    }
  }

  useEffect(() => {
    if (view !== 'add') {
      stopEnrollmentCamera()
      setEnrollmentCapturing(false)
      setEnrollmentProgress(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  useEffect(() => {
    return () => stopEnrollmentCamera()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function approve(id) {
    setError('')
    try {
      await apiFetch(`/manual_requests/${id}/approve`, { method: 'POST' }, token)
      flash('Manual request approved')
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  async function reject(id) {
    if (!id) return
    setRejectReasonModal({
      open: true,
      requestId: id,
      reason: 'Rejected by admin',
      saving: false,
    })
  }

  async function submitRejectReason() {
    const id = rejectReasonModal.requestId
    const reason = String(rejectReasonModal.reason || '').trim() || 'Rejected by admin'
    if (!id) return
    setError('')
    try {
      setRejectReasonModal((old) => ({ ...old, saving: true }))
      await apiFetch(`/manual_requests/${id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      }, token)
      setRejectReasonModal({ open: false, requestId: '', reason: 'Rejected by admin', saving: false })
      flash('Manual request rejected')
      await loadAll()
    } catch (err) {
      setError(err.message)
      setRejectReasonModal((old) => ({ ...old, saving: false }))
    }
  }

  function confirmManualRequestAction(action, id) {
    const normalized = String(action || '').toLowerCase()
    if (!id || (normalized !== 'approve' && normalized !== 'reject')) return

    setConfirmModal({
      open: true,
      title: 'Are you sure?',
      message: `Are you sure you want to ${normalized} this request?`,
      confirmText: 'Confirm',
      onConfirm: async () => {
        if (normalized === 'approve') {
          await approve(id)
        } else {
          await reject(id)
        }
      },
    })
  }

  function approveSelectedRequests() {
    const ids = [...selectedRequestIds]
    if (!ids.length) return
    setConfirmModal({
      open: true,
      title: 'Are you sure?',
      message: `Are you sure you want to approve ${ids.length} selected request(s)?`,
      confirmText: 'Confirm',
      onConfirm: async () => {
        setError('')
        try {
          await Promise.all(ids.map((id) => apiFetch(`/manual_requests/${id}/approve`, { method: 'POST' }, token)))
          setSelectedRequestIds([])
          flash(`${ids.length} request(s) approved`)
          await loadAll()
        } catch (err) {
          setError(err.message)
        }
      },
    })
  }

  async function startTraining() {
    try {
      const data = await apiFetch('/train_model', { method: 'POST' }, token)
      flash(data.message || 'Training triggered')
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  async function startCameraServer() {
    try {
      const data = await apiFetch('/start_camera', { method: 'POST' }, token)
      flash(data.message || 'Camera started')
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  async function stopCameraServer() {
    try {
      const data = await apiFetch('/stop_camera', { method: 'POST' }, token)
      flash(data.message || 'Camera stopped')
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  async function saveRecognitionSettings(e) {
    e.preventDefault()
    if (!recognition) return
    if (recognitionSaving) return
    setSettingsFeedback({ type: '', text: '' })
    if (Object.values(recognitionErrors).some(Boolean)) {
      setError('Please fix recognition settings errors')
      setSettingsFeedback({ type: 'error', text: 'Please fix recognition settings errors' })
      return
    }
    setRecognitionSaving(true)
    try {
      const data = await apiFetch('/recognition_settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...recognition,
          tolerance: Number(recognition.tolerance),
          process_every_n_frames: Number(recognition.process_every_n_frames),
          resize_scale: Number(recognition.resize_scale),
        }),
      }, token)
      setSettingsFeedback({ type: 'success', text: data?.message || 'Settings saved successfully' })
      flash(data?.message || 'Recognition settings updated')
      await loadAll()
    } catch (err) {
      setError(err.message)
      setSettingsFeedback({ type: 'error', text: err.message || 'Failed to save settings' })
    } finally {
      setRecognitionSaving(false)
    }
  }

  async function saveGeofenceSettings(e) {
    e.preventDefault()
    if (!geofence) return
    if (geofenceSaving) return
    setSettingsFeedback({ type: '', text: '' })
    if (Object.values(geofenceErrors).some(Boolean)) {
      setError('Please fix geofence settings errors')
      setSettingsFeedback({ type: 'error', text: 'Please fix geofence settings errors' })
      return
    }
    setGeofenceSaving(true)
    try {
      const data = await apiFetch('/geofence_settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: !!geofence.enabled,
          office_lat: geofence.office_lat === '' || geofence.office_lat == null ? null : Number(geofence.office_lat),
          office_lng: geofence.office_lng === '' || geofence.office_lng == null ? null : Number(geofence.office_lng),
          office_radius_meters: Number(geofence.office_radius_meters),
        }),
      }, token)
      setSettingsFeedback({ type: 'success', text: data?.message || 'Settings saved successfully' })
      flash(data?.message || 'Geofence settings updated')
      await loadAll()
    } catch (err) {
      setError(err.message)
      setSettingsFeedback({ type: 'error', text: err.message || 'Failed to save settings' })
    } finally {
      setGeofenceSaving(false)
    }
  }

  function resetRecognitionToDefaults() {
    setRecognition((old) => ({
      ...(old || {}),
      tolerance: 0.5,
      process_every_n_frames: 2,
      resize_scale: 0.25,
    }))
    setSettingsFeedback({ type: '', text: '' })
  }

  function resetGeofenceToDefaults() {
    setGeofence((old) => ({
      ...(old || {}),
      office_radius_meters: 500,
    }))
    setSettingsFeedback({ type: '', text: '' })
  }

  async function testRecognitionSettings() {
    if (recognitionTesting) return
    setRecognitionTesting(true)
    setRecognitionTestResult({ type: '', text: '' })
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      stream.getTracks().forEach((t) => t.stop())
      setRecognitionTestResult({ type: 'success', text: 'Face detection test ready (camera access available)' })
    } catch {
      setRecognitionTestResult({ type: 'error', text: 'Face detection test failed (camera access unavailable)' })
    } finally {
      setRecognitionTesting(false)
    }
  }

  async function testGeofenceSettings() {
    if (geofenceTesting) return
    const lat = Number(geofence?.office_lat)
    const lng = Number(geofence?.office_lng)
    const radius = Number(geofence?.office_radius_meters)
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(radius) || radius <= 0) {
      setGeofenceTestResult({ type: 'error', text: 'Set valid geofence latitude, longitude, and radius first' })
      return
    }

    setGeofenceTesting(true)
    setGeofenceTestResult({ type: '', text: '' })

    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        })
      })

      const toRad = (d) => (d * Math.PI) / 180
      const earth = 6371000
      const dLat = toRad(pos.coords.latitude - lat)
      const dLng = toRad(pos.coords.longitude - lng)
      const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
        + Math.cos(toRad(lat)) * Math.cos(toRad(pos.coords.latitude))
        * Math.sin(dLng / 2) * Math.sin(dLng / 2)
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
      const distance = earth * c

      setGeofenceTestResult({
        type: distance <= radius ? 'success' : 'error',
        text: distance <= radius ? 'Inside geofence' : 'Outside geofence',
      })
    } catch {
      setGeofenceTestResult({ type: 'error', text: 'Unable to test location (permission denied or unavailable)' })
    } finally {
      setGeofenceTesting(false)
    }
  }

  async function fetchCurrentOfficeLocation() {
    if (geofenceFetching) return
    if (!navigator.geolocation) {
      setGeofenceTestResult({ type: 'error', text: 'Geolocation is not supported in this browser' })
      return
    }

    setGeofenceFetching(true)
    setGeofenceTestResult({ type: '', text: '' })

    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 12000,
          maximumAge: 0,
        })
      })

      const lat = Number(pos.coords.latitude)
      const lng = Number(pos.coords.longitude)
      const accuracy = Number(pos.coords.accuracy || 0)

      setGeofence((old) => ({
        ...(old || {}),
        enabled: true,
        office_lat: Number.isFinite(lat) ? lat.toFixed(6) : old?.office_lat,
        office_lng: Number.isFinite(lng) ? lng.toFixed(6) : old?.office_lng,
      }))

      setSettingsFeedback({ type: 'success', text: 'Office location fetched. Save geofence settings to apply.' })
      setGeofenceTestResult({
        type: 'success',
        text: `Location fetched (±${Math.round(accuracy)}m). Click Save Geofence Settings.`,
      })
    } catch {
      setGeofenceTestResult({ type: 'error', text: 'Unable to fetch current location. Please allow location permission.' })
    } finally {
      setGeofenceFetching(false)
    }
  }

  async function resetPassword(employeeId) {
    const row = (employees || []).find((e) => e.id === employeeId)
    setResetPasswordModal({
      open: true,
      employeeId,
      employeeName: row?.name || row?.login_id || 'Employee',
      password: 'Welcome123',
      saving: false,
    })
  }

  async function submitResetPassword() {
    if (!resetPasswordModal.employeeId) return
    if (!resetPasswordModal.password) {
      setError('Password is required')
      return
    }
    try {
      setResetPasswordModal((old) => ({ ...old, saving: true }))
      await apiFetch(`/employees/${resetPasswordModal.employeeId}/reset_password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_password: resetPasswordModal.password }),
      }, token)
      setResetPasswordModal({ open: false, employeeId: '', employeeName: '', password: '', saving: false })
      flash('Employee password reset')
      await loadAll()
    } catch (err) {
      setError(err.message)
      setResetPasswordModal((old) => ({ ...old, saving: false }))
    }
  }

  async function editEmployee(row) {
    setEditEmployeeModal({
      open: true,
      row,
      name: row?.name || '',
      loginId: row?.login_id || '',
      department: row?.department || 'General',
      saving: false,
    })
  }

  async function submitEditEmployee() {
    if (!editEmployeeModal.row?.id) return
    const name = String(editEmployeeModal.name || '').trim()
    const loginId = String(editEmployeeModal.loginId || '').trim().toLowerCase()
    const dept = String(editEmployeeModal.department || 'General').trim() || 'General'

    if (!name) {
      setError('Employee name is required')
      return
    }
    if (!loginId) {
      setError('Login ID is required')
      return
    }

    try {
      setEditEmployeeModal((old) => ({ ...old, saving: true }))
      await apiFetch(`/employees/${editEmployeeModal.row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, login_id: loginId.toLowerCase(), department: dept }),
      }, token)
      setEditEmployeeModal({ open: false, row: null, name: '', loginId: '', department: 'General', saving: false })
      flash('Employee updated')
      await loadAll()
    } catch (err) {
      setError(err.message)
      setEditEmployeeModal((old) => ({ ...old, saving: false }))
    }
  }

  async function deleteEmployee(row) {
    setConfirmModal({
      open: true,
      title: 'Are you sure?',
      message: 'Are you sure you want to delete this employee?',
      confirmText: 'Delete',
      onConfirm: async () => {
        try {
          await apiFetch(`/employees/${row.id}`, { method: 'DELETE' }, token)
          flash('Employee deleted')
          await loadAll()
        } catch (err) {
          setError(err.message)
        }
      },
    })
  }

  async function runTableActionBusy(key, fn) {
    if (!key || typeof fn !== 'function') return
    if (tableActionBusy[key]) return
    setTableActionBusy((old) => ({ ...old, [key]: true }))
    try {
      await fn()
    } finally {
      setTableActionBusy((old) => ({ ...old, [key]: false }))
    }
  }

  if (!token) {
    return (
      <main className="page center">
        <LoginCard
          title="Admin Login"
          message={error || 'Use admin credentials to open workspace.'}
          fields={[
            { name: 'username', placeholder: 'Username', defaultValue: 'admin', autoComplete: 'username' },
            { name: 'password', placeholder: 'Password', type: 'password', autoComplete: 'current-password' },
          ]}
          onSubmit={handleLogin}
        />
      </main>
    )
  }

  return (
    <main className="page">
      <div className="layout">
        <aside className="card sidebar">
          <h3 className="sidebar-title">Admin Workspace</h3>
          <button className={`sidebar-menu-btn ${view === 'overview' ? 'active' : ''}`} onClick={() => setView('overview')}>
            <span aria-hidden="true">🏠</span><span>Overview</span>
          </button>
          <button className={`sidebar-menu-btn ${view === 'add' ? 'active' : ''}`} onClick={() => setView('add')}>
            <span aria-hidden="true">➕</span><span>Add Employee</span>
          </button>
          <button className={`sidebar-menu-btn ${view === 'directory' ? 'active' : ''}`} onClick={() => setView('directory')}>
            <span aria-hidden="true">👥</span><span>Directory</span>
          </button>
          <button className={`sidebar-menu-btn ${view === 'logs' ? 'active' : ''}`} onClick={() => setView('logs')}>
            <span aria-hidden="true">📋</span><span>Logs</span>
          </button>
          <button className={`sidebar-menu-btn ${view === 'requests' ? 'active' : ''}`} onClick={() => setView('requests')}>
            <span aria-hidden="true">🧾</span><span>Requests</span>
          </button>
          <button className={`sidebar-menu-btn ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')}>
            <span aria-hidden="true">⚙️</span><span>Settings</span>
          </button>
          <button className="sidebar-secondary-btn" onClick={() => navigate('/user')}>User Panel</button>
          <button className="sidebar-secondary-btn theme-toggle-btn" onClick={() => setDarkMode((v) => !v)}>
            {darkMode ? '🌙 Dark Mode: On' : '☀️ Dark Mode: Off'}
          </button>
        </aside>

        <section className="content">
          {view === 'overview' && (
            <header className="card topbar">
              <div className="admin-header-left">
                <h2>Admin Dashboard</h2>
                <p className="muted">Workforce Attendance Management</p>
                <p className="muted small">Admin: <strong>{username}</strong></p>
                <p className="muted small">
                  Session auto-refresh: {sessionRefreshedAt ? `Last refresh at ${new Date(sessionRefreshedAt).toLocaleTimeString()}` : 'Enabled (waiting for next cycle)'}
                </p>
                {!!sessionExpiringSoon && <p className="error">{sessionExpiringSoon}</p>}
                <div className="admin-status-badges">
                  <span className={`status-badge ${cameraStatus?.running ? 'ok' : ''}`}>
                    Camera: {cameraStatus?.running ? 'Active' : 'Stopped'}
                  </span>
                  <span className={`status-badge ${trainStatus?.running ? '' : 'ok'}`}>
                    Model: {trainStatus?.running ? 'Training' : 'Idle'}
                  </span>
                </div>
              </div>
              <div className="row admin-header-actions">
                <button onClick={startTraining}>Train Model</button>
                <button onClick={loadAll}>Refresh</button>
                <button className="ghost" onClick={logout}>Logout</button>
              </div>
            </header>
          )}

          {!!message && <div className="success">{message}</div>}
          {!!error && (
            <div className="error row between">
              <span>{error}</span>
              {!!retryAction && (
                <button type="button" className="ghost" onClick={retryAction}>{retryLabel || 'Retry'}</button>
              )}
            </div>
          )}

          {view === 'overview' && (
            <>
              <div className="cards4">
                <article className="card stat stat-card stat-success">
                  <h4 className="stat-title">Daily Records</h4>
                  <strong className="stat-value">{counts.total}</strong>
                  <p className="stat-subtext">Today</p>
                </article>
                <article className="card stat stat-card stat-success">
                  <h4 className="stat-title">Checked Out</h4>
                  <strong className="stat-value">{counts.checkedOut}</strong>
                  <p className="stat-subtext">Completed shifts</p>
                </article>
                <article className="card stat stat-card stat-warn">
                  <h4 className="stat-title">Checked In Only</h4>
                  <strong className="stat-value">{counts.checkedInOnly}</strong>
                  <p className="stat-subtext">Pending check-out</p>
                </article>
                <article className="card stat stat-card">
                  <h4 className="stat-title">Date Filter</h4>
                  <p className="stat-subtext">Select date</p>
                  <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                </article>
              </div>

              <div className="cards4">
                <article className="card stat stat-card stat-warn">
                  <h4 className="stat-title">Pending Requests</h4>
                  <strong className="stat-value">{manualRequests.length}</strong>
                  <p className="stat-subtext">Awaiting review</p>
                </article>
                <article className={`card stat stat-card ${cameraStatus?.running ? 'stat-success' : 'stat-warn'}`}>
                  <h4 className="stat-title">Camera Status</h4>
                  <strong className="stat-value">{cameraStatus?.running ? 'Running' : 'Stopped'}</strong>
                  <p className="stat-subtext">Admin stream control</p>
                  <div className="row compact">
                    <button onClick={startCameraServer}>Start</button>
                    <button className="ghost" onClick={stopCameraServer}>Stop</button>
                  </div>
                </article>
                <article className={`card stat stat-card ${trainStatus?.running ? 'stat-warn' : 'stat-success'}`}>
                  <h4 className="stat-title">Training</h4>
                  <strong className="stat-value">{trainStatus?.running ? 'In Progress' : 'Idle'}</strong>
                  <p className="stat-subtext">{trainStatus?.message || 'No active training job'}</p>
                </article>
                <article className={`card stat stat-card ${loading ? 'stat-warn' : 'stat-success'}`}>
                  <h4 className="stat-title">Live Refresh</h4>
                  <strong className="stat-value">{loading ? 'Loading…' : 'Ready'}</strong>
                  <p className="stat-subtext">Dashboard sync</p>
                </article>
              </div>

              <div className="card alerts-section">
                <div className="row between">
                  <h3>Alerts & Notifications</h3>
                  <p className="muted small">Uses current dashboard data</p>
                </div>
                <div className="alerts-grid">
                  <article className={`alert-card ${alerts.pendingRequests > 0 ? 'warn' : 'ok'}`}>
                    <p className="alert-title">Pending Requests</p>
                    <strong className="alert-value">{alerts.pendingRequests}</strong>
                    <p className="alert-subtext">Requires admin review</p>
                  </article>

                  <article className={`alert-card ${alerts.geofenceDataAvailable ? 'warn' : 'placeholder'}`}>
                    <p className="alert-title">Employees Outside Geofence</p>
                    <strong className="alert-value">{alerts.geofenceDataAvailable ? alerts.outsideGeofenceCount : '-'}</strong>
                    <p className="alert-subtext">{alerts.geofenceDataAvailable ? 'Based on request entries' : 'No request data available'}</p>
                  </article>

                  <article className={`alert-card ${alerts.cameraDataAvailable ? (alerts.cameraInactive ? 'danger' : 'ok') : 'placeholder'}`}>
                    <p className="alert-title">Camera Not Active</p>
                    <strong className="alert-value">
                      {alerts.cameraDataAvailable ? (alerts.cameraInactive ? 'Yes' : 'No') : '-'}
                    </strong>
                    <p className="alert-subtext">
                      {alerts.cameraDataAvailable ? 'From camera status service' : 'Camera status unavailable'}
                    </p>
                  </article>
                </div>
              </div>
            </>
          )}

          {view === 'add' && (
            <form className="card form" onSubmit={createEmployee}>
              <h3>Add Employee</h3>
              {!!addEmployeeFeedback.text && (
                <div className={addEmployeeFeedback.type === 'success' ? 'success' : 'error'}>{addEmployeeFeedback.text}</div>
              )}
              <div className="add-steps" aria-label="Add Employee Steps">
                <div className={`add-step ${addEmployeeStep === 1 ? 'current' : ''} ${addEmployeeStep > 1 ? 'done' : ''}`}>
                  <span className="add-step-index">1</span>
                  <span className="add-step-label">Enter Details</span>
                </div>
                <div className={`add-step ${addEmployeeStep === 2 ? 'current' : ''} ${addEmployeeStep > 2 ? 'done' : ''}`}>
                  <span className="add-step-index">2</span>
                  <span className="add-step-label">Start Camera</span>
                </div>
                <div className={`add-step ${addEmployeeStep === 3 ? 'current' : ''} ${addEmployeeStep > 3 ? 'done' : ''}`}>
                  <span className="add-step-index">3</span>
                  <span className="add-step-label">Capture Face</span>
                </div>
                <div className={`add-step ${addEmployeeStep === 4 ? 'current' : ''}`}>
                  <span className="add-step-index">4</span>
                  <span className="add-step-label">Create Employee</span>
                </div>
              </div>
              <div className="add-employee-layout">
                <div className="add-employee-left">
                  <div className="form-group-card">
                    <h4 className="form-group-title">Employee Details</h4>
                    <label className="add-field-label">Name</label>
                    <input className="add-employee-input" placeholder="Name" value={newEmp.name} onChange={(e) => setNewEmp((o) => ({ ...o, name: e.target.value }))} required />

                    <label className="add-field-label">Login ID</label>
                    <p className="muted small add-field-help">Use unique login ID</p>
                    <input className="add-employee-input" placeholder="Login ID" value={newEmp.login_id} onChange={(e) => setNewEmp((o) => ({ ...o, login_id: e.target.value.toLowerCase() }))} required />

                    <label className="add-field-label">Department</label>
                    <input className="add-employee-input" placeholder="Department" value={newEmp.department} onChange={(e) => setNewEmp((o) => ({ ...o, department: e.target.value }))} required />
                  </div>

                  <div className="form-section-divider" />

                  <div className="form-group-card">
                    <h4 className="form-group-title">Security</h4>
                    <label className="add-field-label">Password</label>
                    <p className="muted small add-field-help">Password should be secure</p>
                    <input className="add-employee-input" type="text" placeholder="Password" value={newEmp.password} onChange={(e) => setNewEmp((o) => ({ ...o, password: e.target.value }))} required />
                  </div>
                </div>

                <div className="add-employee-right">
                  <h4 className="form-group-title">Camera Capture</h4>
                  <div className="row add-employee-controls">
                    <button type="button" className="add-employee-start-btn" onClick={startEnrollmentCamera} disabled={enrollmentCameraOn || enrollmentCapturing}>Start Camera</button>
                    <button type="button" className="ghost add-employee-stop-btn" onClick={stopEnrollmentCamera} disabled={!enrollmentCameraOn || enrollmentCapturing}>Stop Camera</button>
                  </div>
                  <video ref={enrollmentVideoRef} autoPlay playsInline className="preview" />
                  <canvas ref={enrollmentCanvasRef} className="hidden" />
                  {(enrollmentCameraOn || enrollmentCapturing) && (
                    <>
                      <p className="status-text capture-progress-text">Captured: {enrollmentProgress} / {ENROLLMENT_IMAGE_COUNT} images</p>
                      <div className="capture-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={ENROLLMENT_IMAGE_COUNT} aria-valuenow={enrollmentProgress}>
                        <div
                          className="capture-progress-fill"
                          style={{ width: `${Math.min(100, Math.round((enrollmentProgress / ENROLLMENT_IMAGE_COUNT) * 100))}%` }}
                        />
                      </div>
                      {enrollmentCapturing && <p className="muted small">Capturing in progress...</p>}
                    </>
                  )}
                </div>
              </div>
              {(enrollmentCameraOn || enrollmentCapturing) && (
                <button className="add-employee-cta" disabled={!canSubmitEnrollment}>
                  {enrollmentCapturing ? `Capturing ${enrollmentProgress}/${ENROLLMENT_IMAGE_COUNT}...` : `Create Employee + Auto Capture (${ENROLLMENT_IMAGE_COUNT})`}
                </button>
              )}
              {!enrollmentCapturing && isEnrollmentNameReady && !enrollmentCameraOn && <p className="muted small add-employee-helper">Start camera to enable capture</p>}
            </form>
          )}

          {view === 'directory' && (
            <div className="card table-card">
              <div className="row between table-header-row">
                <div>
                  <h3>Employee Directory</h3>
                  <p className="muted small">Total Employees: {employees.length}</p>
                </div>
                <div className="row table-toolbar directory-toolbar">
                  <button
                    type="button"
                    className="danger"
                    disabled={!selectedEmployeeIds.length}
                    onClick={deleteSelectedEmployees}
                  >
                    Delete Selected{selectedEmployeeIds.length ? ` (${selectedEmployeeIds.length})` : ''}
                  </button>
                  <div className="table-search-wrap">
                    <span className="table-search-icon" aria-hidden="true">🔎</span>
                    <input
                      className="table-search table-search-with-icon"
                      placeholder="Search name, login, department"
                      value={directorySearch}
                      onChange={(e) => setDirectorySearch(e.target.value)}
                    />
                  </div>
                  <div className="directory-filter-block">
                    <label className="directory-filter-label">Filter by Department</label>
                    <select value={directoryDeptFilter} onChange={(e) => setDirectoryDeptFilter(e.target.value)}>
                      <option value="all">All Departments</option>
                      {directoryDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  {(directorySearch || directoryDeptFilter !== 'all') && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setDirectorySearch('')
                        setDirectoryDeptFilter('all')
                      }}
                    >
                      Clear Filters
                    </button>
                  )}
                </div>
              </div>
              <table className="directory-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        className="directory-select-checkbox"
                        checked={allVisibleSelected}
                        onChange={toggleSelectAllVisible}
                        aria-label="Select all employees"
                      />
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => toggleDirectorySort('name')}>
                        Name
                        <span className="table-sort-arrows" aria-hidden="true">
                          {directorySort.key === 'name' ? (directorySort.direction === 'asc' ? '↑' : '↓') : '↑↓'}
                        </span>
                      </button>
                    </th>
                    <th>Login</th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => toggleDirectorySort('department')}>
                        Department
                        <span className="table-sort-arrows" aria-hidden="true">
                          {directorySort.key === 'department' ? (directorySort.direction === 'asc' ? '↑' : '↓') : '↑↓'}
                        </span>
                      </button>
                    </th>
                    <th>Status</th>
                    <th>Password Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredEmployees.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <input
                          type="checkbox"
                          className="directory-select-checkbox"
                          checked={selectedEmployeeIds.includes(e.id)}
                          onChange={() => toggleEmployeeSelection(e.id)}
                          aria-label={`Select ${e.name || e.login_id || 'employee'}`}
                        />
                      </td>
                      <td>{e.name}</td>
                      <td>{e.login_id}</td>
                      <td>{e.department || 'General'}</td>
                      <td>
                        {(() => {
                          const statusText = String(e.status || '').toLowerCase()
                          const isInactiveByStatus = statusText === 'inactive'
                          const hasIsActiveFlag = typeof e.is_active === 'boolean'
                          const hasActiveFlag = typeof e.active === 'boolean'
                          const isActive = hasIsActiveFlag ? !!e.is_active : (hasActiveFlag ? !!e.active : !isInactiveByStatus)
                          return (
                            <span className={`status-badge ${isActive ? 'ok' : ''}`}>
                              {isActive ? 'Active' : 'Inactive'}
                            </span>
                          )
                        })()}
                      </td>
                      <td>
                        {(() => {
                          const mustChangePassword = !!e.must_change_password

                          return (
                            <div className="row compact">
                              <span>{mustChangePassword ? 'Reset required' : 'Protected'}</span>
                            </div>
                          )
                        })()}
                      </td>
                      <td>
                        <div className="row compact directory-actions">
                          <button
                            className="table-action-btn"
                            disabled={!!tableActionBusy[`${e.id}:edit`]}
                            onClick={() => runTableActionBusy(`${e.id}:edit`, async () => editEmployee(e))}
                          >
                            ✏️ Edit
                          </button>
                          <button
                            className="ghost table-action-btn"
                            disabled={!!tableActionBusy[`${e.id}:reset`]}
                            onClick={() => runTableActionBusy(`${e.id}:reset`, async () => resetPassword(e.id))}
                          >
                            🔄 Reset Password
                          </button>
                          <button
                            className="danger table-action-btn directory-delete-btn"
                            disabled={!!tableActionBusy[`${e.id}:delete`]}
                            onClick={() => runTableActionBusy(`${e.id}:delete`, async () => deleteEmployee(e))}
                          >
                            🗑️ Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!filteredEmployees.length && (
                    <tr>
                      <td colSpan={7}>
                        <div className="directory-empty-state">
                          <p className="muted">No employees found</p>
                          <button type="button" className="ghost" onClick={() => setView('add')}>Add Employee</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {view === 'logs' && (
            <div className="card table-card">
              <div className="row between table-header-row">
                <div>
                  <h3>Attendance Logs ({date})</h3>
                  {liveTrackingOn && <p className="live-tracking-indicator">Live Tracking ON</p>}
                </div>
                <div className="row table-toolbar">
                  <button type="button" className="ghost" onClick={exportAttendanceCsv} disabled={!filteredAttendance.length}>Export CSV</button>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    aria-label="Select attendance date"
                  />
                  <input
                    className="table-search"
                    placeholder="Search employee or status"
                    value={logsSearch}
                    onChange={(e) => setLogsSearch(e.target.value)}
                  />
                  <select value={logsStatusFilter} onChange={(e) => setLogsStatusFilter(e.target.value)}>
                    <option value="all">All Status</option>
                    <option value="checked_in">Checked In</option>
                    <option value="checked_out">Checked Out</option>
                  </select>
                </div>
              </div>
              <div className="logs-summary-cards">
                <article className="logs-summary-card">
                  <p className="logs-summary-label">Total Employees</p>
                  <strong className="logs-summary-value">{attendanceSummary.totalEmployees ?? '-'}</strong>
                </article>
                <article className="logs-summary-card logs-summary-card-green">
                  <p className="logs-summary-label">Checked In</p>
                  <strong className="logs-summary-value">{attendanceSummary.checkedIn ?? '-'}</strong>
                </article>
                <article className="logs-summary-card logs-summary-card-blue">
                  <p className="logs-summary-label">Checked Out</p>
                  <strong className="logs-summary-value">{attendanceSummary.checkedOut ?? '-'}</strong>
                </article>
                <article className="logs-summary-card logs-summary-card-red">
                  <p className="logs-summary-label">Absent</p>
                  <strong className="logs-summary-value">{attendanceSummary.absent ?? '-'}</strong>
                </article>
              </div>
              <table className="attendance-table">
                <thead>
                  <tr>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => toggleLogsSort('employee_name')}>
                        Name
                        <span className="table-sort-arrows" aria-hidden="true">
                          {logsSort.key === 'employee_name' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↑↓'}
                        </span>
                      </button>
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => toggleLogsSort('check_in')}>
                        In
                        <span className="table-sort-arrows" aria-hidden="true">
                          {logsSort.key === 'check_in' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↑↓'}
                        </span>
                      </button>
                    </th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => toggleLogsSort('check_out')}>
                        Out
                        <span className="table-sort-arrows" aria-hidden="true">
                          {logsSort.key === 'check_out' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↑↓'}
                        </span>
                      </button>
                    </th>
                    <th>Status</th>
                    <th>Mode</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAttendance.map((a) => (
                    <tr
                      key={a.id}
                      className={(() => {
                        const flags = getTimingFlags(a)
                        const rawStatus = String(a.status || '').toLowerCase()
                        if (rawStatus === 'absent') return 'attendance-row-absent'
                        if (flags.isLate === true) return 'attendance-row-late'
                        return ''
                      })()}
                    >
                      <td>{a.employee_name}</td>
                      <td>
                        {(() => {
                          const flags = getTimingFlags(a)
                          return (
                            <div className="attendance-time-cell">
                              <span>{a.check_in || '-'}</span>
                              {flags.isLate === true && <span className="attendance-time-flag late">Late</span>}
                              {flags.isLate == null && <span className="attendance-time-placeholder">—</span>}
                            </div>
                          )
                        })()}
                      </td>
                      <td>
                        {(() => {
                          const flags = getTimingFlags(a)
                          return (
                            <div className="attendance-time-cell">
                              <span>{a.check_out || '-'}</span>
                              {flags.leftEarly === true && <span className="attendance-time-flag early">Left Early</span>}
                              {flags.leftEarly == null && <span className="attendance-time-placeholder">—</span>}
                            </div>
                          )
                        })()}
                      </td>
                      <td>
                        {(() => {
                          const rawStatus = String(a.status || '').toLowerCase()
                          const statusClass = rawStatus === 'checked_in'
                            ? 'checked-in'
                            : rawStatus === 'checked_out'
                              ? 'checked-out'
                              : rawStatus === 'absent'
                                ? 'absent'
                                : 'default'
                          const statusLabel = rawStatus ? rawStatus.replace(/_/g, ' ').toUpperCase() : '-'
                          return <span className={`attendance-log-badge ${statusClass}`}>{statusLabel}</span>
                        })()}
                      </td>
                      <td>
                        {(() => {
                          const mode = a.manual_entry ? 'manual' : 'auto'
                          return <span className={`attendance-mode-badge ${mode}`}>{mode.toUpperCase()}</span>
                        })()}
                      </td>
                    </tr>
                  ))}
                  {!filteredAttendance.length && (
                    <tr>
                      <td colSpan={5}>
                        <div className="logs-empty-state">
                          <p>No attendance records found</p>
                          <p className="muted small">Try selecting another date</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {view === 'requests' && (
            <div className="card table-card">
              <div className="row between">
                <h3>Manual Requests</h3>
                <div className="row table-toolbar requests-toolbar">
                  <button
                    type="button"
                    className="table-action-btn request-approve-btn"
                    disabled={!selectedRequestIds.length}
                    onClick={approveSelectedRequests}
                  >
                    Approve All{selectedRequestIds.length ? ` (${selectedRequestIds.length})` : ''}
                  </button>
                  <div className="requests-filter-block">
                    <label className="requests-filter-label">Search</label>
                    <input
                      className="table-search"
                      placeholder="Search employee, reason, type"
                      value={requestsSearch}
                      onChange={(e) => setRequestsSearch(e.target.value)}
                    />
                  </div>
                  <div className="requests-filter-block">
                    <label className="requests-filter-label">Status filter</label>
                    <select value={manualStatusFilter} onChange={(e) => setManualStatusFilter(e.target.value)}>
                      <option value="pending">Pending</option>
                      <option value="approved">Approved</option>
                      <option value="rejected">Rejected</option>
                      <option value="conflict">Conflict</option>
                      <option value="">All</option>
                    </select>
                  </div>
                  <div className="requests-filter-block">
                    <label className="requests-filter-label">Date filter</label>
                    <select value={requestsDateFilter} onChange={(e) => setRequestsDateFilter(e.target.value)}>
                      <option value="all">All Dates</option>
                      {requestDates.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                  </div>
                  {(requestsSearch || manualStatusFilter !== 'pending' || requestsDateFilter !== 'all') && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setRequestsSearch('')
                        setManualStatusFilter('pending')
                        setRequestsDateFilter('all')
                      }}
                    >
                      Clear Filters
                    </button>
                  )}
                </div>
              </div>
              <div className="requests-summary-cards">
                <article className="requests-summary-card">
                  <p className="requests-summary-label">Total Requests</p>
                  <strong className="requests-summary-value">{requestsSummary.total ?? '-'}</strong>
                </article>
                <article className="requests-summary-card requests-summary-card-pending">
                  <p className="requests-summary-label">Pending</p>
                  <strong className="requests-summary-value">{requestsSummary.pending ?? '-'}</strong>
                </article>
                <article className="requests-summary-card requests-summary-card-approved">
                  <p className="requests-summary-label">Approved</p>
                  <strong className="requests-summary-value">{requestsSummary.approved ?? '-'}</strong>
                </article>
                <article className="requests-summary-card requests-summary-card-rejected">
                  <p className="requests-summary-label">Rejected</p>
                  <strong className="requests-summary-value">{requestsSummary.rejected ?? '-'}</strong>
                </article>
              </div>
              <table className="manual-requests-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        className="requests-select-checkbox"
                        checked={allVisibleRequestsSelected}
                        onChange={toggleSelectAllVisibleRequests}
                        aria-label="Select all requests"
                      />
                    </th>
                    <th>Name</th>
                    <th>Date</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Reason</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredManualRequests.map((r) => (
                    <tr
                      key={r.id}
                      className={(() => {
                        const status = String(r.status || '').toLowerCase()
                        if (status === 'pending') return 'manual-request-row-pending'
                        if (status === 'rejected') return 'manual-request-row-rejected'
                        return ''
                      })()}
                    >
                      <td>
                        <input
                          type="checkbox"
                          className="requests-select-checkbox"
                          checked={selectedRequestIds.includes(r.id)}
                          onChange={() => toggleRequestSelection(r.id)}
                          aria-label={`Select request of ${r.employee_name || 'employee'}`}
                        />
                      </td>
                      <td>{r.employee_name}</td>
                      <td>{r.date}</td>
                      <td>{r.request_type || r.work_mode || 'outside_office'}</td>
                      <td>
                        {(() => {
                          const rawStatus = String(r.status || '').toLowerCase()
                          const statusClass = rawStatus === 'pending'
                            ? 'pending'
                            : rawStatus === 'approved'
                              ? 'approved'
                              : rawStatus === 'rejected'
                                ? 'rejected'
                                : 'default'
                          const statusLabel = rawStatus ? rawStatus.toUpperCase() : '-'
                          return <span className={`request-status-badge ${statusClass}`}>{statusLabel}</span>
                        })()}
                      </td>
                      <td>{r.reason}</td>
                      <td className="row compact manual-request-actions">
                        <button
                          type="button"
                          className="ghost table-action-btn"
                          onClick={() => setRequestDetailsModal({ open: true, request: r })}
                        >
                          👁 View Details
                        </button>
                        {r.status === 'pending' ? (
                          <>
                            <button className="table-action-btn request-approve-btn" onClick={() => confirmManualRequestAction('approve', r.id)}>✔ Approve</button>
                            <button className="table-action-btn request-reject-btn" onClick={() => confirmManualRequestAction('reject', r.id)}>✖ Reject</button>
                          </>
                        ) : (
                          <span className="muted">No action</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!filteredManualRequests.length && (
                    <tr>
                      <td colSpan={7}>
                        <div className="manual-requests-empty-state">
                          <div className="manual-requests-empty-icon" aria-hidden="true">🗂️</div>
                          <p className="manual-requests-empty-title">No pending requests</p>
                          <p className="muted small">All requests are handled</p>
                          <button type="button" className="ghost" onClick={loadAll}>Refresh</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {view === 'settings' && (
            <div className="cards2">
              {!!settingsFeedback.text && (
                <div className={`${settingsFeedback.type === 'success' ? 'success' : 'error'} settings-feedback-full`}>{settingsFeedback.text}</div>
              )}
              <p className="muted small settings-last-updated">Last updated: {settingsLastUpdatedLabel}</p>
              <form className="card form settings-card" onSubmit={saveRecognitionSettings}>
                <h3>Recognition Settings</h3>
                <label>Recognition Tolerance</label>
                <p className="muted small settings-help">Recognition tolerance (0.3 - 0.7 recommended)</p>
                <input
                  type="number"
                  step="0.01"
                  className={recognitionErrors.tolerance ? 'input-invalid' : ''}
                  value={recognition?.tolerance ?? ''}
                  onChange={(e) => setRecognition((old) => ({ ...old, tolerance: e.target.value }))}
                />
                {!!recognitionErrors.tolerance && <p className="field-error">{recognitionErrors.tolerance}</p>}
                {!!recognitionWarnings.tolerance && <p className="field-warning">{recognitionWarnings.tolerance}</p>}
                <label>Process Every N Frames</label>
                <p className="muted small settings-help">Lower value = faster checks, higher CPU usage</p>
                <input
                  type="number"
                  min="1"
                  className={recognitionErrors.process_every_n_frames ? 'input-invalid' : ''}
                  value={recognition?.process_every_n_frames ?? ''}
                  onChange={(e) => setRecognition((old) => ({ ...old, process_every_n_frames: e.target.value }))}
                />
                {!!recognitionErrors.process_every_n_frames && <p className="field-error">{recognitionErrors.process_every_n_frames}</p>}
                <label>Frame Resize Scale</label>
                <p className="muted small settings-help">Use 0.25 to 0.5 for balanced speed and accuracy</p>
                <input
                  type="number"
                  step="0.01"
                  min="0.1"
                  max="1"
                  className={recognitionErrors.resize_scale ? 'input-invalid' : ''}
                  value={recognition?.resize_scale ?? ''}
                  onChange={(e) => setRecognition((old) => ({ ...old, resize_scale: e.target.value }))}
                />
                {!!recognitionErrors.resize_scale && <p className="field-error">{recognitionErrors.resize_scale}</p>}
                <div className="row">
                  <button type="button" className="ghost" onClick={testRecognitionSettings} disabled={recognitionTesting}>
                    {recognitionTesting ? 'Testing...' : 'Test Settings'}
                  </button>
                  <button type="button" className="ghost" onClick={resetRecognitionToDefaults}>Reset to Default</button>
                  <button type="submit" disabled={!canSaveRecognitionSettings || recognitionSaving}>
                    {recognitionSaving ? 'Saving...' : 'Save Recognition Settings'}
                  </button>
                </div>
                {!!recognitionTestResult.text && (
                  <div className={recognitionTestResult.type === 'success' ? 'success' : 'error'}>{recognitionTestResult.text}</div>
                )}
              </form>

              <form className="card form settings-card" onSubmit={saveGeofenceSettings}>
                <h3>Geofence Settings</h3>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={!!geofence?.enabled}
                    onChange={(e) => setGeofence((old) => ({ ...old, enabled: e.target.checked }))}
                  />
                  Enable geofence
                </label>
                <p className="muted small settings-help">If geofence is disabled, attendance marking is blocked.</p>
                <label>Office Latitude</label>
                <p className="muted small settings-help">Example: 28.6139</p>
                <input
                  type="number"
                  step="0.000001"
                  className={geofenceErrors.office_lat ? 'input-invalid' : ''}
                  value={geofence?.office_lat ?? ''}
                  onChange={(e) => setGeofence((old) => ({ ...old, office_lat: e.target.value }))}
                />
                {!!geofenceErrors.office_lat && <p className="field-error">{geofenceErrors.office_lat}</p>}
                <label>Office Longitude</label>
                <p className="muted small settings-help">Example: 77.2090</p>
                <input
                  type="number"
                  step="0.000001"
                  className={geofenceErrors.office_lng ? 'input-invalid' : ''}
                  value={geofence?.office_lng ?? ''}
                  onChange={(e) => setGeofence((old) => ({ ...old, office_lng: e.target.value }))}
                />
                {!!geofenceErrors.office_lng && <p className="field-error">{geofenceErrors.office_lng}</p>}
                <label>Radius (meters)</label>
                <p className="muted small settings-help">Recommended office radius: 100 - 500 meters</p>
                <input
                  type="number"
                  min="1"
                  className={geofenceErrors.office_radius_meters ? 'input-invalid' : ''}
                  value={geofence?.office_radius_meters ?? 500}
                  onChange={(e) => setGeofence((old) => ({ ...old, office_radius_meters: e.target.value }))}
                />
                {!!geofenceErrors.office_radius_meters && <p className="field-error">{geofenceErrors.office_radius_meters}</p>}
                {!!geofenceWarnings.office_radius_meters && <p className="field-warning">{geofenceWarnings.office_radius_meters}</p>}
                <div className="geofence-preview">
                  <p className="geofence-preview-title">Geofence Preview</p>
                  <div className="geofence-preview-grid">
                    <p><strong>Latitude:</strong> {geofence?.office_lat ?? '-'}</p>
                    <p><strong>Longitude:</strong> {geofence?.office_lng ?? '-'}</p>
                    <p><strong>Radius:</strong> {geofence?.office_radius_meters ?? '-'} meters</p>
                  </div>
                  <p className="muted small">
                    Geofence set at ({geofence?.office_lat ?? '-'}, {geofence?.office_lng ?? '-'}) with radius {geofence?.office_radius_meters ?? '-'} meters
                  </p>
                </div>
                <div className="row">
                  <button type="button" className="ghost" onClick={fetchCurrentOfficeLocation} disabled={geofenceFetching}>
                    {geofenceFetching ? 'Fetching...' : 'Fetch Current Location'}
                  </button>
                  <button type="button" className="ghost" onClick={testGeofenceSettings} disabled={geofenceTesting}>
                    {geofenceTesting ? 'Testing...' : 'Test Settings'}
                  </button>
                  <button type="button" className="ghost" onClick={resetGeofenceToDefaults}>Reset to Default</button>
                  <button type="submit" disabled={!canSaveGeofenceSettings || geofenceSaving}>
                    {geofenceSaving ? 'Saving...' : 'Save Geofence Settings'}
                  </button>
                </div>
                {!!geofenceTestResult.text && (
                  <div className={geofenceTestResult.type === 'success' ? 'success' : 'error'}>{geofenceTestResult.text}</div>
                )}
              </form>
            </div>
          )}
        </section>
      </div>
      {confirmModal.open && (
        <div className="modal-overlay" onClick={() => setConfirmModal((old) => ({ ...old, open: false, onConfirm: null }))}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{confirmModal.title || 'Are you sure?'}</h3>
            <p className="muted">{confirmModal.message || 'Please confirm this action.'}</p>
            <div className="row modal-actions confirm-modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={confirmSubmitting}
                onClick={() => setConfirmModal((old) => ({ ...old, open: false, onConfirm: null }))}
              >
                Cancel
              </button>
              <button
                type="button"
                className="danger"
                disabled={confirmSubmitting}
                onClick={async () => {
                  const fn = confirmModal.onConfirm
                  if (typeof fn !== 'function') {
                    setConfirmModal((old) => ({ ...old, open: false, onConfirm: null }))
                    return
                  }
                  setConfirmSubmitting(true)
                  try {
                    setConfirmModal((old) => ({ ...old, open: false, onConfirm: null }))
                    await fn()
                  } finally {
                    setConfirmSubmitting(false)
                  }
                }}
              >
                {confirmModal.confirmText || 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
      {requestDetailsModal.open && (
        <div className="modal-overlay" onClick={() => setRequestDetailsModal({ open: false, request: null })}>
          <div className="modal-card request-details-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Request Details</h3>
            <div className="request-details-grid">
              <p><strong>Employee:</strong> {requestDetailsModal.request?.employee_name || '-'}</p>
              <p><strong>Date:</strong> {requestDetailsModal.request?.date || '-'}</p>
              <p><strong>Reason:</strong> {requestDetailsModal.request?.reason || '-'}</p>
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button type="button" className="ghost" onClick={() => setRequestDetailsModal({ open: false, request: null })}>Close</button>
            </div>
          </div>
        </div>
      )}
      {rejectReasonModal.open && (
        <div className="modal-overlay" onClick={() => setRejectReasonModal({ open: false, requestId: '', reason: 'Rejected by admin', saving: false })}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Reject Request</h3>
            <div className="stack">
              <input
                type="text"
                placeholder="Rejection reason"
                value={rejectReasonModal.reason}
                onChange={(e) => setRejectReasonModal((old) => ({ ...old, reason: e.target.value }))}
              />
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={rejectReasonModal.saving}
                onClick={() => setRejectReasonModal({ open: false, requestId: '', reason: 'Rejected by admin', saving: false })}
              >
                Cancel
              </button>
              <button type="button" className="danger" disabled={rejectReasonModal.saving} onClick={submitRejectReason}>
                {rejectReasonModal.saving ? 'Rejecting...' : 'Reject'}
              </button>
            </div>
          </div>
        </div>
      )}
      {editEmployeeModal.open && (
        <div className="modal-overlay" onClick={() => setEditEmployeeModal({ open: false, row: null, name: '', loginId: '', department: 'General', saving: false })}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Employee</h3>
            <div className="stack">
              <input
                type="text"
                placeholder="Employee name"
                value={editEmployeeModal.name}
                onChange={(e) => setEditEmployeeModal((old) => ({ ...old, name: e.target.value }))}
              />
              <input
                type="text"
                placeholder="Login ID"
                value={editEmployeeModal.loginId}
                onChange={(e) => setEditEmployeeModal((old) => ({ ...old, loginId: e.target.value }))}
              />
              <input
                type="text"
                placeholder="Department"
                value={editEmployeeModal.department}
                onChange={(e) => setEditEmployeeModal((old) => ({ ...old, department: e.target.value }))}
              />
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={editEmployeeModal.saving}
                onClick={() => setEditEmployeeModal({ open: false, row: null, name: '', loginId: '', department: 'General', saving: false })}
              >
                Cancel
              </button>
              <button type="button" disabled={editEmployeeModal.saving} onClick={submitEditEmployee}>
                {editEmployeeModal.saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
      {resetPasswordModal.open && (
        <div className="modal-overlay" onClick={() => setResetPasswordModal({ open: false, employeeId: '', employeeName: '', password: '', saving: false })}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Reset Password</h3>
            <p className="muted">Employee: {resetPasswordModal.employeeName}</p>
            <div className="stack">
              <input
                type="text"
                placeholder="New password"
                value={resetPasswordModal.password}
                onChange={(e) => setResetPasswordModal((old) => ({ ...old, password: e.target.value }))}
              />
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={resetPasswordModal.saving}
                onClick={() => setResetPasswordModal({ open: false, employeeId: '', employeeName: '', password: '', saving: false })}
              >
                Cancel
              </button>
              <button type="button" disabled={resetPasswordModal.saving} onClick={submitResetPassword}>
                {resetPasswordModal.saving ? 'Resetting...' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

function UserPage() {
  const cachedAttendance = readAttendanceCache(readValidToken(USER_KEY, 'user'))
  const [darkMode, setDarkMode] = useState(readDarkModePreference)
  const [token, setToken] = useState(() => readValidToken(USER_KEY, 'user'))
  const [sessionRefreshedAt, setSessionRefreshedAt] = useState(null)
  const [sessionExpiringSoon, setSessionExpiringSoon] = useState('')
  const [error, setError] = useState('')
  const [retryLabel, setRetryLabel] = useState('')
  const [retryAction, setRetryAction] = useState(null)
  const [message, setMessage] = useState('')
  const [employee, setEmployee] = useState(null)
  const [attendanceState, setAttendanceState] = useState(cachedAttendance.status || '')
  const [attendanceTimes, setAttendanceTimes] = useState({
    checkIn: cachedAttendance.checkIn || '',
    checkOut: cachedAttendance.checkOut || '',
  })
  const [cameraOn, setCameraOn] = useState(false)
  const [status, setStatus] = useState('Ready')
  const [manualModalOpen, setManualModalOpen] = useState(false)
  const [manualSubmitting, setManualSubmitting] = useState(false)
  const [manualCameraOn, setManualCameraOn] = useState(false)
  const [manualPhotoBlob, setManualPhotoBlob] = useState(null)
  const [manualPhotoPreview, setManualPhotoPreview] = useState('')
  const [manualModalNotice, setManualModalNotice] = useState({ type: '', text: '' })
  const [manualForm, setManualForm] = useState({
    requestType: 'outside_office',
    reason: 'Outside office geofence',
  })
  const [challengeInstruction, setChallengeInstruction] = useState('')
  const [popup, setPopup] = useState({ show: false, type: 'success', title: '', message: '' })
  const [geo, setGeo] = useState({ lat: '', lng: '', accuracy: '' })
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const canvasRef = useRef(null)
  const manualVideoRef = useRef(null)
  const manualCanvasRef = useRef(null)
  const manualStreamRef = useRef(null)
  const scanInFlightRef = useRef(false)
  const userRefreshInFlightRef = useRef(false)

  function clearRetryAction() {
    setRetryAction(null)
    setRetryLabel('')
  }

  async function attachManualStreamPreview() {
    const video = manualVideoRef.current
    const stream = manualStreamRef.current
    if (!video || !stream) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
    }
    try {
      await video.play()
    } catch {
      // browser may block autoplay until user interaction; keep stream attached
    }
  }

  function showPopup(type, title, text) {
    setPopup({ show: true, type, title, message: text })
    setTimeout(() => {
      setPopup((p) => ({ ...p, show: false }))
    }, 2600)
  }

  async function login(values) {
    setError('')
    try {
      const data = await apiFetch('/user/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login_id: values.login_id.toLowerCase(), password: values.password }),
      })
      localStorage.setItem(USER_KEY, data.token)
      setToken(data.token)
      setEmployee(data.employee)
      const cached = readAttendanceCache(data.token)
      setAttendanceState(cached.status || '')
      setAttendanceTimes({ checkIn: cached.checkIn || '', checkOut: cached.checkOut || '' })
      setStatus('Login successful')
      setMessage('Authenticated')
      clearRetryAction()
    } catch (err) {
      setError(err.message)
      if (isRetryableError(err)) {
        setRetryLabel('Retry login')
        setRetryAction(() => () => login(values))
      }
    }
  }

  async function refreshTodayAttendance(nextToken = token) {
    if (!nextToken) return
    try {
      const data = await apiFetch('/user/attendance_today', {}, nextToken)
      const nextStatus = String(data?.status || '').toLowerCase()
      setAttendanceState(nextStatus)
      const nextTimes = {
        checkIn: data?.check_in || '',
        checkOut: data?.check_out || '',
      }
      setAttendanceTimes(nextTimes)
      writeAttendanceCache(nextToken, {
        status: nextStatus,
        checkIn: nextTimes.checkIn,
        checkOut: nextTimes.checkOut,
      })
      clearRetryAction()
    } catch {
      setRetryLabel('Retry attendance status')
      setRetryAction(() => () => refreshTodayAttendance(nextToken))
    }
  }

  async function initFromToken() {
    if (!token) return
    const payload = decodeToken(token)
    if (!payload) {
      logout()
      return
    }
    try {
      setEmployee({
        name: payload.employee_name,
        login_id: payload.login_id,
        department: 'General',
        must_change_password: payload.must_change_password,
      })
      await refreshTodayAttendance(token)
    } catch {
      logout()
    }
  }

  useEffect(() => {
    initFromToken()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return
    const claims = decodeToken(token)
    if (!claims || String(claims.role || '').toLowerCase() !== 'user' || tokenRemainingMs(token) <= 0) {
      logout()
      setError('Session invalid. Please login again.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function startCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 480, max: 640 },
          height: { ideal: 360, max: 480 },
          frameRate: { ideal: 20, max: 24 },
          facingMode: 'user',
        },
        audio: false,
      })
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
      }
      await updateLocation()
      setCameraOn(true)
      setStatus('Camera started')
    } catch (err) {
      setError('Camera not accessible')
    }
  }

  function stopCamera() {
    streamRef.current?.getTracks()?.forEach((t) => t.stop())
    streamRef.current = null
    setCameraOn(false)
    setStatus('Camera stopped')
  }

  async function startManualCamera() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640, max: 960 },
          height: { ideal: 480, max: 720 },
          frameRate: { ideal: 24, max: 30 },
          facingMode: 'user',
        },
        audio: false,
      })
      manualStreamRef.current = stream
      setManualCameraOn(true)
      await attachManualStreamPreview()
      setError('')
    } catch {
      setManualCameraOn(false)
      setError('Unable to access camera for manual request')
    }
  }

  function stopManualCamera() {
    manualStreamRef.current?.getTracks()?.forEach((t) => t.stop())
    manualStreamRef.current = null
    if (manualVideoRef.current) {
      manualVideoRef.current.srcObject = null
    }
    setManualCameraOn(false)
  }

  useEffect(() => {
    return () => stopCamera()
  }, [])

  useEffect(() => {
    if (manualModalOpen) {
      setManualPhotoBlob(null)
      if (manualPhotoPreview) {
        URL.revokeObjectURL(manualPhotoPreview)
      }
      setManualPhotoPreview('')
      startManualCamera()
    } else {
      stopManualCamera()
    }

    return () => {
      stopManualCamera()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualModalOpen])

  useEffect(() => {
    if (manualModalOpen && manualCameraOn) {
      attachManualStreamPreview()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualModalOpen, manualCameraOn])

  useEffect(() => {
    if (!cameraOn || !token || employee?.must_change_password) return
    const kickoff = setTimeout(() => {
      checkInNow(true)
    }, 120)
    const timer = setInterval(() => {
      checkInNow(true)
    }, 250)
    return () => {
      clearTimeout(kickoff)
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraOn, token, employee?.must_change_password])

  useEffect(() => {
    applyThemePreference(darkMode)
    try {
      localStorage.setItem(UI_THEME_KEY, darkMode ? 'dark' : 'light')
    } catch {
      // no-op
    }
  }, [darkMode])

  async function updateLocation() {
    if (!navigator.geolocation) return
    await new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          setGeo({
            lat: String(pos.coords.latitude),
            lng: String(pos.coords.longitude),
            accuracy: String(pos.coords.accuracy || ''),
          })
          resolve()
        },
        () => resolve(),
        { enableHighAccuracy: true, timeout: 8000 }
      )
    })
  }

  async function changePassword() {
    if (!token) return
    if (!currentPassword || !newPassword) {
      setError('Current and new password are required')
      return
    }
    try {
      const data = await apiFetch('/user/change_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
      }, token)
      if (data.token) {
        localStorage.setItem(USER_KEY, data.token)
        setToken(data.token)
      }
      setEmployee(data.employee || employee)
      setCurrentPassword('')
      setNewPassword('')
      setMessage(data.message || 'Password updated')
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }

  async function checkInNow(silent = false) {
    if (!token) return
    if (!videoRef.current || !canvasRef.current || !cameraOn) {
      setError('Start camera first')
      return
    }
    if (scanInFlightRef.current) return
    scanInFlightRef.current = true

    try {
      setChallengeInstruction('Blink your eyes and move slightly to mark your attendance.')
      setStatus('Blink your eyes and move slightly to mark your attendance.')
      const canvas = canvasRef.current
      const video = videoRef.current
      const srcW = video.videoWidth || 640
      const srcH = video.videoHeight || 480
      const maxW = 420
      const scale = srcW > maxW ? maxW / srcW : 1
      canvas.width = Math.max(1, Math.round(srcW * scale))
      canvas.height = Math.max(1, Math.round(srcH * scale))
      const ctx = canvas.getContext('2d')
      const minScanMs = 2000
      const attemptGapMs = 420
      const startedAt = Date.now()
      let data = null
      let lastErr = null

      while (Date.now() - startedAt < minScanMs) {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.74))
          const formData = new FormData()
          formData.append('image', blob, 'scan.jpg')
          if (geo.lat && geo.lng) {
            formData.append('lat', geo.lat)
            formData.append('lng', geo.lng)
          }
          if (geo.accuracy) formData.append('accuracy', geo.accuracy)

          data = await apiFetch('/scan_attendance', {
            method: 'POST',
            body: formData,
          }, token)
        } catch (err) {
          lastErr = err
        }

        const remaining = minScanMs - (Date.now() - startedAt)
        if (remaining > 0) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(attemptGapMs, remaining)))
        }
      }

      if (!data) {
        if (lastErr) throw lastErr
        throw new Error('Blink your eyes and move slightly to mark your attendance, then retry.')
      }

      if (data?.status) {
        setAttendanceState(String(data.status).toLowerCase())
      }
      const nextTimes = {
        checkIn: data?.check_in || attendanceTimes.checkIn,
        checkOut: data?.check_out || attendanceTimes.checkOut,
      }
      setAttendanceTimes((old) => ({
        checkIn: data?.check_in || old.checkIn,
        checkOut: data?.check_out || old.checkOut,
      }))
      writeAttendanceCache(token, {
        status: String(data?.status || attendanceState || '').toLowerCase(),
        checkIn: nextTimes.checkIn,
        checkOut: nextTimes.checkOut,
      })

      const text = data.message || data.status || 'Attendance scanned'
      setStatus(text)
      setMessage('Attendance processed')
      setError('')
      setChallengeInstruction('')
      clearRetryAction()
      if (['checked_in', 'checked_out', 'already_recorded'].includes(String(data.status || ''))) {
        const title = data.status === 'already_recorded' ? 'Already Marked' : 'Attendance Marked'
        showPopup('success', title, text)
        await refreshTodayAttendance(token)
        stopCamera()
      }
    } catch (err) {
      setError(err.message)
      if (isRetryableError(err)) {
        setRetryLabel('Retry attendance scan')
        setRetryAction(() => () => checkInNow(silent))
      }
      if (!silent) {
        showPopup('error', 'Scan Failed', err.message)
      }
    } finally {
      scanInFlightRef.current = false
    }
  }

  async function captureManualSnapshot() {
    if (!manualVideoRef.current || !manualCanvasRef.current || !manualCameraOn) {
      throw new Error('Start camera in popup and capture image')
    }
    const canvas = manualCanvasRef.current
    const video = manualVideoRef.current
    const srcW = video.videoWidth || 640
    const srcH = video.videoHeight || 480
    canvas.width = srcW
    canvas.height = srcH
    const ctx = canvas.getContext('2d')
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9))
    if (!blob) {
      throw new Error('Unable to capture camera image')
    }
    if (manualPhotoPreview) {
      URL.revokeObjectURL(manualPhotoPreview)
    }
    setManualPhotoBlob(blob)
    setManualPhotoPreview(URL.createObjectURL(blob))
    stopManualCamera()
    return blob
  }

  function retakeManualSnapshot() {
    if (manualPhotoPreview) {
      URL.revokeObjectURL(manualPhotoPreview)
    }
    setManualPhotoPreview('')
    setManualPhotoBlob(null)
    startManualCamera()
  }

  function openManualRequestModal() {
    setError('')
    setManualModalNotice({ type: '', text: '' })
    setManualModalOpen(true)
  }

  function closeManualRequestModal() {
    if (manualSubmitting) return
    setManualModalOpen(false)
  }

  async function submitManualRequest() {
    if (!token) return
    setManualModalNotice({ type: '', text: '' })
    const reasonText = String(manualForm.reason || '').trim()
    if (!reasonText) {
      setManualModalNotice({ type: 'error', text: 'Reason is required for manual request' })
      return
    }
    if (!manualPhotoBlob) {
      setManualModalNotice({ type: 'error', text: 'Please capture image in the popup before submitting' })
      return
    }

    setManualSubmitting(true)
    try {
      const formData = new FormData()
      formData.append('reason', reasonText)
      formData.append('request_type', manualForm.requestType)
      formData.append('work_mode', manualForm.requestType === 'wfh' ? 'wfh' : 'office')
      if (geo.lat && geo.lng) {
        formData.append('lat', geo.lat)
        formData.append('lng', geo.lng)
      }
      if (geo.accuracy) formData.append('accuracy', geo.accuracy)
      formData.append('image', manualPhotoBlob, 'manual_request.jpg')

      const data = await apiFetch('/manual_attendance_request', {
        method: 'POST',
        body: formData,
      }, token)
      setManualModalNotice({ type: 'success', text: data.message || 'Manual request submitted' })
      setStatus(data.message || 'Manual request submitted')
      setMessage('Manual request sent to admin')
      setManualPhotoBlob(null)
      if (manualPhotoPreview) {
        URL.revokeObjectURL(manualPhotoPreview)
      }
      setManualPhotoPreview('')
      setTimeout(() => {
        setManualModalOpen(false)
      }, 900)
    } catch (err) {
      const text = String(err?.message || 'Failed to submit manual request')
      if (/already\s+marked|attendance\s+already\s+marked/i.test(text)) {
        setManualModalNotice({ type: 'error', text: 'Attendance already marked for today. Manual request not allowed.' })
      } else {
        setManualModalNotice({ type: 'error', text })
      }
    } finally {
      setManualSubmitting(false)
    }
  }

  function logout() {
    stopCamera()
    stopManualCamera()
    localStorage.removeItem(USER_KEY)
    setToken('')
    setEmployee(null)
    setAttendanceState('')
    setAttendanceTimes({ checkIn: '', checkOut: '' })
    setStatus('Logged out')
    setChallengeInstruction('')
    clearRetryAction()
  }

  useEffect(() => {
    if (!token) {
      setSessionExpiringSoon('')
      return undefined
    }
    const apply = () => {
      const remainingMs = tokenRemainingMs(token)
      if (remainingMs > 0 && remainingMs <= SESSION_EXPIRING_SOON_MS) {
        const mins = Math.max(1, Math.ceil(remainingMs / 60000))
        setSessionExpiringSoon(`Session expiring soon (${mins} min left)`)
      } else {
        setSessionExpiringSoon('')
      }
    }
    apply()
    const id = setInterval(apply, SESSION_REFRESH_CHECK_MS)
    return () => clearInterval(id)
  }, [token])

  async function refreshUserSessionIfNeeded(nextToken = token) {
    if (!nextToken) return
    if (userRefreshInFlightRef.current) return
    const remaining = tokenRemainingMs(nextToken)
    if (remaining > SESSION_REFRESH_BEFORE_MS) return

    userRefreshInFlightRef.current = true
    try {
      const data = await apiFetch('/auth/refresh_user', { method: 'POST' }, nextToken)
      const newToken = String(data?.token || '')
      if (newToken && newToken !== nextToken) {
        localStorage.setItem(USER_KEY, newToken)
        setToken(newToken)
        setSessionRefreshedAt(Date.now())
        writeAttendanceCache(newToken, {
          status: String(attendanceState || '').toLowerCase(),
          checkIn: attendanceTimes.checkIn || '',
          checkOut: attendanceTimes.checkOut || '',
        })
      }
    } catch (err) {
      const text = String(err?.message || '').toLowerCase()
      if (text.includes('invalid token') || text.includes('please log in again') || text.includes('unauthorized')) {
        logout()
      }
    } finally {
      userRefreshInFlightRef.current = false
    }
  }

  useEffect(() => {
    if (!token) return undefined
    refreshUserSessionIfNeeded(token)
    const id = setInterval(() => {
      refreshUserSessionIfNeeded(token)
    }, SESSION_REFRESH_CHECK_MS)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, attendanceState, attendanceTimes.checkIn, attendanceTimes.checkOut])

  if (!token) {
    return (
      <main className="page center">
        <LoginCard
          title="Employee Login"
          message={error || 'Use your employee login credentials.'}
          fields={[
            { name: 'login_id', placeholder: 'Login ID', autoComplete: 'username' },
            { name: 'password', placeholder: 'Password', type: 'password', autoComplete: 'current-password' },
          ]}
          onSubmit={login}
        />
      </main>
    )
  }

  const locationReady = Boolean(geo.lat && geo.lng)
  const statusText = String(status || '')
  const todayCheckedIn = (
    ['checked_in', 'checked_out', 'already_recorded'].includes(String(attendanceState || '').toLowerCase())
    || Boolean(attendanceTimes.checkIn || attendanceTimes.checkOut)
    || /already\s+marked|entry\s+marked|check[_\s-]?in|check[_\s-]?out|bye\s+bye/i.test(statusText)
  )
  const primaryButtonLabel = 'Mark Attendance'
  const statusTimeMatch = statusText.match(/\b(\d{1,2}:\d{2}(?::\d{2})?\s?(?:AM|PM|am|pm)?)\b/)
  const checkedInAtText = attendanceTimes.checkIn || (statusTimeMatch ? statusTimeMatch[1] : '--')
  const checkedOutAtText = attendanceTimes.checkOut || ''
  const geofenceDisabled = /location\s+verification\s+is\s+disabled\s+by\s+admin|geofence_disabled|geofence\s+is\s+disabled/i.test(`${status} ${error} ${message}`)
  const geofenceOutside = /outside\s+office\s+geofence|outside\s+geofence/i.test(`${status} ${error} ${message}`)
  const attendanceStatusLabel = todayCheckedIn
    ? (checkedOutAtText
      ? `Checked In at ${checkedInAtText} • Checked Out at ${checkedOutAtText}`
      : `Checked In at ${checkedInAtText}`)
    : 'Not Checked In'
  const cameraStatusLabel = cameraOn ? 'Camera Active' : 'Camera Stopped'
  const locationStatusLabel = geofenceDisabled
    ? 'Location Disabled by Admin'
    : (geofenceOutside ? 'Outside Geofence' : 'Inside Office')

  return (
    <main className="page attendance-shell">
      <section className="attendance-topbar card">
        <div className="attendance-topbar-left">
          <h2>Employee Check-In</h2>
        </div>
        <div className="attendance-topbar-right">
          <p className="muted small">Name: {employee?.name || '-'} • Username: {employee?.login_id || '-'}</p>
          <p className="muted small">
            Session auto-refresh: {sessionRefreshedAt ? `Last refresh at ${new Date(sessionRefreshedAt).toLocaleTimeString()}` : 'Enabled (waiting for next cycle)'}
          </p>
          {!!sessionExpiringSoon && <p className="error">{sessionExpiringSoon}</p>}
          <div className="attendance-status-badges">
            <span className={`status-badge ${cameraOn ? 'ok' : ''}`}>Camera: {cameraOn ? 'Ready' : 'Off'}</span>
            <span className={`status-badge ${geofenceDisabled ? '' : (locationReady ? 'ok' : '')}`}>
              Location: {geofenceDisabled ? 'Disabled by Admin' : (locationReady ? 'Ready' : 'Missing')}
            </span>
          </div>
        </div>
      </section>

      <section className="card user-card attendance-main-card">
        {!!message && <div className="success">{message}</div>}
        {employee?.must_change_password && (
          <div className="error">Password change required before attendance scan.</div>
        )}

        <div className="attendance-body-grid">
          <div className="attendance-left-column">
            <div className="attendance-section">
              <h3>Today Status</h3>
              <div className="status-grid">
                <div className={`status-card ${todayCheckedIn ? 'ok' : 'warn'}`}>
                  <span className="status-label">Attendance Status</span>
                  <strong>{attendanceStatusLabel}</strong>
                </div>
                <div className={`status-card ${cameraOn ? 'ok' : 'warn'}`}>
                  <span className="status-label">Camera Status</span>
                  <strong>{cameraStatusLabel}</strong>
                </div>
                <div className={`status-card ${(geofenceOutside || geofenceDisabled) ? 'warn' : 'ok'}`}>
                  <span className="status-label">Location Status</span>
                  <strong>{locationStatusLabel}</strong>
                </div>
              </div>
            </div>

            <div className="attendance-section">
              <h3>Secondary Actions</h3>
              <div className="row attendance-secondary-actions">
                {!cameraOn && <button className="ghost" onClick={startCamera}>Start Camera</button>}
                {cameraOn && <button className="ghost" onClick={stopCamera}>Stop Camera</button>}
                <button className="ghost" onClick={updateLocation}>Refresh Location</button>
              </div>
              <h3 className="tertiary-title">Tertiary Actions</h3>
              <div className="row attendance-extra-actions">
                <button className="ghost tertiary-btn" onClick={openManualRequestModal}>Manual Request</button>
                <button className="ghost tertiary-btn" onClick={() => setDarkMode((v) => !v)}>{darkMode ? 'Dark Mode: On' : 'Dark Mode: Off'}</button>
                <button className="ghost tertiary-btn" onClick={logout}>Logout</button>
              </div>
            </div>

            <div className="attendance-section">
              <h3>Info</h3>
              <div className="status-badge-row">
                <span className={`mini-badge ${todayCheckedIn ? 'ok' : 'warn'}`}>{attendanceStatusLabel}</span>
                <span className={`mini-badge ${cameraOn ? 'ok' : 'warn'}`}>{cameraStatusLabel}</span>
                <span className={`mini-badge ${geofenceOutside ? 'warn' : 'ok'}`}>{locationStatusLabel}</span>
              </div>
              {!!challengeInstruction && <p className="status-text">Challenge: {challengeInstruction}</p>}
              <p className="muted small">Location: {geo.lat && geo.lng ? `${Number(geo.lat).toFixed(5)}, ${Number(geo.lng).toFixed(5)} (±${Math.round(Number(geo.accuracy || 0))}m)` : 'Not captured'}</p>
            </div>

            {!!error && (
              <div className="error row between">
                <span>{error}</span>
                {!!retryAction && (
                  <button type="button" className="ghost" onClick={retryAction}>{retryLabel || 'Retry'}</button>
                )}
              </div>
            )}
          </div>

          <div className="attendance-right-column">
            <div className="attendance-section">
              <h3>Camera Preview</h3>
              <div className="camera-preview-shell">
                <div className="camera-preview-head">
                  <span className={`camera-dot ${cameraOn ? 'on' : 'off'}`} aria-hidden="true" />
                  <span className="muted small">{cameraOn ? 'Camera active' : 'Camera off'}</span>
                </div>
                <div className="camera-preview-box">
                  <video ref={videoRef} autoPlay playsInline className="preview" />
                  {!cameraOn && <div className="camera-placeholder">Camera not started</div>}
                </div>
              </div>
            </div>

            <canvas ref={canvasRef} className="hidden" />

            <div className="attendance-section">
              <h3>Primary Action</h3>
              <div className="row attendance-primary-row">
                <button
                  className={`attendance-primary-btn ${(!cameraOn || !locationReady) ? 'ui-disabled' : ''}`}
                  onClick={checkInNow}
                  disabled={!cameraOn || employee?.must_change_password}
                >
                  {primaryButtonLabel}
                </button>
              </div>
            </div>

            {popup.show && (
              <div className={`scan-popup ${popup.type}`}>
                <strong>{popup.title}</strong>
                <div>{popup.message}</div>
              </div>
            )}

            {manualModalOpen && (
              <div className="modal-overlay" onClick={closeManualRequestModal}>
                <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                  <h3>Manual Attendance Request</h3>
                  <p className="muted small">Please provide all required details. Camera image is mandatory.</p>
                  {!!manualModalNotice.text && (
                    <div className={manualModalNotice.type === 'success' ? 'success' : 'error'}>{manualModalNotice.text}</div>
                  )}
                  <div className="stack">
                    <label className="small">Request Type *</label>
                    <select
                      value={manualForm.requestType}
                      onChange={(e) => setManualForm((old) => ({
                        ...old,
                        requestType: e.target.value,
                        reason: e.target.value === 'wfh' ? 'WFH - unable to visit office' : old.reason,
                      }))}
                    >
                      <option value="outside_office">Outside Office</option>
                      <option value="wfh">WFH</option>
                      <option value="other">Other</option>
                    </select>

                    <label className="small">Reason *</label>
                    <textarea
                      value={manualForm.reason}
                      onChange={(e) => setManualForm((old) => ({ ...old, reason: e.target.value }))}
                      placeholder="Write reason for manual request"
                      rows={4}
                      required
                    />

                    <div className="manual-camera-wrap">
                      {manualPhotoPreview ? (
                        <>
                          <img src={manualPhotoPreview} alt="Captured manual request" className="manual-photo-preview" />
                          <p className="small muted">Captured image ready for submission.</p>
                          <div className="row">
                            <button type="button" className="ghost" onClick={retakeManualSnapshot}>Retake Image</button>
                          </div>
                        </>
                      ) : (
                        <>
                          {manualCameraOn ? (
                            <video ref={manualVideoRef} autoPlay playsInline muted className="manual-camera-preview" />
                          ) : (
                            <div className="manual-camera-placeholder">Camera is off. Start camera and capture image.</div>
                          )}
                          <p className="small muted">Capture image in popup before submit.</p>
                          <div className="row">
                            {!manualCameraOn && <button type="button" className="ghost" onClick={startManualCamera}>Start Camera</button>}
                            {manualCameraOn && <button type="button" className="ghost" onClick={stopManualCamera}>Stop Camera</button>}
                            <button type="button" className="ghost" onClick={captureManualSnapshot} disabled={!manualCameraOn}>Capture Image</button>
                          </div>
                        </>
                      )}
                      <canvas ref={manualCanvasRef} className="hidden" />
                    </div>

                    <div className="row modal-actions">
                      <button className="ghost" type="button" onClick={closeManualRequestModal} disabled={manualSubmitting}>Cancel</button>
                      <button type="button" onClick={submitManualRequest} disabled={manualSubmitting || !manualPhotoBlob}>
                        {manualSubmitting ? 'Submitting...' : 'Submit Request'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {employee?.must_change_password && (
          <div className="card nested-card">
            <h3>Change Password</h3>
            <div className="row">
              <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              <input type="password" placeholder="New password (letters + numbers)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
              <button onClick={changePassword}>Update Password</button>
            </div>
          </div>
        )}
      </section>
    </main>
  )
}

function RoleRouteGuard({ storageKey, role, children }) {
  const rawToken = (() => {
    try {
      return localStorage.getItem(storageKey) || ''
    } catch {
      return ''
    }
  })()
  const validToken = readValidToken(storageKey, role)

  if (rawToken && !validToken) {
    return <Navigate to={role === 'admin' ? '/admin' : '/user'} replace />
  }
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route
        path="/admin"
        element={(
          <RoleRouteGuard storageKey={ADMIN_KEY} role="admin">
            <AdminPage />
          </RoleRouteGuard>
        )}
      />
      <Route
        path="/user"
        element={(
          <RoleRouteGuard storageKey={USER_KEY} role="user">
            <UserPage />
          </RoleRouteGuard>
        )}
      />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  )
}
