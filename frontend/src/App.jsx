import { useEffect, useMemo, useRef, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { apiFetch } from './api'

const ADMIN_KEY = 'fa_admin_token'
const USER_KEY = 'fa_user_token'
const USER_ATTENDANCE_CACHE_KEY = 'fa_user_attendance_cache'
const UI_THEME_KEY = 'fa_ui_theme'
const TASK_SYNC_EVENT_KEY = 'fa_task_sync_event'
const TASK_SYNC_LOCAL_EVENT = 'fa_task_sync_local_event'
const SESSION_REFRESH_CHECK_MS = 60 * 1000
const SESSION_REFRESH_BEFORE_MS = 15 * 60 * 1000
const SESSION_EXPIRING_SOON_MS = 5 * 60 * 1000
const GEO_TIMEOUT_MS = 10000
const GEO_MAX_AGE_MS = 0
const GEO_RETRY_COUNT = 1
const APP_TIME_ZONE = 'Asia/Kolkata'
const COMPLETED_VISIBLE_MS = 5 * 60 * 1000
const PASSWORD_MIN_LENGTH = 6

function validatePasswordInput(password, label = 'Password') {
  const text = String(password || '')
  if (text.length < PASSWORD_MIN_LENGTH) {
    return `${label} must be at least ${PASSWORD_MIN_LENGTH} characters`
  }
  if (!/\d/.test(text)) {
    return `${label} must include at least one number`
  }
  return ''
}

function createTaskBlock(id = Date.now()) {
  return { id, title: '', description: '' }
}

function publishTaskSync(source = 'unknown') {
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
      checkIn: '',
      checkOut: '',
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

function dateKeyOffsetFromToday(offsetDays = 0) {
  const n = Number(offsetDays || 0)
  const d = new Date(Date.now() + (n * 24 * 60 * 60 * 1000))
  return formatDateInput(d)
}

function dateKeyShift(baseDateKey = '', offsetDays = 0) {
  const text = String(baseDateKey || '').trim()
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return dateKeyOffsetFromToday(offsetDays)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  d.setDate(d.getDate() + Number(offsetDays || 0))
  return formatDateInput(d)
}

function formatWeekdayFromDateKey(dateKey = '') {
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

function formatTimeInIST(value) {
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

function formatTime12Hour(value) {
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

function parseBackendDateMs(value) {
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

function dateKeyInIST(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  const ms = parseBackendDateMs(text)
  if (!Number.isFinite(ms)) return text.slice(0, 10)
  return formatDateInput(new Date(ms))
}

function formatAttendanceTimeFromUtc(utcIso, fallback = '', dateHint = '') {
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

function normalizeAttendanceRow(row = {}) {
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

function getTaskReferenceMs(task = {}) {
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

function isTaskWithinLastDays(task = {}, days = 30) {
  const refMs = getTaskReferenceMs(task)
  if (!Number.isFinite(refMs)) return false
  const rangeMs = Math.max(1, Number(days || 30)) * 24 * 60 * 60 * 1000
  return refMs >= (Date.now() - rangeMs)
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

function readValidToken(storageKey, expectedRole, options = {}) {
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

function isRetryableError(err) {
  const text = String(err?.message || '').toLowerCase()
  return !!err?.retryable
    || text.includes('temporarily unavailable')
    || text.includes('try again')
    || text.includes('unable to connect to server')
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
  const [tasks, setTasks] = useState([])
  const [taskSearch, setTaskSearch] = useState('')
  const [taskDeptFilter, setTaskDeptFilter] = useState('all')
  const [taskStatusFilter, setTaskStatusFilter] = useState('all')
  const [taskShiftFilter, setTaskShiftFilter] = useState('all')
  const [taskWorkspaceView, setTaskWorkspaceView] = useState('list')
  const [taskTableExpanded, setTaskTableExpanded] = useState(false)
  const [taskCardFilter, setTaskCardFilter] = useState('all')
  const [taskCardDayScope, setTaskCardDayScope] = useState('all')
  const [selectedTaskEmployeeId, setSelectedTaskEmployeeId] = useState('')
  const [taskDrawerOpen, setTaskDrawerOpen] = useState(false)
  const [taskDetailOpen, setTaskDetailOpen] = useState(false)
  const [activeTask, setActiveTask] = useState(null)
  const [taskAssignLoading, setTaskAssignLoading] = useState(false)
  const [taskForm, setTaskForm] = useState({
    taskBlocks: [createTaskBlock(1)],
    startDate: formatDateInput(),
    dueDate: '',
    assignedBy: 'admin',
    priority: 'medium',
    tags: '',
    departmentTag: 'General',
    shiftTag: 'day',
    recurring: false,
    assignToIds: [],
    attachments: [],
  })
  const [geofence, setGeofence] = useState(null)
  const [geofenceInitial, setGeofenceInitial] = useState(null)
  const [cameraStatus, setCameraStatus] = useState(null)
  const [settingsFeedback, setSettingsFeedback] = useState({ type: '', text: '' })
  const [settingsLastUpdated, setSettingsLastUpdated] = useState(null)
  const [geofenceSaving, setGeofenceSaving] = useState(false)
  const [geofenceTesting, setGeofenceTesting] = useState(false)
  const [geofenceFetching, setGeofenceFetching] = useState(false)
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
  const [employeeTasksModal, setEmployeeTasksModal] = useState({
    open: false,
    employeeId: '',
    employeeName: '',
  })
  const [employeeAttendanceModal, setEmployeeAttendanceModal] = useState({
    open: false,
    employeeId: '',
    employeeName: '',
    dayRange: '30',
    fromDate: dateKeyOffsetFromToday(-29),
    toDate: formatDateInput(),
    rows: [],
    loading: false,
  })
  const [teamReportModal, setTeamReportModal] = useState({
    open: false,
    date: formatDateInput(),
  })
  const [manualAttendanceModal, setManualAttendanceModal] = useState({
    open: false,
    employeeId: '',
    date: formatDateInput(),
    checkIn: '',
    checkOut: '',
    reason: '',
    saving: false,
  })
  const [lastDayTaskModal, setLastDayTaskModal] = useState({
    open: false,
    title: 'Last Day Tasks',
    date: dateKeyOffsetFromToday(-1),
    rows: [],
  })
  const [tableActionBusy, setTableActionBusy] = useState({})
  const [enrollmentCameraOn, setEnrollmentCameraOn] = useState(false)
  const [enrollmentCapturing, setEnrollmentCapturing] = useState(false)
  const [enrollmentProgress, setEnrollmentProgress] = useState(0)
  const [addEmployeeFeedback, setAddEmployeeFeedback] = useState({ type: '', text: '' })
  const [adminBellToast, setAdminBellToast] = useState({ show: false, title: '', message: '', type: 'info' })
  const enrollmentVideoRef = useRef(null)
  const enrollmentCanvasRef = useRef(null)
  const enrollmentStreamRef = useRef(null)
  const adminRefreshInFlightRef = useRef(false)
  const adminBellToastTimerRef = useRef(null)
  const adminTaskNotifyRef = useRef({ initialized: false, tasks: {} })

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
    for (const t of (tasks || [])) {
      const dept = String(t?.department_tag || '').trim()
      if (dept) set.add(dept)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [employees, tasks])

  const taskWorkspaceEmployees = useMemo(() => {
    const base = Array.isArray(employees) ? employees : []
    const byId = new Map(base.map((e) => [String(e?.id || ''), e]))

    for (const t of (tasks || [])) {
      const employeeId = String(t?.assigned_to || '').trim()
      if (!employeeId || byId.has(employeeId)) continue
      const displayName = String(t?.assigned_to_name || '').trim()
      const department = String(t?.department_tag || '').trim() || 'General'
      byId.set(employeeId, {
        id: employeeId,
        name: displayName || `Inactive User (${employeeId})`,
        login_id: employeeId,
        department,
        status: 'inactive',
      })
    }

    return Array.from(byId.values())
  }, [employees, tasks])

  function normalizeTaskStatusForBoard(task) {
    const raw = String(task?.status || '').toLowerCase()
    const now = Date.now()
    const deadlineMs = new Date(task?.deadline || '').getTime()
    if (raw === 'completed') return 'completed'
    if (raw === 'approved') return 'approved'
    if (raw === 'review') return 'review'
    if ((raw === 'overdue') || (Number.isFinite(deadlineMs) && deadlineMs < now && raw !== 'completed' && raw !== 'approved')) return 'overdue'
    if (raw === 'in_progress') return 'in_progress'
    return 'not_started'
  }

  function isDoneTaskStatus(status) {
    return status === 'completed' || status === 'approved'
  }

  function isChecklistItemDone(item) {
    return !!(item?.done ?? item?.completed)
  }

  const taskStats = useMemo(() => {
    const all = Array.isArray(tasks) ? tasks : []
    const completed = all.filter((t) => isDoneTaskStatus(normalizeTaskStatusForBoard(t))).length
    const inProgress = all.filter((t) => normalizeTaskStatusForBoard(t) === 'in_progress').length
    const pending = all.filter((t) => normalizeTaskStatusForBoard(t) === 'not_started').length
    const overdue = all.filter((t) => normalizeTaskStatusForBoard(t) === 'overdue').length
    const activeEmployees = new Set(all.filter((t) => !isDoneTaskStatus(normalizeTaskStatusForBoard(t))).map((t) => String(t.assigned_to || ''))).size
    const today = formatDateInput()
    const todayTasks = all.filter((t) => dateKeyInIST(t?.start_date || t?.created_at || t?.updated_at || t?.deadline) === today)
    const pendingToday = todayTasks.filter((t) => {
      const status = normalizeTaskStatusForBoard(t)
      return status === 'not_started' || status === 'in_progress' || status === 'review'
    }).length
    const overdueToday = todayTasks.filter((t) => normalizeTaskStatusForBoard(t) === 'overdue').length
    const doneToday = todayTasks.filter((t) => isDoneTaskStatus(normalizeTaskStatusForBoard(t))).length
    const deadlinesToday = all.filter((t) => {
      if (isDoneTaskStatus(normalizeTaskStatusForBoard(t))) return false
      return dateKeyInIST(t?.deadline) === today
    }).length
    const productivityPct = all.length ? Math.round((completed / all.length) * 100) : 0
    return {
      totalEmployees: employees.length,
      totalTasks: todayTasks.length,
      completed,
      inProgress,
      pending: pendingToday,
      overdue: overdueToday,
      doneToday,
      productivityPct,
      activeEmployees,
      deadlinesToday,
      totalTasksAll: all.length,
      pendingAll: pending,
      overdueAll: overdue,
    }
  }, [employees.length, tasks])

  const taskLastDayStats = useMemo(() => {
    const all = Array.isArray(tasks) ? tasks : []
    const lastDay = dateKeyOffsetFromToday(-1)
    const rows = all.filter((t) => dateKeyInIST(t?.start_date || t?.created_at || t?.updated_at || t?.deadline) === lastDay)
    const pending = rows.filter((t) => {
      const status = normalizeTaskStatusForBoard(t)
      return status === 'not_started' || status === 'in_progress' || status === 'review'
    }).length
    const overdue = rows.filter((t) => normalizeTaskStatusForBoard(t) === 'overdue').length
    const done = rows.filter((t) => isDoneTaskStatus(normalizeTaskStatusForBoard(t))).length
    return {
      date: lastDay,
      total: rows.length,
      pending,
      overdue,
      done,
    }
  }, [tasks])

  const tasksByEmployeeId = useMemo(() => {
    const grouped = {}
    for (const t of (tasks || [])) {
      const key = String(t.assigned_to || '')
      if (!key) continue
      if (!grouped[key]) grouped[key] = []
      grouped[key].push(t)
    }
    Object.keys(grouped).forEach((key) => {
      grouped[key].sort((a, b) => String(a.deadline || '').localeCompare(String(b.deadline || '')))
    })
    return grouped
  }, [tasks])

  const employeeTaskMetrics = useMemo(() => {
    const map = {}
    for (const e of (employees || [])) {
      const rows = tasksByEmployeeId[String(e.id || '')] || []
      const active = rows.filter((t) => !isDoneTaskStatus(normalizeTaskStatusForBoard(t))).length
      const done = rows.filter((t) => isDoneTaskStatus(normalizeTaskStatusForBoard(t))).length
      const overdue = rows.filter((t) => normalizeTaskStatusForBoard(t) === 'overdue').length
      const productivity = rows.length ? Math.round((done / rows.length) * 100) : 0
      map[String(e.id || '')] = { active, done, overdue, productivity }
    }
    return map
  }, [employees, tasksByEmployeeId])

  const taskShiftOptions = useMemo(() => {
    const set = new Set(['day'])
    for (const t of (tasks || [])) {
      const shift = String(t.shift_tag || '').trim().toLowerCase()
      if (shift) set.add(shift)
    }
    return Array.from(set)
  }, [tasks])

  const filteredTaskEmployees = useMemo(() => {
    const query = taskSearch.trim().toLowerCase()
    return (taskWorkspaceEmployees || []).filter((e) => {
      const deptOk = taskDeptFilter === 'all' || String(e.department || 'General') === taskDeptFilter
      if (!deptOk) return false
      const nameOk = !query
        || String(e.name || '').toLowerCase().includes(query)
        || String(e.login_id || '').toLowerCase().includes(query)
      if (!nameOk) return false

      const rows = tasksByEmployeeId[String(e.id || '')] || []

      const shiftOk = taskShiftFilter === 'all' || rows.some((t) => String(t.shift_tag || '').toLowerCase() === taskShiftFilter)
      if (!shiftOk && taskShiftFilter !== 'all') return false

      if (taskStatusFilter === 'all') return true
      return rows.some((t) => normalizeTaskStatusForBoard(t) === taskStatusFilter)
    })
  }, [taskWorkspaceEmployees, taskDeptFilter, taskSearch, taskShiftFilter, taskStatusFilter, tasksByEmployeeId])

  useEffect(() => {
    if (!selectedTaskEmployeeId && filteredTaskEmployees.length) {
      setSelectedTaskEmployeeId(String(filteredTaskEmployees[0].id || ''))
    }
    if (selectedTaskEmployeeId && !filteredTaskEmployees.some((e) => String(e.id) === String(selectedTaskEmployeeId))) {
      setSelectedTaskEmployeeId(String(filteredTaskEmployees[0]?.id || ''))
    }
  }, [filteredTaskEmployees, selectedTaskEmployeeId])

  const selectedTaskEmployee = useMemo(
    () => (taskWorkspaceEmployees || []).find((e) => String(e.id) === String(selectedTaskEmployeeId)) || null,
    [taskWorkspaceEmployees, selectedTaskEmployeeId],
  )

  const selectedEmployeeTasks = useMemo(
    () => tasksByEmployeeId[String(selectedTaskEmployeeId || '')] || [],
    [tasksByEmployeeId, selectedTaskEmployeeId],
  )

  const visibleTaskRows = useMemo(() => {
    const rows = Array.isArray(tasks) ? tasks : []
    const today = formatDateInput()
    const lastDay = dateKeyOffsetFromToday(-1)
    return rows.filter((task) => {
      const status = normalizeTaskStatusForBoard(task)
      const taskDate = dateKeyInIST(task?.start_date || task?.created_at || task?.updated_at || task?.deadline)

      if (taskCardDayScope === 'today' && taskDate !== today) return false
      if (taskCardDayScope === 'last_day' && taskDate !== lastDay) return false

      if (taskStatusFilter === 'approved') {
        if (status !== 'approved') return false
      } else if (status === 'approved') {
        return false
      }

      if (taskCardFilter === 'pending') return status === 'not_started' || status === 'in_progress' || status === 'review'
      if (taskCardFilter === 'overdue') return status === 'overdue'
      if (taskCardFilter === 'done') return isDoneTaskStatus(status)
      return true
    })
  }, [tasks, taskStatusFilter, taskCardFilter, taskCardDayScope])

  const employeeModalTasks = useMemo(() => {
    const employeeId = String(employeeTasksModal.employeeId || '')
    if (!employeeId) return []
    const rows = tasksByEmployeeId[employeeId] || []
    return rows.filter((task) => {
      if (!isTaskWithinLastDays(task, 30)) return false
      if (taskStatusFilter === 'approved') return normalizeTaskStatusForBoard(task) === 'approved'
      return normalizeTaskStatusForBoard(task) !== 'approved'
    })
  }, [employeeTasksModal.employeeId, tasksByEmployeeId, taskStatusFilter])

  const selectedEmployeeTaskStats = useMemo(() => {
    const rows = Array.isArray(selectedEmployeeTasks) ? selectedEmployeeTasks : []
    const total = rows.length
    const overdue = rows.filter((t) => normalizeTaskStatusForBoard(t) === 'overdue').length
    const pending = rows.filter((t) => normalizeTaskStatusForBoard(t) === 'not_started').length
    const done = rows.filter((t) => isDoneTaskStatus(normalizeTaskStatusForBoard(t))).length
    const active = rows.filter((t) => !isDoneTaskStatus(normalizeTaskStatusForBoard(t))).length
    const productivityPct = total ? Math.round((done / total) * 100) : 0
    const today = formatDateInput()
    const deadlinesToday = rows.filter((t) => {
      if (isDoneTaskStatus(normalizeTaskStatusForBoard(t))) return false
      return dateKeyInIST(t?.deadline) === today
    }).length
    return {
      total,
      active,
      done,
      overdue,
      pending,
      productivityPct,
      deadlinesToday,
    }
  }, [selectedEmployeeTasks])

  const selectedEmployeeHeaderSummary = useMemo(() => {
    const rows = Array.isArray(selectedEmployeeTasks) ? selectedEmployeeTasks : []
    const activeTasks = rows.filter((t) => {
      const status = normalizeTaskStatusForBoard(t)
      return !isDoneTaskStatus(status) && status !== 'review'
    }).length
    const pendingApproval = rows.filter((t) => normalizeTaskStatusForBoard(t) === 'review').length
    const firstShift = rows.find((t) => String(t.shift_tag || '').trim())?.shift_tag || 'morning'
    const shiftLabel = String(firstShift || 'morning').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
    return {
      activeTasks,
      pendingApproval,
      shiftLabel,
    }
  }, [selectedEmployeeTasks])

  const activityFeed = useMemo(() => {
    const today = formatDateInput()
    return [...selectedEmployeeTasks]
      .filter((task) => !/checklist/i.test(String(task?.comment || '')))
      .filter((task) => {
        const when = task?.updated_at || task?.approved_at || task?.completed_at || task?.created_at
        return dateKeyInIST(when) === today
      })
      .sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')))
  }, [selectedEmployeeTasks])

  const drawerAssignedEmployee = useMemo(
    () => (employees || []).find((e) => String(e.id) === String(taskForm.assignToIds?.[0] || '')) || null,
    [employees, taskForm.assignToIds],
  )

  const drawerAssignedSummary = useMemo(() => {
    const employeeId = String(drawerAssignedEmployee?.id || '')
    const metric = employeeTaskMetrics[employeeId] || { active: 0 }
    const rows = tasksByEmployeeId[employeeId] || []
    const shiftRaw = String(rows[0]?.shift_tag || taskForm.shiftTag || 'morning').toLowerCase()
    const shift = shiftRaw.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())

    const attendanceRow = (attendance || []).find(
      (a) => String(a.employee_name || '').trim().toLowerCase() === String(drawerAssignedEmployee?.name || '').trim().toLowerCase(),
    )
    const todayStatus = (() => {
      const status = String(attendanceRow?.status || '').toLowerCase()
      if (status === 'checked_in' || status === 'checked_out') return 'Present'
      if (status === 'absent') return 'Absent'
      return 'Unknown'
    })()

    return {
      activeTasks: Number(metric.active || 0),
      shift,
      todayStatus,
    }
  }, [drawerAssignedEmployee, employeeTaskMetrics, tasksByEmployeeId, taskForm.shiftTag, attendance])

  function initialsOf(name = '') {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean)
    if (!parts.length) return 'NA'
    const first = parts[0]?.[0] || ''
    const second = parts.length > 1 ? (parts[1]?.[0] || '') : (parts[0]?.[1] || '')
    return `${first}${second}`.toUpperCase()
  }

  function updateTaskForm(patch) {
    setTaskForm((old) => ({ ...old, ...(patch || {}) }))
  }

  function addAdminTaskBlock() {
    setTaskForm((old) => {
      const blocks = Array.isArray(old.taskBlocks) ? old.taskBlocks : []
      const nextId = blocks.length ? (Math.max(...blocks.map((b) => Number(b.id || 0))) + 1) : 1
      return { ...old, taskBlocks: [...blocks, createTaskBlock(nextId)] }
    })
  }

  function updateAdminTaskBlock(blockId, patch = {}) {
    setTaskForm((old) => ({
      ...old,
      taskBlocks: (Array.isArray(old.taskBlocks) ? old.taskBlocks : []).map((b) => (
        String(b.id) === String(blockId) ? { ...b, ...(patch || {}) } : b
      )),
    }))
  }

  function removeAdminTaskBlock(blockId) {
    setTaskForm((old) => {
      const blocks = (Array.isArray(old.taskBlocks) ? old.taskBlocks : []).filter((b) => String(b.id) !== String(blockId))
      return { ...old, taskBlocks: blocks.length ? blocks : [createTaskBlock(1)] }
    })
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
  }

  function openTeamReportModal() {
    setTeamReportModal({ open: true, date: formatDateInput() })
  }

  function openEmployeeTasksModal(employee) {
    const employeeId = String(employee?.id || '')
    if (!employeeId) return
    setEmployeeTasksModal({
      open: true,
      employeeId,
      employeeName: String(employee?.name || employee?.login_id || 'Employee'),
    })
  }

  async function loadEmployeeAttendanceHistory(employeeId, fromDate, toDate) {
    if (!employeeId) return
    setEmployeeAttendanceModal((old) => ({ ...old, loading: true }))
    try {
      const data = await apiFetch(
        `/admin/employee_attendance_history?employee_id=${encodeURIComponent(employeeId)}&from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`,
        {},
        token,
      )
      const rows = Array.isArray(data?.rows) ? data.rows.map((row) => normalizeAttendanceRow(row)) : []
      setEmployeeAttendanceModal((old) => ({ ...old, rows, loading: false }))
    } catch (err) {
      setEmployeeAttendanceModal((old) => ({ ...old, loading: false, rows: [] }))
      setError(err.message || 'Unable to fetch attendance history')
    }
  }

  function openEmployeeAttendanceModal(employee) {
    const employeeId = String(employee?.id || '')
    if (!employeeId) return
    const fromDate = dateKeyOffsetFromToday(-29)
    const toDate = formatDateInput()
    setEmployeeAttendanceModal({
      open: true,
      employeeId,
      employeeName: String(employee?.name || employee?.login_id || 'Employee'),
      dayRange: '30',
      fromDate,
      toDate,
      rows: [],
      loading: true,
    })
    loadEmployeeAttendanceHistory(employeeId, fromDate, toDate)
  }

  function closeEmployeeAttendanceModal() {
    setEmployeeAttendanceModal((old) => ({ ...old, open: false, loading: false }))
  }

  function applyEmployeeAttendanceDateRange() {
    const employeeId = String(employeeAttendanceModal.employeeId || '')
    const fromDate = String(employeeAttendanceModal.fromDate || '').trim()
    const toDate = String(employeeAttendanceModal.toDate || '').trim()
    if (!employeeId) return
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      setError('Select valid From and To dates')
      return
    }
    if (fromDate > toDate) {
      setError('From date cannot be after To date')
      return
    }
    setEmployeeAttendanceModal((old) => ({ ...old, dayRange: 'custom' }))
    loadEmployeeAttendanceHistory(employeeId, fromDate, toDate)
  }

  function applyEmployeeAttendanceDayRange(nextRange) {
    const range = String(nextRange || '30')
    setEmployeeAttendanceModal((old) => ({ ...old, dayRange: range }))
    if (range === 'custom') return

    const days = Number(range)
    if (!Number.isFinite(days) || days <= 0) return

    const employeeId = String(employeeAttendanceModal.employeeId || '')
    const toDate = String(employeeAttendanceModal.toDate || '').trim() || formatDateInput()
    const fromDate = dateKeyShift(toDate, -(days - 1))
    setEmployeeAttendanceModal((old) => ({ ...old, fromDate, toDate }))
    if (!employeeId) return
    loadEmployeeAttendanceHistory(employeeId, fromDate, toDate)
  }

  function closeEmployeeTasksModal() {
    setEmployeeTasksModal({ open: false, employeeId: '', employeeName: '' })
  }

  function closeTeamReportModal() {
    setTeamReportModal((old) => ({ ...old, open: false }))
  }

  function submitTeamReportModal() {
    const reportDate = String(teamReportModal.date || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      setError('Invalid date format. Please use YYYY-MM-DD')
      return
    }
    closeTeamReportModal()
    printTeamTaskReport(reportDate)
  }

  function openTaskStatsModal(dayScope = 'last_day', filterType = 'all') {
    const scope = String(dayScope || 'last_day')
    const mode = String(filterType || 'all')
    const refDate = scope === 'today' ? formatDateInput() : dateKeyOffsetFromToday(-1)

    setTaskCardFilter(mode)
    setTaskCardDayScope(scope)

    const rows = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => dateKeyInIST(task?.start_date || task?.created_at || task?.updated_at || task?.deadline) === refDate)
      .filter((task) => {
        const status = normalizeTaskStatusForBoard(task)
        if (mode === 'pending') return status === 'not_started' || status === 'in_progress' || status === 'review'
        if (mode === 'overdue') return status === 'overdue'
        if (mode === 'done') return isDoneTaskStatus(status)
        return true
      })
      .map((task) => {
        const status = normalizeTaskStatusForBoard(task)
        const employeeName = task?.assigned_to_name
          || taskWorkspaceEmployees.find((e) => String(e.id) === String(task.assigned_to))?.name
          || String(task?.assigned_to || 'Employee')
        return {
          id: String(task?.id || `${employeeName}-${task?.title || ''}`),
          employeeName,
          title: String(task?.title || '-'),
          status: status.replace(/_/g, ' '),
          deadline: String(task?.deadline || '').slice(0, 10) || '-',
        }
      })

    const label = mode === 'pending' ? 'Pending' : mode === 'overdue' ? 'Overdue' : mode === 'done' ? 'Done' : 'Total Tasks'
    const scopeLabel = scope === 'today' ? 'Today' : 'Last Day'
    setLastDayTaskModal({
      open: true,
      title: `${label} (${scopeLabel})`,
      date: refDate,
      rows,
    })
  }

  async function printTeamTaskReport(reportDateInput = formatDateInput()) {
    try {
    const reportDate = String(reportDateInput || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) {
      setError('Invalid date format. Please use YYYY-MM-DD')
      return
    }

    let attendanceRowsForReport = []
    try {
      const rawAttendance = await apiFetch(`/attendance?date=${encodeURIComponent(reportDate)}`, {}, token)
      attendanceRowsForReport = Array.isArray(rawAttendance)
        ? rawAttendance.map((row) => normalizeAttendanceRow(row))
        : []
    } catch {
      attendanceRowsForReport = Array.isArray(attendance) ? attendance : []
    }

    const attendanceLookup = new Map()
    const normalizeLookupKey = (value) => String(value || '').trim().toLowerCase()
    for (const row of attendanceRowsForReport) {
      const keys = [
        row?.employee_name,
        row?.name,
        row?.login_id,
        row?.employee_login_id,
        row?.employee_id,
      ]
      for (const key of keys) {
        const normalizedKey = normalizeLookupKey(key)
        if (!normalizedKey) continue
        attendanceLookup.set(normalizedKey, row)
      }
    }

    const now = new Date()
    const generatedAt = new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(now)

    const statusMetaForReport = (task) => {
      const status = normalizeTaskStatusForBoard(task)
      if (status === 'completed' || status === 'approved') return { label: 'Completed', tone: 'success' }
      if (status === 'in_progress') return { label: 'In Progress', tone: 'info' }
      if (status === 'review') return { label: 'Pending', tone: 'warning' }
      if (status === 'overdue') return { label: 'Overdue', tone: 'danger' }
      return { label: 'Assigned', tone: 'default' }
    }

    const rows = (filteredTaskEmployees || []).map((emp) => {
      const employeeId = String(emp.id || '')
      const attendanceRow = attendanceLookup.get(normalizeLookupKey(emp?.name))
        || attendanceLookup.get(normalizeLookupKey(emp?.login_id))
        || attendanceLookup.get(normalizeLookupKey(emp?.id))
      const allTasks = (tasksByEmployeeId[employeeId] || [])
        .filter((t) => dateKeyInIST(t?.start_date || t?.created_at || t?.updated_at || t?.deadline) === reportDate)
        .slice().sort((a, b) => {
        const aDate = String(a?.deadline || a?.created_at || a?.updated_at || '')
        const bDate = String(b?.deadline || b?.created_at || b?.updated_at || '')
        return aDate.localeCompare(bDate)
      })
      const doneTasks = allTasks.filter((t) => isDoneTaskStatus(normalizeTaskStatusForBoard(t)))
      const pendingTasks = allTasks.filter((t) => !isDoneTaskStatus(normalizeTaskStatusForBoard(t)))
      const productivityPct = allTasks.length ? Math.round((doneTasks.length / allTasks.length) * 100) : 0
      return {
        employee: emp,
        checkIn: attendanceRow?.check_in || '-',
        checkOut: attendanceRow?.check_out || '-',
        allTasks,
        doneTasks,
        pendingTasks,
        productivityPct,
      }
    })

    const totalEmployees = rows.length
    const totalAssigned = rows.reduce((sum, row) => sum + row.allTasks.length, 0)
    const totalDone = rows.reduce((sum, row) => sum + row.doneTasks.length, 0)
    const totalPending = rows.reduce((sum, row) => sum + row.pendingTasks.length, 0)
    const overallProductivityPct = totalAssigned ? Math.round((totalDone / totalAssigned) * 100) : 0

    const reportHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Team Task Report</title>
    <style>
      * { box-sizing: border-box; }
      body { font-family: Inter, Segoe UI, Roboto, Arial, sans-serif; color: #0f172a; background: #f8fafc; margin: 0; padding: 20px; }
      .container { max-width: 1200px; margin: 0 auto; }
      h1 { margin: 0 0 4px; font-size: 24px; font-weight: 700; }
      .muted { color: #64748b; font-size: 12px; margin: 0; }

      .summary { margin-top: 14px; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; }
      .summary-card {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        box-shadow: 0 2px 10px rgba(15, 23, 42, 0.04);
        padding: 10px 12px;
      }
      .summary-card .label { color: #64748b; font-size: 11px; }
      .summary-card .value { margin-top: 2px; font-size: 20px; font-weight: 700; color: #0f172a; }

      .employee-block {
        margin-top: 14px;
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        box-shadow: 0 2px 10px rgba(15, 23, 42, 0.04);
        padding: 12px;
        page-break-inside: avoid;
      }

      .employee-head {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 10px;
        margin-bottom: 8px;
      }
      .employee-name { margin: 0; font-size: 16px; font-weight: 700; }
      .employee-dept { margin: 2px 0 0; font-size: 12px; color: #64748b; }

      .metric-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 8px;
        margin-bottom: 10px;
      }
      .metric-chip {
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        background: #f8fafc;
        padding: 8px 10px;
      }
      .metric-chip .k { color: #64748b; font-size: 11px; }
      .metric-chip .v { margin-top: 2px; color: #0f172a; font-size: 14px; font-weight: 700; }

      .table-wrap {
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        overflow: auto;
        max-height: 320px;
      }
      table { width: 100%; border-collapse: separate; border-spacing: 0; }
      thead th {
        position: sticky;
        top: 0;
        background: #f8fafc;
        z-index: 1;
        text-align: left;
        padding: 9px 10px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.2px;
        color: #475569;
        border-bottom: 1px solid #e2e8f0;
      }
      tbody td {
        padding: 9px 10px;
        font-size: 12px;
        border-bottom: 1px solid #eef2f7;
        vertical-align: top;
      }
      tbody tr:hover td { background: #f8fbff; }

      .badge {
        display: inline-flex;
        align-items: center;
        border-radius: 999px;
        padding: 3px 9px;
        font-size: 11px;
        font-weight: 600;
        border: 1px solid transparent;
      }
      .badge.default { background: #f1f5f9; color: #334155; border-color: #cbd5e1; }
      .badge.warning { background: #fef9c3; color: #854d0e; border-color: #fde68a; }
      .badge.info { background: #dbeafe; color: #1d4ed8; border-color: #bfdbfe; }
      .badge.success { background: #dcfce7; color: #166534; border-color: #bbf7d0; }
      .badge.danger { background: #fee2e2; color: #991b1b; border-color: #fecaca; }

      .empty {
        margin: 0;
        color: #64748b;
        font-size: 12px;
        padding: 10px;
      }

      @media (max-width: 1100px) {
        .summary { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      }
      @media (max-width: 820px) {
        .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .metric-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media print {
        .preview-toolbar { display: none !important; }
        body { padding: 0; background: #fff; }
        .summary-card, .employee-block { box-shadow: none; }
        .employee-block { break-inside: avoid; }
      }
    </style>
  </head>
  <body>
    <div class="container">
    <div class="preview-toolbar" style="display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:10px;padding:10px 12px;border:1px solid #e2e8f0;border-radius:10px;background:#ffffff;">
      <p class="muted" style="margin:0;">Preview ready for ${escapeHtml(reportDate)}. Use Print to export PDF.</p>
      <button onclick="window.print()" style="padding:8px 12px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer;">Print</button>
    </div>
    <h1>Team Task Completion Report</h1>
    <p class="muted">Generated: ${escapeHtml(generatedAt)} · Report Date: ${escapeHtml(reportDate)} · Department Filter: ${escapeHtml(taskDeptFilter === 'all' ? 'All' : taskDeptFilter)}</p>

    <section class="summary">
      <article class="summary-card"><div class="label">Total Employees</div><div class="value">${totalEmployees}</div></article>
      <article class="summary-card"><div class="label">Total Assigned Tasks</div><div class="value">${totalAssigned}</div></article>
      <article class="summary-card"><div class="label">Total Completed Tasks</div><div class="value">${totalDone}</div></article>
      <article class="summary-card"><div class="label">Total Pending Tasks</div><div class="value">${totalPending}</div></article>
      <article class="summary-card"><div class="label">Overall Productivity</div><div class="value">${overallProductivityPct}%</div></article>
    </section>

    ${rows.map(({ employee, checkIn, checkOut, doneTasks, pendingTasks, allTasks, productivityPct }) => {
      const empName = employee?.name || employee?.login_id || 'Employee'
      const dept = employee?.department || 'General'
      if (!allTasks.length) {
        return `<section class="employee-block">
          <div class="employee-head">
            <div>
              <h2 class="employee-name">${escapeHtml(empName)} <span style="font-size:12px;font-weight:500;color:#64748b;">(In: ${escapeHtml(checkIn)} · Out: ${escapeHtml(checkOut)})</span></h2>
              <p class="employee-dept">Department: ${escapeHtml(dept)}</p>
            </div>
          </div>
          <div class="metric-row">
            <div class="metric-chip"><div class="k">Assigned Work</div><div class="v">0</div></div>
            <div class="metric-chip"><div class="k">Completed Work</div><div class="v">0</div></div>
            <div class="metric-chip"><div class="k">Pending Work</div><div class="v">0</div></div>
            <div class="metric-chip"><div class="k">Productivity</div><div class="v">0%</div></div>
          </div>
          <p class="empty">No assigned work available for this employee.</p>
        </section>`
      }

      const rowsHtml = allTasks.map((task) => {
        const statusMeta = statusMetaForReport(task)
        const assignedDate = String(task?.start_date || task?.created_at || '').slice(0, 10) || '-'
        const dueDate = String(task?.deadline || '').slice(0, 10) || '-'
        return `<tr>
          <td>${escapeHtml(task?.title || '-')}</td>
          <td>${escapeHtml(task?.assigned_by || 'Admin')}</td>
          <td>${escapeHtml(assignedDate)}</td>
          <td>${escapeHtml(dueDate)}</td>
          <td>
            <span class="badge ${statusMeta.tone}">${escapeHtml(statusMeta.label)}</span>
          </td>
        </tr>`
      }).join('')

      return `<section class="employee-block">
        <div class="employee-head">
          <div>
            <h2 class="employee-name">${escapeHtml(empName)} <span style="font-size:12px;font-weight:500;color:#64748b;">(In: ${escapeHtml(checkIn)} · Out: ${escapeHtml(checkOut)})</span></h2>
            <p class="employee-dept">Department: ${escapeHtml(dept)}</p>
          </div>
        </div>

        <div class="metric-row">
          <div class="metric-chip"><div class="k">Assigned Work</div><div class="v">${allTasks.length}</div></div>
          <div class="metric-chip"><div class="k">Completed Work</div><div class="v">${doneTasks.length}</div></div>
          <div class="metric-chip"><div class="k">Pending Work</div><div class="v">${pendingTasks.length}</div></div>
          <div class="metric-chip"><div class="k">Productivity</div><div class="v">${productivityPct}%</div></div>
        </div>

        <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Task Name</th>
              <th>Assigned By</th>
              <th>Assigned Date</th>
              <th>Due Date</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
        </div>
      </section>`
    }).join('')}
    </div>
  </body>
</html>`

    const printWindow = window.open('about:blank', '_blank', 'width=1200,height=900')
    if (!printWindow) {
      setError('Unable to open print preview. Please allow pop-ups for this site.')
      return
    }
    printWindow.document.open()
    printWindow.document.write(reportHtml)
    printWindow.document.close()
    printWindow.focus()
    } catch {
      setError('Failed to generate printable report. Please try again.')
    }
  }

  function openTaskDrawer(defaultEmployeeId = '') {
    setTaskDrawerOpen(true)
    const firstEmployeeId = String((employees || [])[0]?.id || '')
    const defaultIds = defaultEmployeeId
      ? [String(defaultEmployeeId)]
      : (selectedTaskEmployeeId ? [String(selectedTaskEmployeeId)] : (firstEmployeeId ? [firstEmployeeId] : []))
    setTaskForm((old) => ({
      ...old,
      assignToIds: defaultIds,
      departmentTag: selectedTaskEmployee?.department || old.departmentTag || 'General',
      assignedBy: String(old.assignedBy || username || 'admin'),
    }))
  }

  function closeTaskDrawer() {
    setTaskDrawerOpen(false)
  }

  async function assignTaskFromDrawer() {
    const blocks = Array.isArray(taskForm.taskBlocks) ? taskForm.taskBlocks : []
    if (!blocks.length) {
      setError('Add at least one task')
      return
    }
    const normalizedBlocks = blocks.map((b, idx) => ({
      id: b?.id ?? (idx + 1),
      title: String(b?.title || '').trim(),
      description: String(b?.description || '').trim(),
    }))
    const invalidBlock = normalizedBlocks.find((b) => !b.title || !b.description)
    if (invalidBlock) {
      const n = normalizedBlocks.findIndex((b) => String(b.id) === String(invalidBlock.id)) + 1
      setError(`Task ${n}: title and description are required`)
      return
    }
    if (!String(taskForm.dueDate || '').trim()) {
      setError('Task deadline is required')
      return
    }
    const assignees = Array.isArray(taskForm.assignToIds) ? taskForm.assignToIds.filter(Boolean) : []
    if (!assignees.length) {
      setError('Select at least one employee')
      return
    }

    const startDate = String(taskForm.startDate || '').trim()
    if (!startDate) {
      setError('Task start date is required')
      return
    }
    if (new Date(startDate).getTime() > new Date(taskForm.dueDate).getTime()) {
      setError('Start date cannot be after due date')
      return
    }

    const tags = ['admin-assigned']

    setTaskAssignLoading(true)
    try {
      const jobs = assignees.flatMap((employeeId) => normalizedBlocks.map((block) => apiFetch('/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: block.title,
          description: block.description,
          checklist_items: [],
          start_date: startDate,
          deadline: taskForm.dueDate,
          due_time: '18:00',
          priority: taskForm.priority || 'medium',
          tags,
          department_tag: taskForm.departmentTag || selectedTaskEmployee?.department || 'General',
          shift_tag: taskForm.shiftTag || 'day',
          estimated_hours: null,
          recurring: false,
          attachments: [],
          assigned_by: String(taskForm.assignedBy || username || 'admin').trim() || 'admin',
          assigned_to: employeeId,
          status: 'not_started',
        }),
      }, token)))

      const created = await Promise.all(jobs)

      const newTasks = created.map((r) => r?.task).filter(Boolean)
      if (newTasks.length) setTasks((old) => [...newTasks, ...(old || [])])
      publishTaskSync('admin-assign')

      setTaskForm({
        taskBlocks: [createTaskBlock(1)],
        startDate: formatDateInput(),
        dueDate: '',
        assignedBy: String(taskForm.assignedBy || username || 'admin').trim() || 'admin',
        priority: 'medium',
        tags: '',
        departmentTag: selectedTaskEmployee?.department || 'General',
        shiftTag: 'day',
        recurring: false,
        assignToIds: selectedTaskEmployeeId ? [String(selectedTaskEmployeeId)] : [],
        attachments: [],
      })
      closeTaskDrawer()
      await loadAll()
      flash(`${newTasks.length || normalizedBlocks.length} task(s) assigned`)
    } catch (err) {
      setError(err.message)
    } finally {
      setTaskAssignLoading(false)
    }
  }

  async function updateTaskStatusByAdmin(taskId, status) {
    try {
      const data = await apiFetch(`/admin/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      }, token)
      const updated = data?.task
      if (updated?.id) {
        setTasks((old) => (old || []).map((t) => (t.id === updated.id ? updated : t)))
      } else {
        await loadAll()
      }
      publishTaskSync('admin-status')
    } catch (err) {
      setError(err.message)
    }
  }

  function openTaskDetail(task) {
    setActiveTask(task)
    setTaskDetailOpen(true)
  }

  function closeTaskDetail() {
    setTaskDetailOpen(false)
    setActiveTask(null)
  }

  async function deleteTaskByAdmin(taskId) {
    try {
      await apiFetch(`/tasks/${taskId}`, { method: 'DELETE' }, token)
      setTasks((old) => (old || []).filter((t) => t.id !== taskId))
      publishTaskSync('admin-delete')
      flash('Task deleted')
    } catch (err) {
      setError(err.message)
    }
  }

  async function remindTaskByAdmin(taskId) {
    try {
      const data = await apiFetch(`/admin/tasks/${taskId}/reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, token)
      const updated = data?.task
      if (updated?.id) {
        setTasks((old) => (old || []).map((t) => (t.id === updated.id ? updated : t)))
      }
      publishTaskSync('admin-reminder')
      flash(data?.message || 'Reminder sent')
    } catch (err) {
      setError(err.message || 'Unable to send reminder')
    }
  }

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

    const headers = ['Name', 'Check In', 'Check Out', 'Total Hours', 'Timing Status', 'Status', 'Mode', 'Reason']
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
        formatWorkedHoursFromAttendanceRow(a),
        String(a.timing_status || '').trim(),
        a.status || '',
        a.manual_entry ? 'manual' : 'auto',
        a.manual_reason || '',
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

  function openManualAttendanceModal() {
    setError('')
    setManualAttendanceModal({
      open: true,
      employeeId: String(employees?.[0]?.id || ''),
      date: String(date || formatDateInput()),
      checkIn: '',
      checkOut: '',
      reason: '',
      saving: false,
    })
  }

  function closeManualAttendanceModal() {
    if (manualAttendanceModal.saving) return
    setManualAttendanceModal((old) => ({ ...old, open: false, saving: false }))
  }

  async function submitManualAttendance() {
    const employeeId = String(manualAttendanceModal.employeeId || '').trim()
    const dateValue = String(manualAttendanceModal.date || '').trim()
    const checkIn = String(manualAttendanceModal.checkIn || '').trim()
    const checkOut = String(manualAttendanceModal.checkOut || '').trim()
    const reason = String(manualAttendanceModal.reason || '').trim()

    if (!employeeId) {
      setError('Please select an employee')
      return
    }
    if (!dateValue) {
      setError('Please select a date')
      return
    }
    if (!checkIn) {
      setError('Check-in time is required')
      return
    }
    if (!reason) {
      setError('Reason is required for manual attendance')
      return
    }

    try {
      setManualAttendanceModal((old) => ({ ...old, saving: true }))
      await apiFetch('/attendance/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employee_id: employeeId,
          date: dateValue,
          check_in: checkIn,
          check_out: checkOut,
          reason,
        }),
      }, token)
      setManualAttendanceModal((old) => ({ ...old, open: false, saving: false }))
      flash('Manual attendance added')
      await refreshAttendanceLogsOnly(token)
    } catch (err) {
      setError(err.message || 'Unable to add manual attendance')
      setManualAttendanceModal((old) => ({ ...old, saving: false }))
    }
  }

  function printAttendancePdf() {
    const rows = Array.isArray(filteredAttendance) ? filteredAttendance : []
    if (!rows.length) {
      setError('No attendance logs to print for selected filters')
      return
    }

    const escapeHtml = (value) => String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')

    const reportDate = String(date || formatDateInput())
    const generatedAt = new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date())

    const tableRowsHtml = rows.map((a) => `
      <tr>
        <td>${escapeHtml(a.employee_name || '')}</td>
        <td>${escapeHtml(a.check_in || '-')}</td>
        <td>${escapeHtml(a.check_out || '-')}</td>
        <td>${escapeHtml(formatWorkedHoursFromAttendanceRow(a))}</td>
        <td>${escapeHtml(String(a.timing_status || '').trim() || '-')}</td>
        <td>${escapeHtml(a.status || '-')}</td>
        <td>${escapeHtml(a.manual_entry ? 'manual' : 'auto')}</td>
        <td>${escapeHtml(a.manual_reason || '-')}</td>
      </tr>
    `).join('')

    const reportHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Attendance Logs ${escapeHtml(reportDate)}</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 24px; color: #0f172a; }
    .top { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:14px; }
    h1 { margin:0; font-size:20px; }
    .muted { color:#64748b; font-size:12px; margin-top:4px; }
    .stats { display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap:8px; margin: 10px 0 14px; }
    .stat { border:1px solid #e2e8f0; border-radius:10px; padding:8px 10px; }
    .k { font-size:11px; color:#64748b; margin:0; }
    .v { font-size:20px; font-weight:700; margin:2px 0 0; }
    table { width:100%; border-collapse:collapse; }
    th, td { border:1px solid #e2e8f0; padding:8px; font-size:12px; text-align:left; }
    th { background:#f8fafc; }
    .actions { display:flex; justify-content:flex-end; margin-bottom:10px; }
    button { padding:8px 12px; border:none; border-radius:8px; background:#2563eb; color:#fff; font-weight:600; cursor:pointer; }
    @media print { .actions { display:none; } body { margin: 0; } }
  </style>
</head>
<body>
  <div class="actions"><button onclick="window.print()">Print</button></div>
  <div class="top">
    <div>
      <h1>Attendance Logs (${escapeHtml(reportDate)})</h1>
      <p class="muted">Generated on ${escapeHtml(generatedAt)}</p>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><p class="k">Total Employees</p><p class="v">${escapeHtml(attendanceSummary.totalEmployees ?? '-')}</p></div>
    <div class="stat"><p class="k">Checked In</p><p class="v">${escapeHtml(attendanceSummary.checkedIn ?? '-')}</p></div>
    <div class="stat"><p class="k">Checked Out</p><p class="v">${escapeHtml(attendanceSummary.checkedOut ?? '-')}</p></div>
    <div class="stat"><p class="k">Absent</p><p class="v">${escapeHtml(attendanceSummary.absent ?? '-')}</p></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>In</th>
        <th>Out</th>
        <th>Total Hours</th>
        <th>Timing</th>
        <th>Status</th>
        <th>Mode</th>
        <th>Reason</th>
      </tr>
    </thead>
    <tbody>${tableRowsHtml}</tbody>
  </table>
</body>
</html>`

    const printWindow = window.open('about:blank', '_blank', 'width=1200,height=900')
    if (!printWindow) {
      setError('Unable to open print preview. Please allow pop-ups for this site.')
      return
    }
    printWindow.document.open()
    printWindow.document.write(reportHtml)
    printWindow.document.close()
    printWindow.focus()
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
      return [a.employee_name, a.status, a.check_in, a.check_out, a.timing_status, a.manual_reason].some((v) => String(v || '').toLowerCase().includes(q))
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
    if (newEmp.name && newEmp.login_id && newEmp.department && newEmp.password) return 2
    return 1
  }, [newEmp])

  function toFiniteNumber(value) {
    if (value === '' || value == null) return NaN
    const n = Number(value)
    return Number.isFinite(n) ? n : NaN
  }

  function normalizeGeofenceSettings(value) {
    return {
      enabled: !!value?.enabled,
      office_lat: Number(value?.office_lat),
      office_lng: Number(value?.office_lng),
      office_radius_meters: Number(value?.office_radius_meters),
    }
  }

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

  const geofenceWarnings = useMemo(() => {
    const radius = toFiniteNumber(geofence?.office_radius_meters)
    return {
      office_radius_meters: !Number.isNaN(radius) && radius > 800
        ? 'Large radius reduces location accuracy'
        : '',
    }
  }, [geofence])

  const geofenceHasChanges = useMemo(() => {
    if (!geofence || !geofenceInitial) return false
    return JSON.stringify(normalizeGeofenceSettings(geofence)) !== JSON.stringify(normalizeGeofenceSettings(geofenceInitial))
  }, [geofence, geofenceInitial])

  const canSaveGeofenceSettings = !!geofence && geofenceHasChanges && !Object.values(geofenceErrors).some(Boolean)

  const settingsLastUpdatedLabel = useMemo(() => {
    if (!settingsLastUpdated) return '-'
    try {
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: APP_TIME_ZONE,
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

  function formatWorkedHoursFromAttendanceRow(row) {
    const inMinutes = parseTimeToMinutes(row?.check_in)
    const outMinutes = parseTimeToMinutes(row?.check_out)
    if (inMinutes == null || outMinutes == null) return '-'
    let diff = outMinutes - inMinutes
    if (diff < 0) diff += 24 * 60
    const hours = Math.floor(diff / 60)
    const minutes = diff % 60
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  }

  function resolveTimingStatus(row) {
    const explicitStatus = String(row?.timing_status || row?.attendance_status?.status || '').trim()
    if (explicitStatus) return explicitStatus

    // Fallback for legacy rows that do not yet have server timing labels.
    const ENTRY_ON_TIME_END = 9 * 60 + 30
    const EXIT_ON_TIME_START = 16 * 60 + 30
    const inMinutes = parseTimeToMinutes(row?.check_in)
    const outMinutes = parseTimeToMinutes(row?.check_out)

    if (outMinutes != null) return outMinutes < EXIT_ON_TIME_START ? 'Left Early' : 'On Time Exit'
    if (inMinutes != null) return inMinutes > ENTRY_ON_TIME_END ? 'Late' : 'On Time'
    return ''
  }

  function hideAdminBellToast() {
    if (adminBellToastTimerRef.current) {
      clearTimeout(adminBellToastTimerRef.current)
      adminBellToastTimerRef.current = null
    }
    setAdminBellToast((old) => ({ ...old, show: false }))
  }

  function showAdminBellToast(title, text, type = 'info') {
    if (adminBellToastTimerRef.current) {
      clearTimeout(adminBellToastTimerRef.current)
      adminBellToastTimerRef.current = null
    }
    setAdminBellToast({
      show: true,
      title: String(title || 'Notification'),
      message: String(text || ''),
      type: String(type || 'info'),
    })
    adminBellToastTimerRef.current = setTimeout(() => {
      setAdminBellToast((old) => ({ ...old, show: false }))
      adminBellToastTimerRef.current = null
    }, 6000)
  }

  function syncAdminTaskNotifications(taskRows) {
    const list = Array.isArray(taskRows) ? taskRows : []
    const currentMap = {}

    list.forEach((t) => {
      const id = String(t?.id || '')
      if (!id) return
      currentMap[id] = {
        title: String(t?.title || 'Task'),
        assignedToName: String(t?.assigned_to_name || t?.assigned_to || 'Employee'),
        tags: Array.isArray(t?.tags) ? t.tags.map((x) => String(x || '').toLowerCase()) : [],
      }
    })

    const prev = adminTaskNotifyRef.current || { initialized: false, tasks: {} }
    if (prev.initialized) {
      const newlyEmployeeCreated = Object.entries(currentMap).filter(([id, row]) => {
        const existed = !!prev.tasks?.[id]
        return !existed && (row.tags || []).includes('employee-created')
      })

      if (newlyEmployeeCreated.length === 1) {
        const task = newlyEmployeeCreated[0][1]
        showAdminBellToast('New employee task', `${task.assignedToName}: ${task.title}`, 'info')
      } else if (newlyEmployeeCreated.length > 1) {
        showAdminBellToast('New employee tasks', `${newlyEmployeeCreated.length} new tasks created by employees.`, 'info')
      }
    }

    adminTaskNotifyRef.current = { initialized: true, tasks: currentMap }
  }

  async function loadAll() {
    if (!token) return
    setError('')
    setLoading(true)
    try {
      const [e, a, req, geo, cam, allTasks] = await Promise.all([
        apiFetch('/employees', {}, token),
        apiFetch(`/attendance?date=${encodeURIComponent(date)}`, {}, token),
        apiFetch(`/manual_requests${manualStatusFilter ? `?status=${encodeURIComponent(manualStatusFilter)}` : ''}`, {}, token),
        apiFetch('/geofence_settings', {}, token),
        apiFetch('/camera_status', {}, token),
        apiFetch('/tasks', {}, token),
      ])
      setEmployees(e)
      setAttendance(Array.isArray(a) ? a.map((row) => normalizeAttendanceRow(row)) : [])
      setManualRequests(req)
      const nextTasks = Array.isArray(allTasks) ? allTasks : []
      setTasks(nextTasks)
      syncAdminTaskNotifications(nextTasks)
      setGeofence(geo)
      setGeofenceInitial(geo)
      setCameraStatus(cam)
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
      setAttendance(Array.isArray(rows) ? rows.map((row) => normalizeAttendanceRow(row)) : [])
    } catch {
      // UI polling should fail silently
    }
  }

  async function refreshTasksOnly(nextToken = token) {
    if (!nextToken) return
    try {
      const rows = await apiFetch('/tasks', {}, nextToken)
      const nextTasks = Array.isArray(rows) ? rows : []
      setTasks(nextTasks)
      syncAdminTaskNotifications(nextTasks)
    } catch {
      // task polling should fail silently
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

  useEffect(() => {
    if (!token || view !== 'tasks') return undefined
    const id = setInterval(() => {
      refreshTasksOnly(token)
    }, 3000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view])

  useEffect(() => {
    if (!token || view !== 'tasks') return undefined
    const onFocus = () => {
      refreshTasksOnly(token)
    }
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view])

  useEffect(() => {
    if (view === 'tasks') {
      setView('overview')
    }
  }, [view])

  useEffect(() => {
    if (!token) return undefined
    const onStorage = (event) => {
      if (event.key !== TASK_SYNC_EVENT_KEY) return
      refreshTasksOnly(token)
    }
    const onLocalTaskSync = () => {
      refreshTasksOnly(token)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(TASK_SYNC_LOCAL_EVENT, onLocalTaskSync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(TASK_SYNC_LOCAL_EVENT, onLocalTaskSync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!taskDetailOpen || !activeTask?.id) return
    const latest = (tasks || []).find((t) => String(t.id) === String(activeTask.id))
    if (latest) setActiveTask(latest)
  }, [tasks, taskDetailOpen, activeTask])

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

  useEffect(() => {
    if (!message) return undefined
    const id = setTimeout(() => {
      setMessage('')
    }, 4000)
    return () => clearTimeout(id)
  }, [message])

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
    const passwordIssue = validatePasswordInput(newEmp.password)
    if (passwordIssue) {
      setError(passwordIssue)
      setAddEmployeeFeedback({ type: 'error', text: passwordIssue })
      return
    }
    try {
      const data = await apiFetch('/register_employee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newEmp.name,
          login_id: newEmp.login_id,
          department: newEmp.department,
          password: newEmp.password,
          require_face_images: false,
        }),
      }, token)
      setNewEmp({ name: '', login_id: '', department: 'General', password: '' })
      setAddEmployeeFeedback({ type: 'success', text: 'Employee created successfully' })
      flash('Employee created successfully')
      await loadAll()
      setView('directory')
    } catch (err) {
      setError(err.message)
      setAddEmployeeFeedback({ type: 'error', text: err.message || 'Employee creation failed' })
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

  function resetGeofenceToDefaults() {
    setGeofence((old) => ({
      ...(old || {}),
      office_radius_meters: 500,
    }))
    setSettingsFeedback({ type: '', text: '' })
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
    const passwordIssue = validatePasswordInput(resetPasswordModal.password)
    if (passwordIssue) {
      setError(passwordIssue)
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
                  Session auto-refresh: {sessionRefreshedAt ? `Last refresh at ${formatTimeInIST(sessionRefreshedAt)}` : 'Enabled (waiting for next cycle)'}
                </p>
                {!!sessionExpiringSoon && <p className="error">{sessionExpiringSoon}</p>}
                <div className="admin-status-badges">
                  <span className={`status-badge ${cameraStatus?.running ? 'ok' : ''}`}>
                    Camera: {cameraStatus?.running ? 'Active' : 'Stopped'}
                  </span>
                </div>
              </div>
              <div className="row admin-header-actions">
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
                <div className={`add-step ${addEmployeeStep >= 2 ? 'current' : ''}`}>
                  <span className="add-step-index">2</span>
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
                    <p className="muted small add-field-help">Minimum 6 characters, include at least 1 number, no maximum length</p>
                    <input className="add-employee-input" type="text" placeholder="Password" value={newEmp.password} onChange={(e) => setNewEmp((o) => ({ ...o, password: e.target.value }))} required />
                  </div>
                </div>
              </div>
              <button className="add-employee-cta">Create Employee</button>
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
                      <td>
                        <button
                          type="button"
                          className="ghost table-action-btn"
                          onClick={() => openEmployeeAttendanceModal(e)}
                          title="Open last 1 month attendance"
                        >
                          {e.name}
                        </button>
                      </td>
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
                  <button type="button" className="ghost" onClick={printAttendancePdf} disabled={!filteredAttendance.length}>Print PDF</button>
                  <button type="button" className="ghost" onClick={openManualAttendanceModal}>Manual Entry</button>
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
                    <th>Total Hours</th>
                    <th>Timing</th>
                    <th>Status</th>
                    <th>Mode</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAttendance.map((a) => (
                    <tr
                      key={a.id}
                      className={(() => {
                        const timingStatus = String(resolveTimingStatus(a) || '').toLowerCase()
                        const rawStatus = String(a.status || '').toLowerCase()
                        if (rawStatus === 'absent') return 'attendance-row-absent'
                        if (timingStatus === 'late') return 'attendance-row-late'
                        if (timingStatus === 'left early') return 'attendance-row-left-early'
                        return ''
                      })()}
                    >
                      <td>{a.employee_name}</td>
                      <td>
                        <div className="attendance-time-cell">
                          <span>{a.check_in || '-'}</span>
                        </div>
                      </td>
                      <td>
                        <div className="attendance-time-cell">
                          <span>{a.check_out || '-'}</span>
                        </div>
                      </td>
                      <td>{formatWorkedHoursFromAttendanceRow(a)}</td>
                      <td>
                        {(() => {
                          const timingStatus = String(resolveTimingStatus(a) || '').trim()
                          const timingKey = timingStatus.toLowerCase()
                          const timingClass = timingKey === 'late'
                            ? 'late'
                            : timingKey === 'left early'
                              ? 'left-early'
                              : timingKey === 'on time exit'
                                ? 'on-time-exit'
                                : timingKey === 'on time'
                                  ? 'on-time'
                                  : 'default'
                          return <span className={`attendance-timing-badge ${timingClass}`}>{timingStatus || '-'}</span>
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
                      <td>{a.manual_reason || '-'}</td>
                    </tr>
                  ))}
                  {!filteredAttendance.length && (
                    <tr>
                      <td colSpan={8}>
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

          {view === 'tasks' && (
            <div className="task-workspace">
              <aside className="task-left-panel card">
                <div className="task-left-sticky">
                  <h3>Employee Task Panel</h3>
                  <div className="task-filter-stack">
                    <input
                      className="table-search"
                      placeholder="Search employee"
                      value={taskSearch}
                      onChange={(e) => setTaskSearch(e.target.value)}
                    />
                    <select value={taskDeptFilter} onChange={(e) => setTaskDeptFilter(e.target.value)}>
                      <option value="all">Department: All</option>
                      {directoryDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
                    </select>
                    <select value={taskStatusFilter} onChange={(e) => setTaskStatusFilter(e.target.value)}>
                      <option value="all">Status: All</option>
                      <option value="not_started">To Do</option>
                      <option value="in_progress">In Progress</option>
                      <option value="review">Pending Review</option>
                      <option value="completed">Completed</option>
                      <option value="approved">Approved</option>
                      <option value="overdue">Overdue</option>
                    </select>
                    <select value={taskShiftFilter} onChange={(e) => setTaskShiftFilter(e.target.value)}>
                      <option value="all">Shift: All</option>
                      {taskShiftOptions.map((shift) => <option key={shift} value={shift}>{shift.toUpperCase()}</option>)}
                    </select>
                  </div>

                  <div className="task-quick-stats">
                    <div><span>Total</span><strong>{selectedEmployeeTaskStats.total}</strong></div>
                    <div><span>Active</span><strong>{selectedEmployeeTaskStats.active}</strong></div>
                    <div><span>Done</span><strong>{selectedEmployeeTaskStats.done}</strong></div>
                    <div><span>Productivity</span><strong>{selectedEmployeeTaskStats.productivityPct}%</strong></div>
                  </div>

                  <div className="task-employee-list">
                    {loading && [...Array(4)].map((_, idx) => <div key={`sk-${idx}`} className="task-employee-skeleton" />)}
                    {!loading && filteredTaskEmployees.map((employee) => {
                      const employeeId = String(employee.id || '')
                      const metric = employeeTaskMetrics[employeeId] || { active: 0, done: 0, overdue: 0, productivity: 0 }
                      const statusRaw = String(employee.status || '').toLowerCase()
                      const presence = statusRaw === 'inactive' ? 'Offline' : (metric.active > 0 ? 'Online' : 'Idle')
                      return (
                        <button
                          key={employeeId}
                          type="button"
                          className={`task-employee-list-card ${selectedTaskEmployeeId === employeeId ? 'active' : ''}`}
                          onClick={() => {
                            setSelectedTaskEmployeeId(employeeId)
                            setTaskCardFilter('all')
                            setTaskCardDayScope('all')
                            openEmployeeTasksModal(employee)
                          }}
                        >
                          <div className="task-avatar">{initialsOf(employee.name)}</div>
                          <div className="task-employee-list-info">
                            <p className="task-employee-name">{employee.name || employee.login_id}</p>
                            <p className="muted small">{employee.department || 'General'}</p>
                            <p className="muted small">{metric.active} Active | {metric.overdue} Overdue</p>
                          </div>
                          <span className={`status-dot ${presence === 'Online' ? 'online' : presence === 'Idle' ? 'idle' : 'offline'}`}>● {presence}</span>
                        </button>
                      )
                    })}
                    {!loading && !filteredTaskEmployees.length && <p className="muted small">No employees for current filters.</p>}
                  </div>
                </div>
              </aside>

              <section className="task-main-panel">
                <div className="task-stats-grid">
                  <article className="task-stat-card" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('today', 'all')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('today', 'all')}>
                    <p>Total Tasks (Today)</p>
                    <strong>{taskStats.totalTasks}</strong>
                  </article>
                  <article className="task-stat-card amber" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('today', 'pending')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('today', 'pending')}>
                    <p>Pending (Today)</p>
                    <strong>{taskStats.pending}</strong>
                  </article>
                  <article className="task-stat-card red" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('today', 'overdue')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('today', 'overdue')}>
                    <p>Overdue (Today)</p>
                    <strong>{taskStats.overdue}</strong>
                  </article>
                  <article className="task-stat-card" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('today', 'done')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('today', 'done')}>
                    <p>Done (Today)</p>
                    <strong>{taskStats.doneToday}</strong>
                  </article>
                  <article className="task-stat-card blue">
                    <p>Team Report</p>
                    <button type="button" className="ghost" onClick={openTeamReportModal}>Print PDF</button>
                  </article>
                </div>

                <div className="task-stats-grid" style={{ marginTop: 8 }}>
                  <article className="task-stat-card" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('last_day', 'all')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('last_day', 'all')}>
                    <p>Total Tasks (Last Day)</p>
                    <strong>{taskLastDayStats.total}</strong>
                  </article>
                  <article className="task-stat-card amber" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('last_day', 'pending')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('last_day', 'pending')}>
                    <p>Pending (Last Day)</p>
                    <strong>{taskLastDayStats.pending}</strong>
                  </article>
                  <article className="task-stat-card red" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('last_day', 'overdue')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('last_day', 'overdue')}>
                    <p>Overdue (Last Day)</p>
                    <strong>{taskLastDayStats.overdue}</strong>
                  </article>
                  <article className="task-stat-card" role="button" tabIndex={0} style={{ cursor: 'pointer' }} onClick={() => openTaskStatsModal('last_day', 'done')} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && openTaskStatsModal('last_day', 'done')}>
                    <p>Done (Last Day)</p>
                    <strong>{taskLastDayStats.done}</strong>
                  </article>
                </div>

                <div className="card task-main-toolbar">
                  <div>
                    <h3>Task Workspace · All Employees</h3>
                    <p className="muted small">Showing whole team tasks here. Click employee name on left to open that employee's full task popup.</p>
                  </div>
                  <div className="row compact">
                    <button type="button" onClick={() => openTaskDrawer(selectedTaskEmployeeId)}>+ Assign Task</button>
                    <button type="button" className="ghost" onClick={() => setTaskWorkspaceView((old) => (old === 'calendar' ? 'list' : 'calendar'))}>{taskWorkspaceView === 'calendar' ? 'View Table' : 'View Calendar'}</button>
                    {taskWorkspaceView === 'list' && (
                      <button type="button" className="ghost" onClick={() => setTaskTableExpanded(true)}>Expand Popup</button>
                    )}
                    <button type="button" className="ghost" onClick={() => refreshTasksOnly(token)}>Refresh</button>
                  </div>
                </div>

                {taskWorkspaceView === 'list' && (
                  <div className="card task-list-table-wrap five-row-scroll">
                    <table className="directory-table task-workspace-table">
                      <thead>
                        <tr>
                          <th>Task Name</th>
                          <th>Employee</th>
                          <th>Assigned Date</th>
                          <th>Priority</th>
                          <th>Status</th>
                          <th>Deadline</th>
                          <th>Assigned By</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleTaskRows.map((task) => (
                          <tr key={task.id}>
                            <td>{task.title}</td>
                            <td>{task.assigned_to_name || taskWorkspaceEmployees.find((e) => String(e.id) === String(task.assigned_to))?.name || String(task.assigned_to || '-')}</td>
                            <td>{dateKeyInIST(task?.start_date || task?.created_at || task?.updated_at) || '-'}</td>
                            <td><span className={`task-chip priority ${String(task.priority || 'medium').toLowerCase()}`}>{String(task.priority || 'medium')}</span></td>
                            <td>
                              <div className="task-status-cell">
                                <span className={`task-status-indicator ${normalizeTaskStatusForBoard(task)}`} />
                                <select value={normalizeTaskStatusForBoard(task)} onChange={(e) => updateTaskStatusByAdmin(task.id, e.target.value)}>
                                  <option value="not_started">To Do</option>
                                  <option value="in_progress">In Progress</option>
                                  <option value="review">Pending Review</option>
                                  <option value="completed">Completed</option>
                                  <option value="approved">Approved</option>
                                  <option value="overdue">Overdue</option>
                                </select>
                              </div>
                            </td>
                            <td>{String(task.deadline || '').slice(0, 10) || '-'}</td>
                            <td>{task.assigned_by || 'Admin'}</td>
                            <td className="row compact task-actions-cell">
                              <button type="button" className="ghost task-action-btn icon-only" title="Expand task" aria-label="Expand task" onClick={() => openTaskDetail(task)}>⤢</button>
                              <button type="button" className="ghost task-action-btn" onClick={() => openTaskDetail(task)}>View</button>
                              <button type="button" className="ghost task-action-btn" onClick={() => remindTaskByAdmin(task.id)}>Remind</button>
                              {normalizeTaskStatusForBoard(task) !== 'approved' && normalizeTaskStatusForBoard(task) !== 'not_started' && (
                                <button type="button" className="ghost task-action-btn approve" onClick={() => updateTaskStatusByAdmin(task.id, 'approved')}>Approve</button>
                              )}
                              <button type="button" className="ghost task-action-btn danger" onClick={() => deleteTaskByAdmin(task.id)}>Delete</button>
                            </td>
                          </tr>
                        ))}
                        {!visibleTaskRows.length && (
                          <tr><td colSpan={8}><p className="muted small">No tasks available for current filter.</p></td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}

                {taskWorkspaceView === 'calendar' && (
                  <div className="card task-calendar-grid">
                    {visibleTaskRows
                      .slice().sort((a, b) => String(a.deadline || '').localeCompare(String(b.deadline || ''))).map((task) => (
                      <article key={task.id} className="task-calendar-card" onClick={() => openTaskDetail(task)}>
                        <p className="task-calendar-date">{String(task.deadline || '').slice(0, 10) || '-'}</p>
                        <strong>{task.title}</strong>
                        <p className="muted small">{task.assigned_to_name || String(task.assigned_to || '-')}</p>
                        <p className="muted small">{normalizeTaskStatusForBoard(task).replace(/_/g, ' ')}</p>
                      </article>
                    ))}
                    {!visibleTaskRows.length && <p className="muted small">No task deadlines for current filter.</p>}
                  </div>
                )}

                <div className="task-bottom-grid">
                  <section className="card">
                    <h4>Smart Alerts {selectedTaskEmployee?.name ? `· ${selectedTaskEmployee.name}` : ''}</h4>
                    <div className="task-alert-list">
                      {selectedEmployeeTaskStats.overdue > 0 && <p className="task-alert danger">🚨 Overdue tasks detected: {selectedEmployeeTaskStats.overdue}</p>}
                      {selectedEmployeeTaskStats.deadlinesToday > 0 && <p className="task-alert warn">⏰ Deadlines today: {selectedEmployeeTaskStats.deadlinesToday}</p>}
                      {selectedEmployeeTaskStats.pending > 0 && <p className="task-alert info">📌 Tasks not started: {selectedEmployeeTaskStats.pending}</p>}
                      {selectedEmployeeTaskStats.productivityPct < 50 && selectedEmployeeTasks.length > 0 && <p className="task-alert warn">📉 Productivity is below 50%</p>}
                      {selectedEmployeeTaskStats.overdue === 0 && selectedEmployeeTaskStats.deadlinesToday === 0 && selectedEmployeeTaskStats.pending === 0 && <p className="task-alert success">✅ No critical alerts right now</p>}
                    </div>
                  </section>

                  <section className="card">
                    <h4>Recent Activity {selectedTaskEmployee?.name ? `· ${selectedTaskEmployee.name}` : ''}</h4>
                    <div className="task-activity-feed">
                      {activityFeed.map((item) => (
                        <div key={item.id} className="task-activity-item">
                          <p><strong>{item.title}</strong> · {String(item.status || 'not_started').replace(/_/g, ' ')}</p>
                          <p className="muted small">{String(item.updated_at || item.created_at || '').replace('T', ' ').slice(0, 16)}</p>
                        </div>
                      ))}
                      {!activityFeed.length && <p className="muted small">No recent activity.</p>}
                    </div>
                  </section>

                </div>
              </section>

              {taskDrawerOpen && (
                <div className="task-drawer-backdrop" onClick={closeTaskDrawer}>
                  <aside className="task-drawer" onClick={(e) => e.stopPropagation()}>
                    <div className="row between">
                      <h3>Quick Assign Task</h3>
                      <button type="button" className="ghost" onClick={closeTaskDrawer}>Close</button>
                    </div>
                    <div className="stack">
                      <label className="muted small">Assign to</label>
                      <select
                        value={String(taskForm.assignToIds?.[0] || '')}
                        onChange={(e) => updateTaskForm({ assignToIds: e.target.value ? [e.target.value] : [] })}
                      >
                        <option value="">Select employee</option>
                        {(filteredTaskEmployees.length ? filteredTaskEmployees : employees).map((emp) => (
                          <option key={emp.id} value={emp.id}>{emp.name} ({emp.department || 'General'})</option>
                        ))}
                      </select>

                      <div className="task-assignee-summary">
                        <p className="task-assignee-name">{drawerAssignedEmployee?.name || 'Select employee'}</p>
                        <p className="muted small">{drawerAssignedEmployee?.department || 'General'} • {drawerAssignedSummary.shift} Shift</p>
                        <div className="task-assignee-meta">
                          <span>Current Active Tasks: {drawerAssignedSummary.activeTasks}</span>
                          <span>Today Status: {drawerAssignedSummary.todayStatus}</span>
                        </div>
                      </div>

                      <div className="row between">
                        <label className="muted small">Task Blocks *</label>
                        <button type="button" className="ghost" onClick={addAdminTaskBlock}>+ Add Task</button>
                      </div>
                      <div className="task-block-list">
                      {(taskForm.taskBlocks || []).map((block, idx) => (
                        <div key={`admin-task-block-${block.id}`} className="task-block-card">
                          <div className="task-block-head">
                            <p className="task-block-title">Task {idx + 1}</p>
                            <button
                              type="button"
                              className="ghost"
                              disabled={(taskForm.taskBlocks || []).length <= 1}
                              onClick={() => removeAdminTaskBlock(block.id)}
                            >
                              Remove
                            </button>
                          </div>
                          <label className="task-block-label">Task Title</label>
                          <input
                            className="task-block-input"
                            placeholder={`Task title ${idx + 1}`}
                            value={block.title || ''}
                            onChange={(e) => updateAdminTaskBlock(block.id, { title: e.target.value })}
                          />
                          <label className="task-block-label">Description</label>
                          <textarea
                            className="task-block-textarea"
                            rows={2}
                            placeholder={`Description ${idx + 1}`}
                            value={block.description || ''}
                            onChange={(e) => updateAdminTaskBlock(block.id, { description: e.target.value })}
                          />
                        </div>
                      ))}
                      </div>

                      <div className="task-meta-row">
                        <div className="task-meta-field">
                          <label className="muted small">Assigned By</label>
                          <input
                            type="text"
                            placeholder="Admin name"
                            value={taskForm.assignedBy || ''}
                            onChange={(e) => updateTaskForm({ assignedBy: e.target.value })}
                          />
                        </div>
                        <div className="task-meta-field">
                          <label className="muted small">Priority *</label>
                          <select value={taskForm.priority} onChange={(e) => updateTaskForm({ priority: e.target.value })}>
                            <option value="low">Low</option>
                            <option value="medium">Medium</option>
                            <option value="high">High</option>
                            <option value="urgent">Urgent</option>
                          </select>
                        </div>
                        <div className="task-meta-field">
                          <label className="muted small">Start Date *</label>
                          <input type="date" value={taskForm.startDate || ''} onChange={(e) => updateTaskForm({ startDate: e.target.value })} />
                        </div>
                        <div className="task-meta-field">
                          <label className="muted small">Due Date *</label>
                          <input type="date" value={taskForm.dueDate} onChange={(e) => updateTaskForm({ dueDate: e.target.value })} />
                        </div>
                      </div>

                      <div className="row between">
                        <p className="muted small">Simple and clean assignment flow.</p>
                        <button type="button" disabled={taskAssignLoading} onClick={assignTaskFromDrawer}>
                          {taskAssignLoading ? 'Assigning...' : 'Assign Task'}
                        </button>
                      </div>
                    </div>
                  </aside>
                </div>
              )}

              {taskDetailOpen && activeTask && (
                <div className="task-drawer-backdrop" onClick={closeTaskDetail}>
                  <aside className="task-detail-panel" onClick={(e) => e.stopPropagation()}>
                    <div className="row between">
                      <h3>{activeTask.title}</h3>
                      <button type="button" className="ghost" onClick={closeTaskDetail}>Close</button>
                    </div>
                    <p className="muted">{activeTask.description || 'No description provided'}</p>
                    <div className="task-chip-row">
                      <span className={`task-chip priority ${String(activeTask.priority || 'medium').toLowerCase()}`}>{activeTask.priority || 'medium'}</span>
                      <span className="task-chip">Status: {normalizeTaskStatusForBoard(activeTask).replace(/_/g, ' ')}</span>
                      <span className="task-chip">Employee: {activeTask.assigned_to_name || selectedTaskEmployee?.name || '-'}</span>
                      <span className="task-chip">Assigned Date: {dateKeyInIST(activeTask?.start_date || activeTask?.created_at || activeTask?.updated_at) || '-'}</span>
                      <span className="task-chip">Deadline: {String(activeTask.deadline || '').slice(0, 10) || '-'}</span>
                      <span className="task-chip">Assigned By: {activeTask.assigned_by || 'Admin'}</span>
                      <span className="task-chip">Est: {activeTask.estimated_hours || 0}h</span>
                    </div>
                    <div className="stack">
                      <h4>Task Summary</h4>
                      <p className="muted small">Created: {String(activeTask.created_at || '').replace('T', ' ').slice(0, 16) || '-'}</p>
                      <p className="muted small">Updated: {String(activeTask.updated_at || '').replace('T', ' ').slice(0, 16) || '-'}</p>

                      <h4>Recent Updates</h4>
                      <div className="task-activity-feed">
                        {[...(Array.isArray(activeTask.activity) ? activeTask.activity : []), ...(Array.isArray(activeTask.comments) ? activeTask.comments : [])]
                          .filter((item) => String(item?.type || '').toLowerCase() !== 'checklist_updated')
                          .sort((a, b) => String(b?.at || '').localeCompare(String(a?.at || '')))
                          .slice(0, 6)
                          .map((item, idx) => (
                            <div key={`task-detail-${idx}`} className="task-activity-item">
                              <p><strong>{item?.by || 'System'}</strong> · {item?.text || item?.type || 'Updated task'}</p>
                              <p className="muted small">{String(item?.at || '').replace('T', ' ').slice(0, 16) || '-'}</p>
                            </div>
                          ))}
                        {!([...((Array.isArray(activeTask.activity) ? activeTask.activity : [])), ...((Array.isArray(activeTask.comments) ? activeTask.comments : []))]
                          .filter((item) => String(item?.type || '').toLowerCase() !== 'checklist_updated').length) && (
                          <p className="muted small">No updates available for this task yet.</p>
                        )}
                      </div>
                    </div>
                  </aside>
                </div>
              )}
            </div>
          )}

          {view === 'settings' && (
            <div className="cards2">
              {!!settingsFeedback.text && (
                <div className={`${settingsFeedback.type === 'success' ? 'success' : 'error'} settings-feedback-full`}>{settingsFeedback.text}</div>
              )}
              <p className="muted small settings-last-updated">Last updated: {settingsLastUpdatedLabel}</p>
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
      {manualAttendanceModal.open && (
        <div className="modal-overlay" onClick={closeManualAttendanceModal}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Add Manual Attendance</h3>
            <p className="muted">Use this when an employee forgot to mark attendance. Reason is mandatory.</p>
            <div className="stack">
              <label className="muted small">Employee</label>
              <select
                value={manualAttendanceModal.employeeId}
                onChange={(e) => setManualAttendanceModal((old) => ({ ...old, employeeId: e.target.value }))}
              >
                {(employees || []).map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name} ({emp.login_id})</option>
                ))}
              </select>

              <label className="muted small">Date</label>
              <input
                type="date"
                value={manualAttendanceModal.date}
                onChange={(e) => setManualAttendanceModal((old) => ({ ...old, date: e.target.value }))}
              />

              <label className="muted small">Check In (HH:MM)</label>
              <input
                type="time"
                value={manualAttendanceModal.checkIn}
                onChange={(e) => setManualAttendanceModal((old) => ({ ...old, checkIn: e.target.value }))}
              />

              <label className="muted small">Check Out (optional)</label>
              <p className="muted small" style={{ margin: 0 }}>Leave this blank if employee will punch out from employee panel.</p>
              <input
                type="time"
                value={manualAttendanceModal.checkOut}
                onChange={(e) => setManualAttendanceModal((old) => ({ ...old, checkOut: e.target.value }))}
              />

              <label className="muted small">Reason</label>
              <textarea
                rows={3}
                placeholder="Reason for manual attendance update"
                value={manualAttendanceModal.reason}
                onChange={(e) => setManualAttendanceModal((old) => ({ ...old, reason: e.target.value }))}
              />
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button type="button" className="ghost" disabled={manualAttendanceModal.saving} onClick={closeManualAttendanceModal}>Cancel</button>
              <button type="button" disabled={manualAttendanceModal.saving} onClick={submitManualAttendance}>
                {manualAttendanceModal.saving ? 'Saving...' : 'Save Attendance'}
              </button>
            </div>
          </div>
        </div>
      )}
      {employeeAttendanceModal.open && (
        <div className="modal-overlay" onClick={closeEmployeeAttendanceModal}>
          <div className="modal-card employee-tasks-modal-card" style={{ maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>{employeeAttendanceModal.employeeName} · Attendance (Last 1 Month)</h3>
              <button type="button" className="ghost" onClick={closeEmployeeAttendanceModal}>Close</button>
            </div>
            <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'end' }}>
              <div className="stack" style={{ gap: 4 }}>
                <label className="muted small">Days</label>
                <select
                  value={employeeAttendanceModal.dayRange || '30'}
                  onChange={(e) => applyEmployeeAttendanceDayRange(e.target.value)}
                >
                  <option value="7">Last 7 days</option>
                  <option value="15">Last 15 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="60">Last 60 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="custom">Custom range</option>
                </select>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <label className="muted small">From</label>
                <input
                  type="date"
                  value={employeeAttendanceModal.fromDate}
                  onChange={(e) => setEmployeeAttendanceModal((old) => ({ ...old, dayRange: 'custom', fromDate: e.target.value }))}
                />
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <label className="muted small">To</label>
                <input
                  type="date"
                  value={employeeAttendanceModal.toDate}
                  onChange={(e) => setEmployeeAttendanceModal((old) => ({ ...old, dayRange: 'custom', toDate: e.target.value }))}
                />
              </div>
              <button type="button" onClick={applyEmployeeAttendanceDateRange} disabled={employeeAttendanceModal.loading}>
                {employeeAttendanceModal.loading ? 'Loading...' : 'Apply Filter'}
              </button>
            </div>
            <div className="task-list-table-wrap five-row-scroll" style={{ marginTop: 8, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <table className="directory-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Total Hours</th>
                    <th>Timing</th>
                    <th>Status</th>
                    <th>Mode</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(employeeAttendanceModal.rows || []).map((a) => (
                    <tr key={`emp-att-${a.id || a.date}`}>
                      <td>{a.date || '-'}</td>
                      <td>{formatWeekdayFromDateKey(a.date)}</td>
                      <td>{a.check_in || '-'}</td>
                      <td>{a.check_out || '-'}</td>
                      <td>{formatWorkedHoursFromAttendanceRow(a)}</td>
                      <td>{String(resolveTimingStatus(a) || '-')}</td>
                      <td>{String(a.status || '-').replace(/_/g, ' ')}</td>
                      <td>{a.manual_entry ? 'MANUAL' : 'AUTO'}</td>
                      <td>{a.manual_reason || '-'}</td>
                    </tr>
                  ))}
                  {!employeeAttendanceModal.loading && !(employeeAttendanceModal.rows || []).length && (
                    <tr>
                      <td colSpan={9}><p className="muted small">No attendance records found for selected range.</p></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {employeeTasksModal.open && (
        <div className="modal-overlay" onClick={closeEmployeeTasksModal}>
          <div className="modal-card employee-tasks-modal-card" style={{ maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>{employeeTasksModal.employeeName} · Tasks (Last 30 Days)</h3>
              <button type="button" className="ghost" onClick={closeEmployeeTasksModal}>Close</button>
            </div>
            <div className="task-list-table-wrap five-row-scroll" style={{ marginTop: 8, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <table className="directory-table">
                <thead>
                  <tr>
                    <th>Task Name</th>
                    <th>Assigned Date</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Deadline</th>
                    <th>Assigned By</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {employeeModalTasks.map((task) => (
                    <tr key={`emp-modal-${task.id}`}>
                      <td>{task.title}</td>
                      <td>{dateKeyInIST(task?.start_date || task?.created_at || task?.updated_at) || '-'}</td>
                      <td><span className={`task-chip priority ${String(task.priority || 'medium').toLowerCase()}`}>{String(task.priority || 'medium')}</span></td>
                      <td>
                        <div className="task-status-cell">
                          <span className={`task-status-indicator ${normalizeTaskStatusForBoard(task)}`} />
                          <select value={normalizeTaskStatusForBoard(task)} onChange={(e) => updateTaskStatusByAdmin(task.id, e.target.value)}>
                            <option value="not_started">To Do</option>
                            <option value="in_progress">In Progress</option>
                            <option value="review">Pending Review</option>
                            <option value="completed">Completed</option>
                            <option value="approved">Approved</option>
                            <option value="overdue">Overdue</option>
                          </select>
                        </div>
                      </td>
                      <td>{String(task.deadline || '').slice(0, 10) || '-'}</td>
                      <td>{task.assigned_by || 'Admin'}</td>
                      <td className="row compact task-actions-cell">
                        <button type="button" className="ghost task-action-btn icon-only" title="Expand task" aria-label="Expand task" onClick={() => openTaskDetail(task)}>⤢</button>
                        <button type="button" className="ghost task-action-btn" onClick={() => openTaskDetail(task)}>View</button>
                        <button type="button" className="ghost task-action-btn" onClick={() => remindTaskByAdmin(task.id)}>Remind</button>
                        {normalizeTaskStatusForBoard(task) !== 'approved' && normalizeTaskStatusForBoard(task) !== 'not_started' && (
                          <button type="button" className="ghost task-action-btn approve" onClick={() => updateTaskStatusByAdmin(task.id, 'approved')}>Approve</button>
                        )}
                        <button type="button" className="ghost task-action-btn danger" onClick={() => deleteTaskByAdmin(task.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {!employeeModalTasks.length && (
                    <tr><td colSpan={7}><p className="muted small">No tasks available for this employee in the last 30 days.</p></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {taskTableExpanded && (
        <div className="modal-overlay" onClick={() => setTaskTableExpanded(false)}>
          <div className="modal-card task-table-popup-card" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>Task Workspace · Full View</h3>
              <button type="button" className="ghost" onClick={() => setTaskTableExpanded(false)}>Close</button>
            </div>
            <div className="task-list-table-wrap task-table-popup-wrap">
              <table className="directory-table task-workspace-table">
                <thead>
                  <tr>
                    <th>Task Name</th>
                    <th>Employee</th>
                    <th>Assigned Date</th>
                    <th>Priority</th>
                    <th>Status</th>
                    <th>Deadline</th>
                    <th>Assigned By</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTaskRows.map((task) => (
                    <tr key={`popup-${task.id}`}>
                      <td>{task.title}</td>
                      <td>{task.assigned_to_name || taskWorkspaceEmployees.find((e) => String(e.id) === String(task.assigned_to))?.name || String(task.assigned_to || '-')}</td>
                      <td>{dateKeyInIST(task?.start_date || task?.created_at || task?.updated_at) || '-'}</td>
                      <td><span className={`task-chip priority ${String(task.priority || 'medium').toLowerCase()}`}>{String(task.priority || 'medium')}</span></td>
                      <td>
                        <div className="task-status-cell">
                          <span className={`task-status-indicator ${normalizeTaskStatusForBoard(task)}`} />
                          <select value={normalizeTaskStatusForBoard(task)} onChange={(e) => updateTaskStatusByAdmin(task.id, e.target.value)}>
                            <option value="not_started">To Do</option>
                            <option value="in_progress">In Progress</option>
                            <option value="review">Pending Review</option>
                            <option value="completed">Completed</option>
                            <option value="approved">Approved</option>
                            <option value="overdue">Overdue</option>
                          </select>
                        </div>
                      </td>
                      <td>{String(task.deadline || '').slice(0, 10) || '-'}</td>
                      <td>{task.assigned_by || 'Admin'}</td>
                      <td className="row compact task-actions-cell">
                        <button type="button" className="ghost task-action-btn icon-only" title="Expand task" aria-label="Expand task" onClick={() => openTaskDetail(task)}>⤢</button>
                        <button type="button" className="ghost task-action-btn" onClick={() => openTaskDetail(task)}>View</button>
                        <button type="button" className="ghost task-action-btn" onClick={() => remindTaskByAdmin(task.id)}>Remind</button>
                        {normalizeTaskStatusForBoard(task) !== 'approved' && normalizeTaskStatusForBoard(task) !== 'not_started' && (
                          <button type="button" className="ghost task-action-btn approve" onClick={() => updateTaskStatusByAdmin(task.id, 'approved')}>Approve</button>
                        )}
                        <button type="button" className="ghost task-action-btn danger" onClick={() => deleteTaskByAdmin(task.id)}>Delete</button>
                      </td>
                    </tr>
                  ))}
                  {!visibleTaskRows.length && (
                    <tr><td colSpan={8}><p className="muted small">No tasks available for current filter.</p></td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {teamReportModal.open && (
        <div className="modal-overlay" onClick={closeTeamReportModal}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Team Report Date</h3>
            <p className="muted">Select report date first. Preview opens in a new tab with a Print button.</p>
            <div className="stack">
              <label className="muted small" htmlFor="team-report-date-input">Report Date</label>
              <input
                id="team-report-date-input"
                type="date"
                value={teamReportModal.date}
                onChange={(e) => setTeamReportModal((old) => ({ ...old, date: e.target.value }))}
              />
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button type="button" className="ghost" onClick={closeTeamReportModal}>Cancel</button>
              <button type="button" onClick={submitTeamReportModal}>Open Preview</button>
            </div>
          </div>
        </div>
      )}
      {lastDayTaskModal.open && (
        <div className="modal-overlay" onClick={() => setLastDayTaskModal((old) => ({ ...old, open: false }))}>
          <div className="modal-card request-details-modal-card" style={{ maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <h3>{lastDayTaskModal.title}</h3>
            <p className="muted small">Date: {lastDayTaskModal.date}</p>
            <div className="task-list-table-wrap" style={{ marginTop: 8, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <table className="directory-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Work</th>
                    <th>Status</th>
                    <th>Deadline</th>
                  </tr>
                </thead>
                <tbody>
                  {lastDayTaskModal.rows.map((row) => (
                    <tr key={row.id}>
                      <td>{row.employeeName}</td>
                      <td>{row.title}</td>
                      <td>{row.status}</td>
                      <td>{row.deadline}</td>
                    </tr>
                  ))}
                  {!lastDayTaskModal.rows.length && (
                    <tr><td colSpan={4}><p className="muted small">No tasks found for selected card.</p></td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button type="button" className="ghost" onClick={() => setLastDayTaskModal((old) => ({ ...old, open: false }))}>Close</button>
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
              <p>
                <strong>Requested At:</strong>{' '}
                {requestDetailsModal.request?.requested_at || requestDetailsModal.request?.created_at
                  ? `${dateKeyInIST(requestDetailsModal.request?.requested_at || requestDetailsModal.request?.created_at)} ${formatTimeInIST(requestDetailsModal.request?.requested_at || requestDetailsModal.request?.created_at)}`
                  : '-'}
              </p>
              <p>
                <strong>Approved At:</strong>{' '}
                {requestDetailsModal.request?.approved_at
                  ? `${dateKeyInIST(requestDetailsModal.request?.approved_at)} ${formatTimeInIST(requestDetailsModal.request?.approved_at)}`
                  : '-'}
              </p>
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
            <p className="muted small">Minimum 6 characters, include at least 1 number, no maximum length</p>
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
      {adminBellToast.show && (
        <div className={`bell-toast top-right ${adminBellToast.type}`} role="status" aria-live="polite">
          <div className="bell-toast-icon" aria-hidden="true">🔔</div>
          <div>
            <strong>{adminBellToast.title || 'Notification'}</strong>
            <p>{adminBellToast.message}</p>
          </div>
          <button type="button" className="bell-toast-close" aria-label="Dismiss notification" onClick={hideAdminBellToast}>✕</button>
        </div>
      )}
    </main>
  )
}

function UserPage() {
  const cachedAttendance = readAttendanceCache(readValidToken(USER_KEY, 'user', { allowExpired: true }))
  const [darkMode, setDarkMode] = useState(readDarkModePreference)
  const [token, setToken] = useState(() => readValidToken(USER_KEY, 'user', { allowExpired: true }))
  const [sessionRefreshedAt, setSessionRefreshedAt] = useState(null)
  const [sessionExpiringSoon, setSessionExpiringSoon] = useState('')
  const [error, setError] = useState('')
  const [retryLabel, setRetryLabel] = useState('')
  const [retryAction, setRetryAction] = useState(null)
  const [message, setMessage] = useState('')
  const [employee, setEmployee] = useState(null)
  const [attendanceState, setAttendanceState] = useState(cachedAttendance.status || '')
  const [attendanceTimes, setAttendanceTimes] = useState({
    checkIn: '',
    checkOut: '',
  })
  const [attendanceUtcTimes, setAttendanceUtcTimes] = useState({
    checkInAt: '',
    checkOutAt: '',
  })
  const [cameraOn, setCameraOn] = useState(false)
  const [isScanning, setIsScanning] = useState(false)
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
  const [myTasks, setMyTasks] = useState([])
  const [taskStatusDraft, setTaskStatusDraft] = useState({})
  const [taskCommentDraft, setTaskCommentDraft] = useState({})
  const [taskChecklistState, setTaskChecklistState] = useState({})
  const [taskProofs, setTaskProofs] = useState({})
  const [taskUpdates, setTaskUpdates] = useState({})
  const [taskTimers, setTaskTimers] = useState({})
  const [progressEditorTaskId, setProgressEditorTaskId] = useState('')
  const [completedGraceUntil, setCompletedGraceUntil] = useState({})
  const [taskHistoryOpen, setTaskHistoryOpen] = useState(false)
  const [attendanceHistoryDayRange, setAttendanceHistoryDayRange] = useState('30')
  const [attendanceHistoryFromDate, setAttendanceHistoryFromDate] = useState(dateKeyOffsetFromToday(-29))
  const [attendanceHistoryToDate, setAttendanceHistoryToDate] = useState(formatDateInput())
  const [attendanceHistoryRows, setAttendanceHistoryRows] = useState([])
  const [attendanceHistoryLoading, setAttendanceHistoryLoading] = useState(false)
  const [timerTick, setTimerTick] = useState(0)
  const [myTaskForm, setMyTaskForm] = useState({
    taskBlocks: [createTaskBlock(1)],
    priority: 'medium',
    deadline: '',
    dueTime: '18:00',
  })
  const [myTaskSubmitting, setMyTaskSubmitting] = useState(false)
  const [challengeInstruction, setChallengeInstruction] = useState('')
  const [popup, setPopup] = useState({ show: false, type: 'success', title: '', message: '' })
  const [bellToast, setBellToast] = useState({ show: false, title: '', message: '', type: 'info' })
  const [employeeNotifications, setEmployeeNotifications] = useState([])
  const [employeeNotifOpen, setEmployeeNotifOpen] = useState(false)
  const [employeeWorkPopup, setEmployeeWorkPopup] = useState({ open: false, taskId: '' })
  const [checkoutSummaryModal, setCheckoutSummaryModal] = useState({
    open: false,
    tasksCompletedToday: 0,
    pendingTasks: 0,
  })
  const [geo, setGeo] = useState({ lat: '', lng: '', accuracy: '', capturedAtMs: '', sessionJti: '' })
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const canvasRef = useRef(null)
  const manualVideoRef = useRef(null)
  const manualCanvasRef = useRef(null)
  const manualStreamRef = useRef(null)
  const scanInFlightRef = useRef(false)
  const cameraPreloadAttemptedRef = useRef(false)
  const userRefreshInFlightRef = useRef(false)
  const taskNotifyRef = useRef({ initialized: false, statuses: {} })
  const taskReminderNotifyRef = useRef({ initialized: false, latest: {} })
  const checklistSyncInFlightRef = useRef({})
  const checklistPendingRef = useRef({})

  function readTasksFromLocalStorage() {
    try {
      const raw = localStorage.getItem('tasks')
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  function writeTasksToLocalStorage(nextTasks) {
    try {
      localStorage.setItem('tasks', JSON.stringify(Array.isArray(nextTasks) ? nextTasks : []))
    } catch {
      // no-op
    }
  }

  function addMyTaskBlock() {
    setMyTaskForm((old) => {
      const blocks = Array.isArray(old.taskBlocks) ? old.taskBlocks : []
      const nextId = blocks.length ? (Math.max(...blocks.map((b) => Number(b.id || 0))) + 1) : 1
      return { ...old, taskBlocks: [...blocks, createTaskBlock(nextId)] }
    })
  }

  function updateMyTaskBlock(blockId, patch = {}) {
    setMyTaskForm((old) => ({
      ...old,
      taskBlocks: (Array.isArray(old.taskBlocks) ? old.taskBlocks : []).map((b) => (
        String(b.id) === String(blockId) ? { ...b, ...(patch || {}) } : b
      )),
    }))
  }

  function removeMyTaskBlock(blockId) {
    setMyTaskForm((old) => {
      const blocks = (Array.isArray(old.taskBlocks) ? old.taskBlocks : []).filter((b) => String(b.id) !== String(blockId))
      return { ...old, taskBlocks: blocks.length ? blocks : [createTaskBlock(1)] }
    })
  }

  function clearRetryAction() {
    setRetryAction(null)
    setRetryLabel('')
  }

  function isMobileViewport() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia('(max-width: 720px)').matches
  }

  async function attachPrimaryStreamPreview() {
    const video = videoRef.current
    const stream = streamRef.current
    if (!video || !stream) return
    if (video.srcObject !== stream) {
      video.srcObject = stream
    }
    video.setAttribute('playsinline', 'true')
    video.muted = true
    try {
      await video.play()
    } catch {
      // browser may block autoplay until user interaction; keep stream attached
    }
  }

  async function requestUserCameraStream(kind = 'attendance') {
    const mobile = isMobileViewport()
    const base = {
      audio: false,
    }
    const attempts = kind === 'manual'
      ? [
          {
            ...base,
            video: {
              facingMode: { ideal: 'user' },
              width: mobile ? { ideal: 540, max: 720 } : { ideal: 640, max: 960 },
              height: mobile ? { ideal: 720, max: 960 } : { ideal: 480, max: 720 },
              frameRate: { ideal: 20, max: 24 },
            },
          },
          { ...base, video: { facingMode: 'user' } },
          { ...base, video: true },
        ]
      : [
          {
            ...base,
            video: {
              facingMode: { ideal: 'user' },
              width: mobile ? { ideal: 480, max: 640 } : { ideal: 640, max: 960 },
              height: mobile ? { ideal: 640, max: 960 } : { ideal: 480, max: 720 },
              frameRate: { ideal: mobile ? 15 : 20, max: 24 },
            },
          },
          { ...base, video: { facingMode: 'user' } },
          { ...base, video: true },
        ]

    let lastErr = null
    for (const constraints of attempts) {
      try {
        return await navigator.mediaDevices.getUserMedia(constraints)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr || new Error('Camera not accessible')
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

  function playBellSound() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (!Ctx) return
      const ctx = new Ctx()
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {})
      }

      const gain = ctx.createGain()
      gain.gain.setValueAtTime(0.0001, ctx.currentTime)
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.52)
      gain.connect(ctx.destination)

      const osc1 = ctx.createOscillator()
      osc1.type = 'triangle'
      osc1.frequency.setValueAtTime(920, ctx.currentTime)
      osc1.frequency.exponentialRampToValueAtTime(1260, ctx.currentTime + 0.18)
      osc1.connect(gain)
      osc1.start(ctx.currentTime)
      osc1.stop(ctx.currentTime + 0.24)

      const osc2 = ctx.createOscillator()
      osc2.type = 'triangle'
      osc2.frequency.setValueAtTime(1040, ctx.currentTime + 0.22)
      osc2.frequency.exponentialRampToValueAtTime(1480, ctx.currentTime + 0.45)
      osc2.connect(gain)
      osc2.start(ctx.currentTime + 0.22)
      osc2.stop(ctx.currentTime + 0.50)

      setTimeout(() => {
        try { ctx.close() } catch { /* no-op */ }
      }, 700)
    } catch {
      // no-op
    }
  }

  function showBellToast(title, text, type = 'info', meta = {}) {
    const next = {
      id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      title: String(title || 'Notification'),
      message: String(text || ''),
      type: String(type || 'info'),
      taskId: String(meta?.taskId || ''),
      taskTitle: String(meta?.taskTitle || ''),
      at: new Date().toISOString(),
    }
    setBellToast({ show: true, title: next.title, message: next.message, type: next.type })
    setEmployeeNotifications((old) => [next, ...(Array.isArray(old) ? old : [])].slice(0, 50))
    playBellSound()
  }

  function hideBellToast() {
    setBellToast((old) => ({ ...old, show: false }))
  }

  function removeEmployeeNotification(notificationId) {
    const id = String(notificationId || '')
    if (!id) return
    setEmployeeNotifications((old) => (old || []).filter((n) => String(n?.id || '') !== id))
  }

  function clearEmployeeNotifications() {
    setEmployeeNotifications([])
  }

  function openNotificationWork(item) {
    const taskId = String(item?.taskId || '')
    if (taskId) {
      setEmployeeWorkPopup({ open: true, taskId })
      setEmployeeNotifOpen(false)
      return
    }
    const taskTitle = String(item?.taskTitle || '').trim().toLowerCase()
    if (taskTitle) {
      const matched = (myTasks || []).find((t) => String(t?.title || '').trim().toLowerCase() === taskTitle)
      if (matched?.id) {
        setEmployeeWorkPopup({ open: true, taskId: String(matched.id) })
        setEmployeeNotifOpen(false)
      }
    }
  }

  async function login(values) {
    setError('')
    try {
      const preLoginGeo = await updateLocation({ enforce: true })
      const data = await apiFetch('/user/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login_id: values.login_id.toLowerCase(),
          password: values.password,
          lat: preLoginGeo?.lat || '',
          lng: preLoginGeo?.lng || '',
          accuracy: preLoginGeo?.accuracy || '',
          location_captured_at_ms: preLoginGeo?.capturedAtMs || '',
        }),
      })

      localStorage.setItem(USER_KEY, data.token)
      setToken(data.token)
      setEmployee(data.employee)

      await refreshTodayAttendance(data.token)
      setStatus('Login successful')
      setMessage('Authenticated')
      await loadMyTasks(data.token)
      clearRetryAction()
    } catch (err) {
      const rawMessage = String(err?.message || '')
      const isLocationBlock = /outside office|location|geofence|not allowed/i.test(rawMessage)
      const finalMessage = isLocationBlock
        ? `Not allowed to login: ${rawMessage || 'You are outside office geofence.'}`
        : rawMessage
      setError(finalMessage)
      if (isLocationBlock) {
        showPopup('error', 'Login blocked', finalMessage)
      }
      localStorage.removeItem(USER_KEY)
      setToken('')
      setEmployee(null)
      if (isRetryableError(err)) {
        setRetryLabel('Retry login')
        setRetryAction(() => () => login(values))
      }
    }
  }

  async function punchAttendance(action = 'in') {
    const punchAction = String(action || '').toLowerCase()
    const activeToken = readValidToken(USER_KEY, 'user', { allowExpired: true }) || token
    if (!activeToken) {
      setError('Please login first')
      return
    }
    if (punchAction !== 'in' && punchAction !== 'out') return

    try {
      setError('')
      setRetryAction(null)
      setRetryLabel('')
      setStatus(punchAction === 'in' ? 'Marking punch in...' : 'Marking punch out...')

      await updateLocation({ enforce: true })

      const endpoint = punchAction === 'in' ? '/user/mark_entry_on_login' : '/user/mark_exit_on_logout'
      const data = await apiFetch(endpoint, { method: 'POST' }, activeToken)
      const nextStatus = String(data?.status || '').toLowerCase()
      const nextTimes = {
        checkIn: formatAttendanceTimeFromUtc(data?.check_in_at, data?.check_in || attendanceTimes.checkIn, data?.date),
        checkOut: formatAttendanceTimeFromUtc(data?.check_out_at, data?.check_out || attendanceTimes.checkOut, data?.date),
      }
      setAttendanceUtcTimes({
        checkInAt: String(data?.check_in_at || ''),
        checkOutAt: String(data?.check_out_at || ''),
      })
      setAttendanceState(nextStatus)
      setAttendanceTimes(nextTimes)
      writeAttendanceCache(activeToken, {
        status: nextStatus,
        checkIn: nextTimes.checkIn,
        checkOut: nextTimes.checkOut,
      })
      setStatus(punchAction === 'in' ? (data?.message || 'Punch in successful') : (data?.message || 'Punch out successful'))
      setMessage(punchAction === 'in' ? 'Punch in recorded' : 'Punch out recorded')

      if (punchAction === 'out') {
        const productivity = data?.productivity || {}
        setCheckoutSummaryModal({
          open: true,
          tasksCompletedToday: Number(productivity.tasks_completed_today || 0),
          pendingTasks: Number(productivity.pending_tasks || 0),
        })
      }
    } catch (err) {
      const rawMessage = String(err?.message || '')
      setError(rawMessage)
      setStatus('Ready')
      if (isRetryableError(err)) {
        setRetryLabel(punchAction === 'in' ? 'Retry punch in' : 'Retry punch out')
        setRetryAction(() => () => punchAttendance(punchAction))
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
        checkIn: formatAttendanceTimeFromUtc(data?.check_in_at, data?.check_in || '', data?.date),
        checkOut: formatAttendanceTimeFromUtc(data?.check_out_at, data?.check_out || '', data?.date),
      }
      setAttendanceUtcTimes({
        checkInAt: String(data?.check_in_at || ''),
        checkOutAt: String(data?.check_out_at || ''),
      })
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

  async function loadUserAttendanceHistory(fromDate = attendanceHistoryFromDate, toDate = attendanceHistoryToDate, nextToken = token) {
    if (!nextToken) return
    setAttendanceHistoryLoading(true)
    try {
      const data = await apiFetch(
        `/user/attendance_history?from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`,
        {},
        nextToken,
      )
      const rows = Array.isArray(data?.rows) ? data.rows.map((row) => normalizeAttendanceRow(row)) : []
      setAttendanceHistoryRows(rows)
      setError('')
    } catch (err) {
      setAttendanceHistoryRows([])
      setError(err.message || 'Unable to fetch attendance history')
    } finally {
      setAttendanceHistoryLoading(false)
    }
  }

  function openAttendanceHistoryModal() {
    const fromDate = dateKeyOffsetFromToday(-29)
    const toDate = formatDateInput()
    setAttendanceHistoryDayRange('30')
    setAttendanceHistoryFromDate(fromDate)
    setAttendanceHistoryToDate(toDate)
    setTaskHistoryOpen(true)
    loadUserAttendanceHistory(fromDate, toDate)
  }

  function applyAttendanceHistoryDayRange(nextRange) {
    const range = String(nextRange || '30')
    setAttendanceHistoryDayRange(range)
    if (range === 'custom') return

    const days = Number(range)
    if (!Number.isFinite(days) || days <= 0) return

    const toDate = String(attendanceHistoryToDate || '').trim() || formatDateInput()
    const fromDate = dateKeyShift(toDate, -(days - 1))
    setAttendanceHistoryFromDate(fromDate)
    setAttendanceHistoryToDate(toDate)
    loadUserAttendanceHistory(fromDate, toDate)
  }

  function applyAttendanceHistoryDateRange() {
    const fromDate = String(attendanceHistoryFromDate || '').trim()
    const toDate = String(attendanceHistoryToDate || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      setError('Select valid From and To dates')
      return
    }
    if (fromDate > toDate) {
      setError('From date cannot be after To date')
      return
    }
    setAttendanceHistoryDayRange('custom')
    loadUserAttendanceHistory(fromDate, toDate)
  }

  async function loadMyTasks(nextToken = token) {
    if (!nextToken) return
    try {
      const rows = await apiFetch('/tasks', {}, nextToken)
      const list = Array.isArray(rows) ? rows : []

      const currentStatusMap = {}
      const currentReminderMap = {}
      list.forEach((t) => {
        const id = String(t.id || '')
        if (!id) return
        currentStatusMap[id] = {
          status: String(t.status || 'not_started').toLowerCase(),
          title: String(t.title || 'Task'),
          tags: Array.isArray(t.tags) ? t.tags.map((x) => String(x || '').toLowerCase()) : [],
        }

        const reminders = (Array.isArray(t.activity) ? t.activity : [])
          .filter((item) => String(item?.type || '').toLowerCase() === 'reminder_sent')
        if (reminders.length) {
          const latest = reminders
            .slice()
            .sort((a, b) => String(a?.at || '').localeCompare(String(b?.at || '')))
            .pop()
          currentReminderMap[id] = {
            at: String(latest?.at || ''),
            title: String(t.title || 'Task'),
            text: String(latest?.text || ''),
          }
        }
      })

      const prevSnapshot = taskNotifyRef.current || { initialized: false, statuses: {} }
      if (prevSnapshot.initialized) {
        const prevMap = prevSnapshot.statuses || {}
        const newlyAssigned = Object.entries(currentStatusMap).filter(([id, row]) => {
          const existed = !!prevMap[id]
          const employeeCreated = (row.tags || []).includes('employee-created')
          return !existed && !employeeCreated && row.status !== 'approved'
        })
        const newlyApproved = Object.entries(currentStatusMap).filter(([id, row]) => {
          const prev = prevMap[id]
          return !!prev && prev.status !== 'approved' && row.status === 'approved'
        })

        if (newlyAssigned.length === 1) {
          const [taskId, row] = newlyAssigned[0]
          showBellToast('New work assigned', row.title || 'You received a new task.', 'info', { taskId, taskTitle: row.title })
        } else if (newlyAssigned.length > 1) {
          showBellToast('New work assigned', `${newlyAssigned.length} new tasks assigned by admin.`, 'info')
        }

        if (newlyApproved.length === 1) {
          const [taskId, row] = newlyApproved[0]
          showBellToast('Work approved', `${row.title || 'Task'} approved by admin.`, 'success', { taskId, taskTitle: row.title })
        } else if (newlyApproved.length > 1) {
          showBellToast('Work approved', `${newlyApproved.length} tasks approved by admin.`, 'success')
        }
      }
      taskNotifyRef.current = { initialized: true, statuses: currentStatusMap }

      const prevReminderSnapshot = taskReminderNotifyRef.current || { initialized: false, latest: {} }
      if (prevReminderSnapshot.initialized) {
        const prevMap = prevReminderSnapshot.latest || {}
        const newReminderRows = Object.entries(currentReminderMap).filter(([taskId, row]) => {
          const prev = prevMap[taskId]
          if (!prev) return true
          return String(prev.at || '') !== String(row.at || '')
        })

        if (newReminderRows.length === 1) {
          const [taskId, row] = newReminderRows[0]
          showBellToast('Reminder from admin', row.text || `${row.title} needs your attention.`, 'info', { taskId, taskTitle: row.title })
        } else if (newReminderRows.length > 1) {
          showBellToast('Reminders from admin', `${newReminderRows.length} task reminders received.`, 'info')
        }
      }
      taskReminderNotifyRef.current = { initialized: true, latest: currentReminderMap }

      const mergedList = list.map((task) => {
        const taskId = String(task?.id || '')
        const pending = checklistPendingRef.current[taskId]
        if (!pending) return task

        const ageMs = Date.now() - Number(pending.at || 0)
        if (ageMs > 20000) {
          delete checklistPendingRef.current[taskId]
          delete checklistSyncInFlightRef.current[taskId]
          return task
        }

        const checklist = Array.isArray(task.checklist_items) ? task.checklist_items : []
        if (!checklist.length) return task
        if (pending.index < 0 || pending.index >= checklist.length) return task

        const nextChecklist = checklist.map((item, idx) => {
          if (idx !== pending.index) return item
          const forcedDone = !!pending.done
          return {
            ...(item || {}),
            done: forcedDone,
            completed: forcedDone,
          }
        })

        return {
          ...task,
          checklist_items: nextChecklist,
        }
      })

      setMyTasks(mergedList)
      writeTasksToLocalStorage(mergedList)
      setTaskStatusDraft((old) => {
        const next = { ...old }
        const editingId = String(progressEditorTaskId || '')
        mergedList.forEach((t) => {
          const id = String(t.id || '')
          if (!id) return
          if (editingId && id === editingId && next[id] != null) return
          next[id] = String(t.status || 'not_started')
        })
        return next
      })
      setTaskCommentDraft((old) => {
        const next = { ...old }
        mergedList.forEach((t) => {
          if (next[t.id] == null) next[t.id] = String(t.comment || '')
        })
        return next
      })
      setTaskChecklistState((old) => {
        const next = { ...old }
        mergedList.forEach((t) => {
          const taskId = String(t.id || '')
          if (checklistSyncInFlightRef.current[taskId]) return
          const items = Array.isArray(t.checklist_items) ? t.checklist_items : []
          const current = Array.isArray(next[taskId]) ? next[taskId] : []
          const serverState = items.map((item) => !!item?.done)
          const needsSync = !Array.isArray(next[taskId])
            || current.length !== serverState.length
            || current.some((flag, idx) => !!flag !== !!serverState[idx])
          if (needsSync) next[taskId] = serverState
        })
        return next
      })
      setTaskUpdates((old) => {
        const next = { ...old }
        mergedList.forEach((t) => {
          const seeded = []
          if (Array.isArray(t.activity)) {
            t.activity.forEach((item) => {
              seeded.push({ by: item?.by || 'System', text: item?.text || item?.type || 'Task updated', at: item?.at || '', type: item?.type || '' })
            })
          }
          if (Array.isArray(t.comments)) {
            t.comments.forEach((item) => {
              seeded.push({ by: item?.by || 'Comment', text: item?.text || '', at: item?.at || '', type: 'comment' })
            })
          }
          if (t.comment) seeded.push({ by: 'Update', text: String(t.comment), at: t.updated_at || '', type: 'comment' })
          next[t.id] = seeded.slice(-20)
        })
        return next
      })
      setTaskProofs((old) => {
        const next = { ...old }
        mergedList.forEach((t) => {
          next[t.id] = Array.isArray(t.attachments)
            ? t.attachments.map((a) => ({
                name: a?.name || 'file',
                size: Number(a?.size || 0),
                type: a?.type || '',
                uploadedAt: a?.uploaded_at || '',
              }))
            : []
        })
        return next
      })
      setTaskTimers((old) => {
        const next = { ...old }
        mergedList.forEach((t) => {
          if (!next[t.id]) {
            next[t.id] = {
              running: false,
              startedAtMs: 0,
              elapsedSec: 0,
            }
          }
        })
        return next
      })
      setCompletedGraceUntil((old) => {
        const next = { ...old }
        const nowMs = Date.now()
        mergedList.forEach((t) => {
          const id = String(t.id || '')
          if (!id) return
          const status = String(t.status || '').toLowerCase()
          if (status !== 'completed') return
          const completedMs = parseBackendDateMs(t.completed_at || t.updated_at || '')
          if (!Number.isFinite(completedMs)) return
          const until = completedMs + COMPLETED_VISIBLE_MS
          if (until > nowMs && Number(next[id] || 0) < until) {
            next[id] = until
          }
        })
        return next
      })
    } catch {
      // no-op for task refresh
    }
  }

  async function updateMyTask(taskId, forcedStatus = '', forcedComment = null) {
    const taskRow = (myTasks || []).find((t) => String(t.id) === String(taskId)) || null
    const fallbackStatus = String(taskRow?.status || 'not_started')
    const previousDraft = String(taskStatusDraft[taskId] || fallbackStatus)
    const nextStatus = String(forcedStatus || taskStatusDraft[taskId] || fallbackStatus)
    const comment = forcedComment != null ? String(forcedComment || '') : String(taskCommentDraft[taskId] || '')
    if (nextStatus === 'completed') {
      setCompletedGraceUntil((old) => ({ ...old, [String(taskId)]: Date.now() + COMPLETED_VISIBLE_MS }))
    }
    try {
      const data = await apiFetch(`/tasks/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus, comment }),
      }, token)
      const updated = data?.task
      if (updated?.id) {
        setMyTasks((old) => (old || []).map((t) => (t.id === updated.id ? updated : t)))
        setTaskStatusDraft((old) => ({ ...old, [taskId]: String(updated.status || nextStatus) }))
        setTaskCommentDraft((old) => ({ ...old, [taskId]: String(comment || '') }))
        setCompletedGraceUntil((old) => {
          const next = { ...old }
          const finalStatus = String(updated.status || nextStatus || '').toLowerCase()
          if (finalStatus === 'completed') {
            next[String(taskId)] = Date.now() + COMPLETED_VISIBLE_MS
          } else {
            delete next[String(taskId)]
          }
          return next
        })
      }
      publishTaskSync('employee-update')
      setMessage(data?.message || 'Task updated')
      setError('')
      await loadMyTasks(token)
    } catch (err) {
      setTaskStatusDraft((old) => ({ ...old, [taskId]: previousDraft }))
      if (nextStatus === 'completed') {
        setCompletedGraceUntil((old) => {
          const next = { ...old }
          delete next[String(taskId)]
          return next
        })
      }
      setError(err.message)
    }
  }

  async function saveTaskProgressUpdate(task) {
    const taskId = String(task?.id || '')
    if (!taskId) return
    const note = String(taskCommentDraft[taskId] || '').trim()
    if (!note) {
      setError('Please add progress update text')
      return
    }
    const nextStatus = String(taskStatusDraft[taskId] || task?.status || 'not_started')
    await updateMyTask(taskId, nextStatus, note)
    setProgressEditorTaskId('')
    setTaskCommentDraft((old) => ({ ...old, [taskId]: '' }))
  }

  async function createMyTask() {
    const blocks = Array.isArray(myTaskForm.taskBlocks) ? myTaskForm.taskBlocks : []
    if (!blocks.length) {
      setError('Add at least one task')
      showPopup('error', 'Task not added', 'Add at least one task')
      return
    }
    const normalizedBlocks = blocks.map((b, idx) => ({
      id: b?.id ?? (idx + 1),
      title: String(b?.title || '').trim(),
      description: String(b?.description || '').trim(),
    }))
    const invalidBlock = normalizedBlocks.find((b) => !b.title || !b.description)
    if (invalidBlock) {
      const n = normalizedBlocks.findIndex((b) => String(b.id) === String(invalidBlock.id)) + 1
      const msg = `Task ${n}: title and description are required`
      setError(msg)
      showPopup('error', 'Task not added', msg)
      return
    }
    if (!String(myTaskForm.deadline || '').trim()) {
      setError('Please select due date')
      showPopup('error', 'Task not added', 'Please select due date')
      return
    }
    if (!String(myTaskForm.dueTime || '').trim()) {
      setError('Please select due time')
      showPopup('error', 'Task not added', 'Please select due time')
      return
    }
    setMyTaskSubmitting(true)
    setError('')
    try {
      const jobs = normalizedBlocks.map((block) => apiFetch('/user/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: block.title,
          description: block.description,
          priority: String(myTaskForm.priority || 'medium').toLowerCase(),
          deadline: myTaskForm.deadline || null,
          due_time: myTaskForm.dueTime || '18:00',
          checklist_items: [],
        }),
      }, token))
      const results = await Promise.all(jobs)
      const createdRows = results.map((r) => r?.task).filter(Boolean)
      if (createdRows.length) {
        setMyTasks((old) => [...createdRows, ...(old || [])])
      }
      publishTaskSync('employee-create')
      setMyTaskForm({ taskBlocks: [createTaskBlock(1)], priority: 'medium', deadline: '', dueTime: '18:00' })
      setMessage(`${createdRows.length || normalizedBlocks.length} task(s) added and synced to admin panel`)
      showPopup('success', 'Task added', `${createdRows.length || normalizedBlocks.length} task(s) added and synced to admin panel`)
      await loadMyTasks(token)
    } catch (err) {
      setError(err.message)
      showPopup('error', 'Task not added', err.message || 'Unable to add task')
    } finally {
      setMyTaskSubmitting(false)
    }
  }

  function handleChecklistToggle(taskId, checklistId) {
    const id = String(taskId || '')
    const checklistKey = checklistId == null ? '' : String(checklistId)
    if (!id || checklistKey === '') return

    let nextDone = false
    let nextIndex = -1
    let previousDone = false

    setMyTasks((prevTasks) => {
      const updatedTasks = (prevTasks || []).map((task) => {
        if (String(task.id) !== id) return task

        const checklist = Array.isArray(task.checklist_items) ? task.checklist_items : []
        const updatedChecklist = checklist.map((item, idx) => {
          const itemId = String(item?.id ?? idx)
          const isTarget = itemId === checklistKey
          const currentDone = !!(item?.done ?? item?.completed)
          const toggledDone = isTarget ? !currentDone : currentDone
          if (isTarget) {
            previousDone = currentDone
            nextDone = toggledDone
            nextIndex = idx
          }
          return {
            ...(item || {}),
            done: toggledDone,
            completed: toggledDone,
          }
        })

        const total = updatedChecklist.length
        const doneCount = updatedChecklist.filter((item) => !!(item?.done ?? item?.completed)).length
        const nextStatus = total > 0
          ? (doneCount === total ? 'completed' : (doneCount > 0 ? 'in_progress' : 'not_started'))
          : String(task.status || 'not_started')

        setTaskStatusDraft((old) => ({ ...old, [id]: nextStatus }))
        setTaskChecklistState((old) => ({ ...old, [id]: updatedChecklist.map((item) => !!item?.done) }))

        return {
          ...task,
          status: nextStatus,
          checklist_items: updatedChecklist,
        }
      })

      writeTasksToLocalStorage(updatedTasks)
      return updatedTasks
    })

    if (nextIndex < 0) return

    checklistSyncInFlightRef.current[id] = true
    checklistPendingRef.current[id] = {
      index: nextIndex,
      done: nextDone,
      at: Date.now(),
    }

    apiFetch(`/tasks/${id}/checklist`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        index: nextIndex,
        done: nextDone,
      }),
    }, token)
      .then((data) => {
        const updated = data?.task
        if (updated?.id) {
          setMyTasks((old) => {
            const next = (old || []).map((t) => (t.id === updated.id ? updated : t))
            writeTasksToLocalStorage(next)
            return next
          })
          const items = Array.isArray(updated.checklist_items) ? updated.checklist_items : []
          setTaskChecklistState((old) => ({
            ...old,
            [id]: items.map((item) => !!item?.done),
          }))
        }
        delete checklistPendingRef.current[id]
        delete checklistSyncInFlightRef.current[id]
      })
      .catch(async (err) => {
        try {
          const fallback = await apiFetch(`/tasks/${id}/status`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              checklist_index: nextIndex,
              checklist_done: nextDone,
            }),
          }, token)
          const updated = fallback?.task
          if (updated?.id) {
            setMyTasks((old) => {
              const next = (old || []).map((t) => (t.id === updated.id ? updated : t))
              writeTasksToLocalStorage(next)
              return next
            })
            const items = Array.isArray(updated.checklist_items) ? updated.checklist_items : []
            setTaskChecklistState((old) => ({
              ...old,
              [id]: items.map((item) => !!item?.done),
            }))
          }
          delete checklistPendingRef.current[id]
          delete checklistSyncInFlightRef.current[id]
          return
        } catch (fallbackErr) {
          setMyTasks((old) => {
            const next = (old || []).map((task) => {
              if (String(task.id) !== id) return task
              const checklist = Array.isArray(task.checklist_items) ? task.checklist_items : []
              const rolledBackChecklist = checklist.map((item, idx) => {
                if (idx !== nextIndex) return item
                return {
                  ...(item || {}),
                  done: previousDone,
                  completed: previousDone,
                }
              })
              const total = rolledBackChecklist.length
              const doneCount = rolledBackChecklist.filter((item) => !!(item?.done ?? item?.completed)).length
              const rollbackStatus = total > 0
                ? (doneCount === total ? 'completed' : (doneCount > 0 ? 'in_progress' : 'not_started'))
                : String(task.status || 'not_started')
              setTaskStatusDraft((state) => ({ ...state, [id]: rollbackStatus }))
              setTaskChecklistState((state) => ({ ...state, [id]: rolledBackChecklist.map((row) => !!(row?.done ?? row?.completed)) }))
              return {
                ...task,
                status: rollbackStatus,
                checklist_items: rolledBackChecklist,
              }
            })
            writeTasksToLocalStorage(next)
            return next
          })
          delete checklistPendingRef.current[id]
          delete checklistSyncInFlightRef.current[id]
          setError(fallbackErr?.message || err?.message || 'Unable to update checklist')
        }
      })
  }

  function addTaskUpdate(taskId, text) {
    const clean = String(text || '').trim()
    if (!clean) return
    setTaskUpdates((old) => ({
      ...old,
      [taskId]: [
        ...(old[taskId] || []),
        { by: employee?.name || 'Employee', text: clean, at: new Date().toISOString() },
      ],
    }))
  }

  async function uploadTaskProof(taskId, files) {
    const list = Array.from(files || [])
    if (!list.length) return
    const metadata = list.map((f) => ({ name: f.name, size: Number(f.size || 0), type: f.type || '' }))
    try {
      const data = await apiFetch(`/tasks/${taskId}/proof_metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: metadata }),
      }, token)
      const updated = data?.task
      if (updated?.id) {
        setMyTasks((old) => (old || []).map((t) => (t.id === updated.id ? updated : t)))
      }
      await loadMyTasks(token)
      setMessage(data?.message || 'Proof uploaded')
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }

  function startTaskTimer(taskId) {
    setTaskTimers((old) => {
      const t = old[taskId] || { running: false, startedAtMs: 0, elapsedSec: 0 }
      if (t.running) return old
      return {
        ...old,
        [taskId]: {
          ...t,
          running: true,
          startedAtMs: Date.now(),
        },
      }
    })
    setTaskStatusDraft((old) => ({ ...old, [taskId]: old[taskId] || 'in_progress' }))
  }

  function pauseTaskTimer(taskId) {
    setTaskTimers((old) => {
      const t = old[taskId] || { running: false, startedAtMs: 0, elapsedSec: 0 }
      if (!t.running) return old
      const elapsedDelta = Math.max(0, Math.floor((Date.now() - (t.startedAtMs || Date.now())) / 1000))
      return {
        ...old,
        [taskId]: {
          ...t,
          running: false,
          startedAtMs: 0,
          elapsedSec: Number(t.elapsedSec || 0) + elapsedDelta,
        },
      }
    })
  }

  function stopTaskTimer(taskId) {
    pauseTaskTimer(taskId)
    setTaskTimers((old) => ({
      ...old,
      [taskId]: {
        ...(old[taskId] || {}),
        running: false,
        startedAtMs: 0,
      },
    }))
  }

  function formatDuration(totalSec = 0) {
    const sec = Math.max(0, Math.floor(Number(totalSec || 0)))
    const h = Math.floor(sec / 3600)
    const m = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (h > 0) return `${h}h ${m}m`
    if (m > 0) return `${m}m ${s}s`
    return `${s}s`
  }

  function parseAttendanceTimeToMinutes(value) {
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

  function formatWorkedHoursFromAttendanceRow(row) {
    const inMinutes = parseAttendanceTimeToMinutes(row?.check_in)
    const outMinutes = parseAttendanceTimeToMinutes(row?.check_out)
    if (inMinutes == null || outMinutes == null) return '-'
    let diff = outMinutes - inMinutes
    if (diff < 0) diff += 24 * 60
    const hours = Math.floor(diff / 60)
    const minutes = diff % 60
    return `${hours}h ${String(minutes).padStart(2, '0')}m`
  }

  function resolveTimingStatus(row) {
    const explicitStatus = String(row?.timing_status || row?.attendance_status?.status || '').trim()
    if (explicitStatus) return explicitStatus
    return ''
  }

  async function initFromToken() {
    if (!token) return
    const payload = decodeToken(token)
    if (!payload) {
      logout(false)
      return
    }
    try {
      const freshGeo = await updateLocation({ sessionToken: token, enforce: true })
      await apiFetch('/user/validate_login_location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: freshGeo?.lat || '',
          lng: freshGeo?.lng || '',
          accuracy: freshGeo?.accuracy || '',
          location_captured_at_ms: freshGeo?.capturedAtMs || '',
          location_session_jti: freshGeo?.sessionJti || '',
        }),
      }, token)
      setEmployee({
        name: payload.employee_name,
        login_id: payload.login_id,
        department: 'General',
        must_change_password: payload.must_change_password,
      })
      await refreshTodayAttendance(token)
      await loadMyTasks(token)
    } catch (err) {
      setError(err?.message || 'Location verification failed. Please login again.')
      logout(false)
    }
  }

  useEffect(() => {
    initFromToken()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return
    const claims = decodeToken(token)
    if (!claims || String(claims.role || '').toLowerCase() !== 'user') {
      logout(false)
      setError('Session invalid. Please login again.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    const onStorage = (event) => {
      if (event.key !== USER_KEY) return
      const latest = readValidToken(USER_KEY, 'user', { allowExpired: true })
      setToken((old) => (old === latest ? old : latest))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  useEffect(() => {
    if (!token) return undefined
    const onStorage = (event) => {
      if (event.key !== TASK_SYNC_EVENT_KEY) return
      loadMyTasks(token)
    }
    const onLocalTaskSync = () => {
      loadMyTasks(token)
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(TASK_SYNC_LOCAL_EVENT, onLocalTaskSync)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener(TASK_SYNC_LOCAL_EVENT, onLocalTaskSync)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function startCamera() {
    try {
      const stream = await requestUserCameraStream('attendance')
      streamRef.current = stream
      await attachPrimaryStreamPreview()
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
      const stream = await requestUserCameraStream('manual')
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
    } else {
      stopManualCamera()
    }

    return () => {
      stopManualCamera()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manualModalOpen])

  useEffect(() => {
    applyThemePreference(darkMode)
    try {
      localStorage.setItem(UI_THEME_KEY, darkMode ? 'dark' : 'light')
    } catch {
      // no-op
    }
  }, [darkMode])

  function getGeoErrorMessage(err) {
    const code = Number(err?.code || 0)
    if (code === 1) return 'Location permission denied. Please allow location to continue.'
    if (code === 2) return 'Location unavailable. Please enable GPS/network location and retry.'
    if (code === 3) return 'Location request timed out. Please retry.'
    return 'Unable to fetch location. Please retry.'
  }

  async function fetchFreshLocation() {
    if (!navigator.geolocation) {
      throw new Error('Location is not supported in this browser.')
    }

    const requestPosition = (options) => new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, options)
    })

    let lastErr = null
    for (let i = 0; i <= GEO_RETRY_COUNT; i += 1) {
      try {
        const pos = await requestPosition({
          enableHighAccuracy: true,
          timeout: GEO_TIMEOUT_MS,
          maximumAge: GEO_MAX_AGE_MS,
        })
        return pos
      } catch (err) {
        lastErr = err
        if (Number(err?.code || 0) === 3) {
          try {
            const pos = await requestPosition({
              enableHighAccuracy: false,
              timeout: Math.max(12000, GEO_TIMEOUT_MS),
              maximumAge: Math.max(60000, GEO_MAX_AGE_MS),
            })
            return pos
          } catch (fallbackErr) {
            lastErr = fallbackErr
          }
        }
        if (Number(err?.code || 0) === 1) break
      }
    }
    throw lastErr || new Error('Unable to fetch location. Please retry.')
  }

  async function updateLocation(options = {}) {
    const { sessionToken = token, silent = false, enforce = false } = options
    try {
      const pos = await fetchFreshLocation()
      const claims = decodeToken(sessionToken || '') || {}
      const nextGeo = {
        lat: String(pos.coords.latitude),
        lng: String(pos.coords.longitude),
        accuracy: String(pos.coords.accuracy || ''),
        capturedAtMs: String(Date.now()),
        sessionJti: String(claims.jti || ''),
      }
      setGeo(nextGeo)
      return nextGeo
    } catch (err) {
      if (enforce) {
        setGeo({ lat: '', lng: '', accuracy: '', capturedAtMs: '', sessionJti: '' })
        throw new Error(getGeoErrorMessage(err))
      }
      if (!silent) {
        setError(getGeoErrorMessage(err))
      }
      return null
    }
  }

  async function changePassword() {
    if (!token) return
    if (!currentPassword || !newPassword) {
      setError('Current and new password are required')
      return
    }
    const passwordIssue = validatePasswordInput(newPassword, 'New password')
    if (passwordIssue) {
      setError(passwordIssue)
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
    const activeToken = readValidToken(USER_KEY, 'user', { allowExpired: true }) || token
    if (!activeToken) {
      logout()
      return
    }
    if (!videoRef.current || !canvasRef.current || !cameraOn) {
      setError('Start camera first')
      return
    }
    if (scanInFlightRef.current) return
    scanInFlightRef.current = true
    setIsScanning(true)

    try {
      setChallengeInstruction('Keep your face centered and hold steady for a moment.')
      setStatus('Scanning...')
      const canvas = canvasRef.current
      const video = videoRef.current
      const srcW = video.videoWidth || 640
      const srcH = video.videoHeight || 480
      const mobile = isMobileViewport()
      const cropFactor = mobile ? 0.82 : 1
      const cropW = Math.max(1, Math.round(srcW * cropFactor))
      const cropH = Math.max(1, Math.round(srcH * cropFactor))
      const cropX = Math.max(0, Math.round((srcW - cropW) / 2))
      const cropY = Math.max(0, Math.round((srcH - cropH) / 2))
      const targetW = mobile ? 360 : 480
      const targetH = Math.round(targetW * (cropH / cropW))
      canvas.width = targetW
      canvas.height = targetH
      const ctx = canvas.getContext('2d')
      const tokenClaims = decodeToken(activeToken || '') || {}
      const sessionJti = String(tokenClaims.jti || '')
      const geoAgeMs = Date.now() - Number(geo?.capturedAtMs || 0)
      const useCachedGeo = Boolean(
        geo?.lat
        && geo?.lng
        && geo?.capturedAtMs
        && String(geo?.sessionJti || '') === sessionJti
        && geoAgeMs >= 0
        && geoAgeMs <= 20000,
      )
      const freshGeo = useCachedGeo
        ? geo
        : await updateLocation({ sessionToken: activeToken, enforce: true, silent: true })
      let data = null
      let lastErr = null
      const maxRetries = 1

      for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
        try {
          ctx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, canvas.width, canvas.height)
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.65))
          if (!blob) throw new Error('Unable to capture scan image')
          const formData = new FormData()
          formData.append('image', blob, 'scan.jpg')
          if (freshGeo?.lat && freshGeo?.lng) {
            formData.append('lat', freshGeo.lat)
            formData.append('lng', freshGeo.lng)
          }
          if (freshGeo?.accuracy) formData.append('accuracy', freshGeo.accuracy)
          if (freshGeo?.capturedAtMs) formData.append('location_captured_at_ms', freshGeo.capturedAtMs)
          if (freshGeo?.sessionJti) formData.append('location_session_jti', freshGeo.sessionJti)

          data = await apiFetch('/scan_attendance', {
            method: 'POST',
            body: formData,
            timeoutMs: 2000,
            retries: 0,
          }, activeToken)

          if (data?.status === 'wrong_data') {
            const e = new Error(String(data?.message || 'Scan failed'))
            e.status = 422
            throw e
          }

          if (data) break
        } catch (err) {
          lastErr = err
          const statusCode = Number(err?.status || err?.code || 0)
          const text = String(err?.message || '').toLowerCase()
          const retryableScanError = (
            statusCode === 422
            || !!err?.retryable
            || text.includes('scan')
            || text.includes('face')
            || text.includes('align')
            || text.includes('liveness')
            || text.includes('unable to verify')
          )
          if (attempt < maxRetries && retryableScanError) {
            await new Promise((resolve) => setTimeout(resolve, 300 * attempt))
            continue
          }
          throw err
        }
      }

      if (!data) {
        if (lastErr) throw lastErr
        throw new Error('Unable to scan attendance. Please retry.')
      }

      if (data?.status) {
        setAttendanceState(String(data.status).toLowerCase())
      }
      const nextTimes = {
        checkIn: formatAttendanceTimeFromUtc(data?.check_in_at, data?.check_in || attendanceTimes.checkIn, data?.date),
        checkOut: formatAttendanceTimeFromUtc(data?.check_out_at, data?.check_out || attendanceTimes.checkOut, data?.date),
      }
      setAttendanceTimes((old) => ({
        checkIn: formatAttendanceTimeFromUtc(data?.check_in_at, data?.check_in || old.checkIn, data?.date),
        checkOut: formatAttendanceTimeFromUtc(data?.check_out_at, data?.check_out || old.checkOut, data?.date),
      }))
      setAttendanceUtcTimes((old) => ({
        checkInAt: String(data?.check_in_at || old.checkInAt || ''),
        checkOutAt: String(data?.check_out_at || old.checkOutAt || ''),
      }))
      writeAttendanceCache(activeToken, {
        status: String(data?.status || attendanceState || '').toLowerCase(),
        checkIn: nextTimes.checkIn,
        checkOut: nextTimes.checkOut,
      })

      // Show business timing label (On Time / Late / On Time Exit / Left Early) in UI feedback.
      const timingStatus = String(data?.timing_status || data?.attendance_status?.status || '').trim()
      const baseMessage = data.message || data.status || 'Attendance scanned'
      const text = timingStatus ? `${baseMessage} - ${timingStatus}` : baseMessage
      setStatus(text)
      setMessage('Attendance processed')
      setError('')
      setChallengeInstruction('')
      clearRetryAction()
      if (['checked_in', 'checked_out', 'already_recorded'].includes(String(data.status || ''))) {
        const title = data.status === 'already_recorded' ? 'Already Marked' : 'Attendance Marked'
        const popupBody = timingStatus ? `Attendance marked - ${timingStatus}` : text
        showPopup('success', title, popupBody)
        await refreshTodayAttendance(activeToken)
        stopCamera()
      }
    } catch (err) {
      clearRetryAction()
      const text = String(err?.message || '')
      if (/location\s+token\s+mismatch|invalid\s+token|please\s+log\s*in\s+again|unauthorized/i.test(text)) {
        localStorage.removeItem(USER_KEY)
        setToken('')
        setEmployee(null)
        setGeo({ lat: '', lng: '', accuracy: '', capturedAtMs: '', sessionJti: '' })
        setError('Session expired. Please login again.')
        return
      }
      setError(err.message)
      if (!silent) {
        showPopup('error', 'Scan Failed', err.message)
      }
    } finally {
      scanInFlightRef.current = false
      setIsScanning(false)
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

  function openManualRequestModal(requestType = 'wfh') {
    setError('')
    setManualModalNotice({ type: '', text: '' })
    setManualForm({
      requestType: String(requestType || 'wfh').toLowerCase() === 'wfh' ? 'wfh' : 'outside_office',
      reason: String(requestType || 'wfh').toLowerCase() === 'wfh' ? 'Working from home' : 'Outside office geofence',
    })
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
      if (manualPhotoBlob) {
        formData.append('image', manualPhotoBlob, 'manual_request.jpg')
      }

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

  function performLocalLogout() {
    stopCamera()
    stopManualCamera()
    localStorage.removeItem(USER_KEY)
    setToken('')
    setEmployee(null)
    setAttendanceState('')
    setAttendanceTimes({ checkIn: '', checkOut: '' })
    setAttendanceUtcTimes({ checkInAt: '', checkOutAt: '' })
    setMyTasks([])
    setTaskStatusDraft({})
    setTaskCommentDraft({})
    setTaskChecklistState({})
    setTaskProofs({})
    setTaskUpdates({})
    setTaskTimers({})
    setBellToast({ show: false, title: '', message: '', type: 'info' })
    setEmployeeNotifications([])
    setEmployeeNotifOpen(false)
    setGeo({ lat: '', lng: '', accuracy: '', capturedAtMs: '', sessionJti: '' })
    setStatus('Logged out')
    setChallengeInstruction('')
    clearRetryAction()
  }

  function logout() {
    performLocalLogout()
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
    if (remaining <= 0) return
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
        setSessionExpiringSoon('Session refresh failed. You can continue and logout manually when done.')
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

  useEffect(() => {
    if (!token) return undefined
    refreshTodayAttendance(token)
    const id = setInterval(() => {
      refreshTodayAttendance(token)
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return undefined
    loadMyTasks(token)
    const id = setInterval(() => {
      loadMyTasks(token)
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return
    const cached = readTasksFromLocalStorage()
    if (Array.isArray(cached) && cached.length) {
      setMyTasks(cached)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return undefined
    const onFocus = () => loadMyTasks(token)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token) return undefined
    const onFocus = () => refreshTodayAttendance(token)
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    const anyRunning = Object.values(taskTimers || {}).some((t) => !!t?.running)
    const hasLiveAttendanceClock = (() => {
      const inMs = parseBackendDateMs(attendanceUtcTimes.checkInAt || '')
      const outMs = parseBackendDateMs(attendanceUtcTimes.checkOutAt || '')
      return Number.isFinite(inMs) && !Number.isFinite(outMs)
    })()
    if (!anyRunning && !hasLiveAttendanceClock) return undefined
    const id = setInterval(() => setTimerTick((v) => v + 1), 1000)
    return () => clearInterval(id)
  }, [taskTimers, attendanceUtcTimes.checkInAt, attendanceUtcTimes.checkOutAt])

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

  const tokenClaims = decodeToken(token || '') || {}
  const locationReady = Boolean(
    geo.lat
    && geo.lng
    && geo.capturedAtMs
    && geo.sessionJti
    && String(geo.sessionJti) === String(tokenClaims.jti || ''),
  )
  const statusText = String(status || '')
  const todayCheckedIn = (
    ['checked_in', 'checked_out', 'already_recorded'].includes(String(attendanceState || '').toLowerCase())
    || Boolean(attendanceTimes.checkIn || attendanceTimes.checkOut)
    || /already\s+marked|entry\s+marked|check[_\s-]?in|check[_\s-]?out|bye\s+bye/i.test(statusText)
  )
  const attendanceStatus = String(attendanceState || '').toLowerCase()
  const canPunchIn = !['checked_in', 'checked_out', 'already_recorded', 'absent', 'leave_marked'].includes(attendanceStatus)
  const canPunchOut = attendanceStatus === 'checked_in'
  const geofenceDisabled = /location\s+verification\s+is\s+disabled\s+by\s+admin|geofence_disabled|geofence\s+is\s+disabled/i.test(`${status} ${error} ${message}`)
  const geofenceOutside = /outside\s+office\s+geofence|outside\s+geofence/i.test(`${status} ${error} ${message}`)
  const checkedInAtText = attendanceTimes.checkIn || '--'
  const checkedOutAtText = attendanceTimes.checkOut || '--'
  const liveNowMs = Date.now() + (timerTick * 0)
  const normalizedTasks = (myTasks || []).map((task) => {
    const backendStatus = String(task.status || '').toLowerCase()
    const raw = backendStatus === 'approved'
      ? 'approved'
      : String(taskStatusDraft[task.id] || task.status || 'not_started').toLowerCase()
    const deadlineMs = new Date(task.deadline || '').getTime()
    const overdue = raw !== 'completed' && raw !== 'approved' && Number.isFinite(deadlineMs) && deadlineMs < liveNowMs
    const statusNorm = overdue ? 'overdue' : raw
    const timer = taskTimers[task.id] || { running: false, startedAtMs: 0, elapsedSec: 0 }
    const liveSec = timer.running ? Math.max(0, Math.floor((liveNowMs - (timer.startedAtMs || liveNowMs)) / 1000)) : 0
    const elapsedSec = Number(timer.elapsedSec || 0) + liveSec
    const checklistItems = (Array.isArray(task.checklist_items) ? task.checklist_items : []).map((item, idx) => {
      const done = !!(item?.done ?? item?.completed)
      return {
        ...(item || {}),
        id: item?.id ?? idx,
        done,
        completed: done,
      }
    })
    const checklistState = checklistItems.map((i) => !!(i?.done ?? i?.completed))
    const checklistDone = checklistState.filter(Boolean).length
    const checklistTotal = checklistItems.length
    const checklistDrivenStatus = checklistTotal > 0
      ? (checklistDone === checklistTotal ? 'completed' : (checklistDone > 0 ? 'in_progress' : 'not_started'))
      : statusNorm
    const finalStatusNorm = backendStatus === 'approved' ? 'approved' : checklistDrivenStatus
    return {
      ...task,
      statusNorm: finalStatusNorm,
      timer,
      elapsedSec,
      checklistItems,
      checklistState,
      checklistDone,
      checklistTotal,
      proofs: taskProofs[task.id] || [],
      updates: taskUpdates[task.id] || [],
    }
  })
  const activeTaskRows = normalizedTasks.filter((t) => t.statusNorm !== 'approved')
  const visibleTaskRows = normalizedTasks.filter((t) => {
    if (t.statusNorm === 'approved') return false
    return true
  })
  const pendingTasks = activeTaskRows.filter((t) => !['completed'].includes(t.statusNorm)).length
  const completedTasks = activeTaskRows.filter((t) => t.statusNorm === 'completed').length
  const overdueTasks = activeTaskRows.filter((t) => t.statusNorm === 'overdue').length
  const checkInMs = parseBackendDateMs(attendanceUtcTimes.checkInAt || '')
  const checkOutMs = parseBackendDateMs(attendanceUtcTimes.checkOutAt || '')
  const totalWorkedSec = Number.isFinite(checkInMs)
    ? Math.max(0, Math.floor(((Number.isFinite(checkOutMs) ? checkOutMs : Date.now()) - checkInMs) / 1000))
    : 0
  const hoursWorkedText = formatDuration(totalWorkedSec)
  const currentHour = new Date().getHours()
  const currentShift = currentHour < 12 ? 'Morning' : (currentHour < 18 ? 'Day' : 'Evening')
  const dueTodayCount = visibleTaskRows.filter((t) => String(t.deadline || '').slice(0, 10) === formatDateInput()).length
  const prioritizedTasks = visibleTaskRows
    .slice()
    .sort((a, b) => {
      const aMs = new Date(a.deadline || '').getTime()
      const bMs = new Date(b.deadline || '').getTime()
      if (!Number.isFinite(aMs) && !Number.isFinite(bMs)) return 0
      if (!Number.isFinite(aMs)) return 1
      if (!Number.isFinite(bMs)) return -1
      return aMs - bMs
    })
  const employeePopupTask = normalizedTasks.find((t) => String(t.id || '') === String(employeeWorkPopup.taskId || '')) || null
  const oneHourAlerts = visibleTaskRows.filter((t) => {
    if (t.statusNorm === 'completed') return false
    const due = new Date(t.deadline || '').getTime()
    if (!Number.isFinite(due)) return false
    const diff = due - Date.now()
    return diff > 0 && diff <= (60 * 60 * 1000)
  }).length
  return (
    <main className="page attendance-shell employee-workspace-page">
      <section className="card employee-hero">
        <div>
          <h2>Welcome back, {employee?.name || 'Employee'}</h2>
        </div>
        <div className="employee-hero-badges">
          <span className={`status-badge ${todayCheckedIn ? 'ok' : ''}`}>Attendance: {todayCheckedIn ? 'Marked' : 'Pending'}</span>
          <button
            type="button"
            className="status-badge theme-pill-toggle"
            onClick={() => setDarkMode((value) => !value)}
            aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkMode ? '🌙 Dark' : '☀️ Light'}
          </button>
        </div>
      </section>

      <section className="employee-workspace-grid">
        <div className="employee-main-column">
          <div className="employee-stats-grid">
            <article className="employee-stat-card"><p>Attendance Marked</p><strong>{todayCheckedIn ? 'Yes' : 'No'}</strong></article>
            <article className="employee-stat-card"><p>Checked In</p><strong>{checkedInAtText}</strong></article>
            <article className="employee-stat-card"><p>Checked Out</p><strong>{checkedOutAtText}</strong></article>
            <article className="employee-stat-card"><p>Hours Worked Today</p><strong>{hoursWorkedText}</strong></article>
          </div>

          {employee?.must_change_password && (
            <div className="card nested-card">
              <h3>Change Password</h3>
              <p className="muted small">Minimum 6 characters, include at least 1 number, no maximum length</p>
              <div className="row">
                <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                <input type="password" placeholder="New password (min 6 + at least 1 number)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                <button onClick={changePassword}>Update Password</button>
              </div>
            </div>
          )}
        </div>

        <aside className="employee-right-column card">
          <div className="employee-right-sticky">
            <h3>Productivity Panel</h3>
            <div className="employee-right-grid">
              <article className="status-card ok"><span className="status-label">Attendance</span><strong>{todayCheckedIn ? 'Marked' : 'Pending'}</strong></article>
              <article className="status-card"><span className="status-label">Check In / Out</span><strong>{checkedInAtText} / {checkedOutAtText}</strong></article>
              <article className="status-card"><span className="status-label">Daily Hours</span><strong>{hoursWorkedText}</strong></article>
            </div>

            <div className="employee-quick-actions">
              <h4>Quick Actions</h4>
              <button type="button" className="ghost" onClick={() => punchAttendance('in')} disabled={!canPunchIn}>Punch In</button>
              <button type="button" className="ghost" onClick={() => punchAttendance('out')} disabled={!canPunchOut}>Punch Out</button>
              <button type="button" className="ghost" onClick={openAttendanceHistoryModal}>Show History</button>
              <button type="button" className="ghost" onClick={() => openManualRequestModal('wfh')}>WFH Attendance Request</button>
              <button type="button" className="ghost" onClick={logout}>Logout</button>
            </div>
          </div>
        </aside>
      </section>

      {employeeWorkPopup.open && (
        <div className="modal-overlay" onClick={() => setEmployeeWorkPopup({ open: false, taskId: '' })}>
          <div className="modal-card employee-work-popup-card" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>Work Details</h3>
              <button type="button" className="ghost" onClick={() => setEmployeeWorkPopup({ open: false, taskId: '' })}>Close</button>
            </div>
            {employeePopupTask ? (
              <div className="stack">
                <h4 style={{ margin: 0 }}>{employeePopupTask.title || 'Task'}</h4>
                <p className="muted small">{employeePopupTask.description || 'No description provided.'}</p>
                <div className="employee-task-summary employee-task-kv-grid">
                  <p className="employee-task-kv-item"><span>Assigned by</span><strong>{employeePopupTask.assigned_by || 'Admin'}</strong></p>
                  <p className="employee-task-kv-item"><span>Due</span><strong>{String(employeePopupTask.deadline || '').slice(0, 10) || '-'}</strong></p>
                  <p className="employee-task-kv-item"><span>Status</span><strong>{String(taskStatusDraft[employeePopupTask.id] || employeePopupTask.statusNorm || 'not_started').replace(/_/g, ' ')}</strong></p>
                </div>
                <div className="stack" style={{ gap: 6 }}>
                  <p className="muted small" style={{ margin: 0, fontWeight: 700 }}>Work Updates</p>
                  <div className="employee-history-list" style={{ maxHeight: '180px' }}>
                    {(Array.isArray(employeePopupTask.updates) ? employeePopupTask.updates : [])
                      .filter((row) => String(row?.text || '').trim())
                      .slice()
                      .sort((a, b) => String(b?.at || '').localeCompare(String(a?.at || '')))
                      .slice(0, 10)
                      .map((row, idx) => (
                        <article key={`work-popup-update-${idx}`} className="employee-history-item">
                          <p className="muted small" style={{ margin: 0 }}><strong>{row?.by || 'Update'}</strong></p>
                          <p className="muted small" style={{ margin: '2px 0 0' }}>{String(row?.text || '')}</p>
                        </article>
                      ))}
                    {!(Array.isArray(employeePopupTask.updates) && employeePopupTask.updates.some((row) => String(row?.text || '').trim())) && (
                      <p className="muted small" style={{ margin: 0 }}>No work updates yet.</p>
                    )}
                  </div>
                </div>
                <div className="row modal-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setTaskStatusDraft((old) => ({ ...old, [employeePopupTask.id]: String(old[employeePopupTask.id] || employeePopupTask.statusNorm || 'not_started') }))
                      setProgressEditorTaskId(employeePopupTask.id)
                      setEmployeeWorkPopup({ open: false, taskId: '' })
                    }}
                  >
                    Update Work
                  </button>
                </div>
              </div>
            ) : (
              <p className="muted small">Task not found. It may have been updated or removed.</p>
            )}
          </div>
        </div>
      )}

      {taskHistoryOpen && (
        <div className="modal-overlay" onClick={() => setTaskHistoryOpen(false)}>
          <div className="modal-card employee-tasks-modal-card" style={{ maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>My Attendance History (Last 1 Month)</h3>
              <button type="button" className="ghost" onClick={() => setTaskHistoryOpen(false)}>Close</button>
            </div>
            <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'end' }}>
              <div className="stack" style={{ gap: 4 }}>
                <label className="muted small">Days</label>
                <select value={attendanceHistoryDayRange} onChange={(e) => applyAttendanceHistoryDayRange(e.target.value)}>
                  <option value="7">Last 7 days</option>
                  <option value="15">Last 15 days</option>
                  <option value="30">Last 30 days</option>
                  <option value="60">Last 60 days</option>
                  <option value="90">Last 90 days</option>
                  <option value="custom">Custom range</option>
                </select>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <label className="muted small">From</label>
                <input
                  type="date"
                  value={attendanceHistoryFromDate}
                  onChange={(e) => {
                    setAttendanceHistoryDayRange('custom')
                    setAttendanceHistoryFromDate(e.target.value)
                  }}
                />
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <label className="muted small">To</label>
                <input
                  type="date"
                  value={attendanceHistoryToDate}
                  onChange={(e) => {
                    setAttendanceHistoryDayRange('custom')
                    setAttendanceHistoryToDate(e.target.value)
                  }}
                />
              </div>
              <button type="button" onClick={applyAttendanceHistoryDateRange} disabled={attendanceHistoryLoading}>
                {attendanceHistoryLoading ? 'Loading...' : 'Apply Filter'}
              </button>
            </div>
            <div className="task-list-table-wrap five-row-scroll" style={{ marginTop: 8, flex: 1, minHeight: 0, overflowY: 'auto' }}>
              <table className="directory-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Day</th>
                    <th>In</th>
                    <th>Out</th>
                    <th>Total Hours</th>
                    <th>Timing</th>
                    <th>Status</th>
                    <th>Mode</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {(attendanceHistoryRows || []).map((a) => (
                    <tr key={`history-${a.id || a.date}`}>
                      <td>{a.date || '-'}</td>
                      <td>{formatWeekdayFromDateKey(a.date)}</td>
                      <td>{a.check_in || '-'}</td>
                      <td>{a.check_out || '-'}</td>
                      <td>{formatWorkedHoursFromAttendanceRow(a)}</td>
                      <td>{String(resolveTimingStatus(a) || '-')}</td>
                      <td>{String(a.status || '-').replace(/_/g, ' ')}</td>
                      <td>{a.manual_entry ? 'MANUAL' : 'AUTO'}</td>
                      <td>{a.manual_reason || '-'}</td>
                    </tr>
                  ))}
                  {!attendanceHistoryLoading && !(attendanceHistoryRows || []).length && (
                    <tr>
                      <td colSpan={9}>
                        <p className="muted small">No attendance records found for selected range.</p>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {manualModalOpen && (
        <div className="modal-overlay" onClick={closeManualRequestModal}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>Work From Home Attendance Request</h3>
              <button type="button" className="ghost" onClick={closeManualRequestModal} disabled={manualSubmitting}>Close</button>
            </div>
            <p className="muted small">Submit this request when you are working from home and need admin approval for attendance.</p>

            <div className="stack">
              <p className="muted small" style={{ margin: 0 }}><strong>Request Type:</strong> Work From Home</p>

              <label className="muted small">Reason / Details</label>
              <textarea
                rows={3}
                placeholder="I am working from home today due to..."
                value={manualForm.reason}
                onChange={(e) => setManualForm((old) => ({ ...old, reason: e.target.value }))}
              />

              {!!manualModalNotice.text && (
                <div className={manualModalNotice.type === 'success' ? 'success' : 'error'}>{manualModalNotice.text}</div>
              )}

              <div className="row modal-actions" style={{ marginTop: 4 }}>
                <button type="button" className="ghost" onClick={closeManualRequestModal} disabled={manualSubmitting}>Cancel</button>
                <button type="button" onClick={submitManualRequest} disabled={manualSubmitting}>
                  {manualSubmitting ? 'Submitting...' : 'Submit Request'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {checkoutSummaryModal.open && (
        <div className="modal-overlay" onClick={() => {
          setCheckoutSummaryModal((old) => ({ ...old, open: false }))
        }}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>Check-out summary</h3>
            </div>
            <div className="stack">
              <p className="muted small">Tasks completed today: <strong>{checkoutSummaryModal.tasksCompletedToday}</strong></p>
              <p className="muted small">Pending tasks: <strong>{checkoutSummaryModal.pendingTasks}</strong></p>
            </div>
            <div className="row modal-actions" style={{ marginTop: 10 }}>
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setCheckoutSummaryModal((old) => ({ ...old, open: false }))
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setCheckoutSummaryModal((old) => ({ ...old, open: false }))
                  performLocalLogout()
                }}
              >
                Logout
              </button>
            </div>
          </div>
        </div>
      )}

      {!!message && <div className="success">{message}</div>}
      {!!error && (
        <div className="error row between">
          <span>{error}</span>
          {!!retryAction && <button type="button" className="ghost" onClick={retryAction}>{retryLabel || 'Retry'}</button>}
        </div>
      )}
      {popup.show && (
        <div className={`scan-popup ${popup.type === 'error' ? 'error' : 'success'}`} role="status" aria-live="polite">
          <strong>{popup.title || (popup.type === 'error' ? 'Error' : 'Success')}</strong>
          <p>{popup.message}</p>
        </div>
      )}
      {bellToast.show && (
        <div className={`bell-toast ${bellToast.type}`} role="status" aria-live="polite">
          <div className="bell-toast-icon" aria-hidden="true">🔔</div>
          <div>
            <strong>{bellToast.title || 'Notification'}</strong>
            <p>{bellToast.message}</p>
          </div>
          <button type="button" className="bell-toast-close" aria-label="Dismiss notification" onClick={hideBellToast}>✕</button>
        </div>
      )}
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
