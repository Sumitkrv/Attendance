import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import {
  Bell,
  BarChart3,
  Building2,
  CalendarDays,
  CalendarCheck2,
  CalendarClock,
  ChevronRight,
  Clock,
  FileText,
  Fingerprint,
  History,
  Home,
  LayoutDashboard,
  LogOut,
  ListChecks,
  Menu,
  Moon,
  Power,
  ScanFace,
  Settings,
  Sun,
  Users,
} from 'lucide-react'
import { apiFetch } from '../api'
import {
  ADMIN_KEY,
  USER_KEY,
  USER_ATTENDANCE_CACHE_KEY,
  UI_THEME_KEY,
  TASK_SYNC_EVENT_KEY,
  TASK_SYNC_LOCAL_EVENT,
  SESSION_REFRESH_CHECK_MS,
  SESSION_REFRESH_BEFORE_MS,
  SESSION_EXPIRING_SOON_MS,
  GEO_TIMEOUT_MS,
  GEO_MAX_AGE_MS,
  GEO_RETRY_COUNT,
  APP_TIME_ZONE,
  COMPLETED_VISIBLE_MS,
  PASSWORD_MIN_LENGTH,
  BRAND_NAME,
  BRAND_LOGO_SRC,
} from '../config/constants'
import {
  validatePasswordInput,
  createTaskBlock,
  publishTaskSync,
  readDarkModePreference,
  applyThemePreference,
  readAttendanceCache,
  writeAttendanceCache,
  formatDateInput,
  dateKeyOffsetFromToday,
  dateKeyShift,
  formatWeekdayFromDateKey,
  isWeekendDateKey,
  listDateKeysInRange,
  formatTimeInIST,
  formatTimeAgo,
  formatTime12Hour,
  formatMinutesAs12Hour,
  formatBytes,
  parseBackendDateMs,
  dateKeyInIST,
  formatAttendanceTimeFromUtc,
  normalizeAttendanceRow,
  getTaskReferenceMs,
  isTaskWithinLastDays,
  decodeToken,
  tokenRemainingMs,
  readValidToken,
  isRetryableError,
} from '../utils/helpers'
import LoginCard from '../components/common/LoginCard'
import AttendanceHistoryCorrectionPanel from '../components/employee/AttendanceHistoryCorrectionPanel'
import EmployeeAssetsModule from '../components/employee/EmployeeAssetsModule'
import LeaveManagementPanel from '../components/employee/LeaveManagementPanel'
import CurrentCompanyBanner from '../components/common/CurrentCompanyBanner'
import SidebarItem from '../components/common/SidebarItem'
import SidebarSection from '../components/common/SidebarSection'
import SidebarToggle from '../components/common/SidebarToggle'
import PayslipDoc, { buildPayslipDocPropsFromPublishedRow } from '../components/payroll/PayslipDoc'

/** Best-effort hours from attendance history rows (Mongo / serializer field names vary).
 * Falls back to deriving from check_in_at / check_out_at when stored hours are absent.
 */
function employeeHistoryHours(row = {}) {
  const keys = ['net_work_hours', 'working_hours', 'work_hours', 'total_hours', 'hours_worked', 'hours']
  for (const k of keys) {
    const n = Number(row[k])
    if (Number.isFinite(n) && n > 0) return n
  }

  const inAt = row.check_in_at || row.checkInAt || row.check_in_time
  const outAt = row.check_out_at || row.checkOutAt || row.check_out_time
  if (inAt && outAt) {
    const start = new Date(inAt).getTime()
    const end = new Date(outAt).getTime()
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
      return Math.round(((end - start) / 3_600_000) * 100) / 100
    }
  }
  return null
}

function employeeHistoryCheckInDisplay(row = {}) {
  return row.check_in || row.checkIn || '--'
}

function formatHistHoursCell(row = {}) {
  const h = employeeHistoryHours(row)
  if (h == null || !Number.isFinite(h)) return '—'
  const rounded = Math.round(h * 10) / 10
  return `${rounded}h`
}

function historyStatusDisplay(row = {}) {
  const t = String(row.timing_status || '').trim()
  if (t) return t
  return String(row.status || '—').replace(/_/g, ' ')
}

function historyLogStatusSuffix(row = {}) {
  const tone = attendanceStatusTone(row)
  if (tone === 'present') return 'present'
  if (tone === 'wfh') return 'wfh'
  if (tone === 'leave') return 'leave'
  if (tone === 'absent') return 'absent'
  if (tone === 'muted') return 'muted'
  return 'other'
}

function attendanceStatusTone(row = {}) {
  const status = String(row.status || '').toLowerCase()
  const timing = String(row.timing_status || '').toLowerCase()
  if (status.includes('leave') || timing.includes('leave')) return 'leave'
  if (status.includes('absent')) return 'absent'
  if (status.includes('holiday')) return 'muted'
  if (status.includes('checked') || timing.includes('wfh')) return /wfh/.test(timing + status) ? 'wfh' : 'present'
  return 'other'
}

/** PDF report for attendance history popup (loads jsPDF lazily). */
async function buildEmployeeAttendanceHistoryPdfBlob({
  rows = [],
  employeeName = '',
  fromDate = '',
  toDate = '',
  brandName = BRAND_NAME,
}) {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const margin = 12
  const pageW = doc.internal.pageSize.getWidth()
  const pageH = doc.internal.pageSize.getHeight()
  let y = margin

  doc.setFontSize(15)
  doc.setFont(undefined, 'bold')
  doc.text(`${String(brandName || 'HRMS')} — Attendance History`, margin, y)
  doc.setFont(undefined, 'normal')
  y += 7
  doc.setFontSize(10)
  doc.text(`Employee: ${String(employeeName || '—')}`, margin, y)
  y += 5
  doc.text(`Period: ${String(fromDate || '—')} to ${String(toDate || '—')}`, margin, y)
  y += 5
  try {
    doc.text(`Generated: ${new Date().toLocaleString('en-IN', { timeZone: APP_TIME_ZONE })}`, margin, y)
  } catch {
    doc.text(`Generated: ${new Date().toISOString()}`, margin, y)
  }
  y += 10

  const sorted = [...(rows || [])]
    .filter((r) => r && typeof r === 'object')
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))

  const headers = ['Date', 'Day', 'Check-in', 'Check-out', 'Hours', 'Attendance']
  doc.setFontSize(9)
  doc.setFont(undefined, 'bold')
  doc.text(headers[0], margin, y)
  doc.text(headers[1], margin + 26, y)
  doc.text(headers[2], margin + 40, y)
  doc.text(headers[3], margin + 62, y)
  doc.text(headers[4], margin + 84, y)
  doc.text(headers[5], margin + 100, y)
  doc.setFont(undefined, 'normal')
  y += 6
  doc.setLineWidth(0.15)
  doc.line(margin, y - 1, pageW - margin, y - 1)
  y += 3

  if (!sorted.length) {
    doc.setFontSize(10)
    doc.text('No attendance records in this period.', margin, y)
    return doc.output('blob')
  }

  doc.setFontSize(9)

  sorted.forEach((row) => {
    const dk = String(row.date || '').trim()
    const cols = [
      dk.slice(0, 11) || '—',
      String(formatWeekdayFromDateKey(dk) || '—').slice(0, 10),
      String(row.check_in || row.checkIn || '—').slice(0, 14),
      String(row.check_out || row.checkOut || '—').slice(0, 14),
      String(formatHistHoursCell(row)).slice(0, 10),
    ]
    const statusPieces = doc.splitTextToSize(
      String(historyStatusDisplay(row) || '—').replace(/\s+/g, ' ').trim(),
      pageW - margin - 100,
    )
    const rowH = Math.max(6, Math.min(statusPieces.length * 4.6, 24))
    if (y + rowH > pageH - margin) {
      doc.addPage()
      y = margin
    }
    doc.text(cols[0], margin, y)
    doc.text(cols[1], margin + 26, y)
    doc.text(cols[2], margin + 40, y)
    doc.text(cols[3], margin + 62, y)
    doc.text(cols[4], margin + 84, y)
    doc.text(statusPieces, margin + 100, y)
    y += rowH + 2
  })

  return doc.output('blob')
}

const PAYSLIP_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December']

function monthYearLabel(year, month) {
  const y = Number(year)
  const m = Number(month)
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return '—'
  return `${PAYSLIP_MONTH_NAMES[m - 1]} ${y}`
}

function payslipKindLabel(row = {}) {
  const kind = String(row.payslip_kind || '').toLowerCase()
  if (kind === 'interim_mtd') return 'Interim (MTD)'
  return 'Final'
}

function formatINRWhole(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '₹0'
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export default function UserPage() {
  const navigate = useNavigate()
  const location = useLocation()
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
  const [leaveSubmitting, setLeaveSubmitting] = useState(false)
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
  const [attendanceHistoryModalOpen, setAttendanceHistoryModalOpen] = useState(false)
  const [attendanceHistoryPdfUrl, setAttendanceHistoryPdfUrl] = useState('')
  const [attendanceHistoryDayRange, setAttendanceHistoryDayRange] = useState('30')
  const [attendanceHistoryFromDate, setAttendanceHistoryFromDate] = useState(dateKeyOffsetFromToday(-29))
  const [attendanceHistoryToDate, setAttendanceHistoryToDate] = useState(formatDateInput())
  const [attendanceHistoryRows, setAttendanceHistoryRows] = useState([])
  const [dashboardWeekRows, setDashboardWeekRows] = useState([])
  const [dashboardRecentLogs, setDashboardRecentLogs] = useState([])
  const [dashboardLeaveBalance, setDashboardLeaveBalance] = useState(null)
  const [dashboardLatestPayslip, setDashboardLatestPayslip] = useState(null)
  const [payslipDownloading, setPayslipDownloading] = useState(false)
  const payslipExportHostRef = useRef(null)
  const [payslipExportJob, setPayslipExportJob] = useState(null)
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
  const [employeeSidebarCollapsed, setEmployeeSidebarCollapsed] = useState(false)
  const [employeeMobileSidebarOpen, setEmployeeMobileSidebarOpen] = useState(false)
  const [employeeSidebarExpandedSection, setEmployeeSidebarExpandedSection] = useState('attendance')
  const [employeeSidebarActive, setEmployeeSidebarActive] = useState('dashboard')
  const [teamDirectorySearch, setTeamDirectorySearch] = useState('')
  const [teamDirectoryDeptFilter, setTeamDirectoryDeptFilter] = useState('all')
  const [holidayView, setHolidayView] = useState('list')
  const [teamDirectoryRows, setTeamDirectoryRows] = useState([])
  const [holidayRows, setHolidayRows] = useState([])
  const [performanceSnapshot, setPerformanceSnapshot] = useState(null)
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
  const attendanceHistoryPdfRevokeRef = useRef(null)

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

  function scrollToEmployeeSection(sectionId, activeKey) {
    if (!sectionId || typeof document === 'undefined') return
    const node = document.getElementById(sectionId)
    if (!node || typeof node.scrollIntoView !== 'function') {
      setEmployeeSidebarActive(activeKey || '')
      return
    }
    setEmployeeSidebarActive(activeKey || '')
    node.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setEmployeeMobileSidebarOpen(false)
  }

  function toggleEmployeeSidebarSection(sectionId) {
    if (!sectionId) return
    if (employeeSidebarCollapsed) {
      setEmployeeSidebarCollapsed(false)
      setEmployeeSidebarExpandedSection(sectionId)
      return
    }
    setEmployeeSidebarExpandedSection((old) => (old === sectionId ? '' : sectionId))
  }

  function goToEmployeeWorkspace(item, sectionId = '') {
    if (!item) return
    if (item.action === 'logout') {
      logout()
      setEmployeeMobileSidebarOpen(false)
      return
    }

    const itemId = String(item.id || item.key || '')
    const path = String(item.path || '')
    if (itemId) setEmployeeSidebarActive(itemId)
    if (sectionId) setEmployeeSidebarExpandedSection(sectionId)
    setEmployeeMobileSidebarOpen(false)

    if (path) {
      const samePath = String(location?.pathname || '') === path
      navigate(path)
      if (samePath && item.sectionId) {
        scrollToEmployeeSection(item.sectionId, itemId)
      }
      return
    }

    if (item.sectionId) {
      scrollToEmployeeSection(item.sectionId, itemId)
    }
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
    const attempts = [
      {
        ...base,
        video: mobile
          ? { facingMode: { ideal: kind === 'manual' ? 'user' : 'environment' } }
          : true,
      },
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
      const data = await apiFetch('/user/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          login_id: values.login_id.toLowerCase(),
          password: values.password,
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
      setError(rawMessage)
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

      let locationPayload = null
      if (punchAction === 'in') {
        const freshGeo = await updateLocation({ sessionToken: activeToken, enforce: true })
        locationPayload = {
          lat: freshGeo?.lat || '',
          lng: freshGeo?.lng || '',
          accuracy: freshGeo?.accuracy || '',
          location_captured_at_ms: freshGeo?.capturedAtMs || '',
          location_session_jti: freshGeo?.sessionJti || '',
        }
      }

      const endpoint = punchAction === 'in' ? '/user/mark_entry_on_login' : '/user/mark_exit_on_logout'
      const data = await apiFetch(
        endpoint,
        locationPayload
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(locationPayload),
            }
          : { method: 'POST' },
        activeToken,
      )
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

  async function markLeaveForToday() {
    const activeToken = readValidToken(USER_KEY, 'user', { allowExpired: true }) || token
    if (!activeToken) {
      setError('Please login first')
      return
    }

    try {
      setLeaveSubmitting(true)
      setError('')
      setRetryAction(null)
      setRetryLabel('')
      const data = await apiFetch('/user/mark_leave', { method: 'POST' }, activeToken)
      const rawStatus = String(data?.status || '').toLowerCase()
      const nextStatus = rawStatus === 'already_on_leave' ? 'leave_marked' : rawStatus

      setAttendanceState(nextStatus)
      setAttendanceTimes({ checkIn: '', checkOut: '' })
      setAttendanceUtcTimes({ checkInAt: '', checkOutAt: '' })
      writeAttendanceCache(activeToken, {
        status: nextStatus,
        checkIn: '',
        checkOut: '',
      })

      const feedback = data?.message || (nextStatus === 'leave_marked' ? 'Leave marked successfully' : 'Leave updated')
      setStatus(feedback)
      setMessage(feedback)
      showPopup('success', 'Leave Updated', feedback)
      await refreshTodayAttendance(activeToken)
    } catch (err) {
      const text = String(err?.message || 'Unable to mark leave')
      setError(text)
      if (isRetryableError(err)) {
        setRetryLabel('Retry leave mark')
        setRetryAction(() => () => markLeaveForToday())
      }
    } finally {
      setLeaveSubmitting(false)
    }
  }

  async function loadUserAttendanceHistory(fromDate = attendanceHistoryFromDate, toDate = attendanceHistoryToDate, nextToken = token) {
    if (!nextToken) return
    setAttendanceHistoryLoading(true)
    if (attendanceHistoryModalOpen) {
      setAttendanceHistoryPdfUrl('')
      if (attendanceHistoryPdfRevokeRef.current) {
        URL.revokeObjectURL(attendanceHistoryPdfRevokeRef.current)
        attendanceHistoryPdfRevokeRef.current = null
      }
    }
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

  useEffect(() => {
    if (!attendanceHistoryModalOpen || attendanceHistoryLoading) {
      return undefined
    }
    let cancelled = false
    ;(async () => {
      try {
        const blob = await buildEmployeeAttendanceHistoryPdfBlob({
          rows: attendanceHistoryRows,
          employeeName: String(employee?.name || ''),
          fromDate: attendanceHistoryFromDate,
          toDate: attendanceHistoryToDate,
        })
        if (cancelled) return
        if (attendanceHistoryPdfRevokeRef.current) {
          URL.revokeObjectURL(attendanceHistoryPdfRevokeRef.current)
          attendanceHistoryPdfRevokeRef.current = null
        }
        const url = URL.createObjectURL(blob)
        attendanceHistoryPdfRevokeRef.current = url
        setAttendanceHistoryPdfUrl(url)
      } catch {
        if (!cancelled) setAttendanceHistoryPdfUrl('')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    attendanceHistoryModalOpen,
    attendanceHistoryLoading,
    attendanceHistoryRows,
    attendanceHistoryFromDate,
    attendanceHistoryToDate,
    employee?.name,
  ])

  useEffect(() => {
    if (!token) return undefined
    const path = String(location?.pathname || '').trim()
    if (path !== '/user' && path !== '/user/dashboard') return undefined
    let cancelled = false

    async function loadDashboardSnapshot() {
      try {
        const from = dateKeyOffsetFromToday(-6)
        const to = formatDateInput()
        const [lr, ar, ps] = await Promise.all([
          apiFetch('/user/leave_requests', {}, token),
          apiFetch(
            `/user/attendance_history?from_date=${encodeURIComponent(from)}&to_date=${encodeURIComponent(to)}`,
            {},
            token,
          ),
          apiFetch('/user/payroll/payslips', {}, token).catch(() => []),
        ])
        if (cancelled) return
        const bal = lr?.balance || {}
        setDashboardLeaveBalance({
          paid_total: Number(bal.paid_leave_total ?? 0),
          paid_used: Number(bal.paid_leave_used ?? 0),
          paid_pending: Number(bal.paid_leave_pending ?? 0),
          casual_total: Number(bal.casual_leave_total ?? 0),
          casual_used: Number(bal.casual_leave_used ?? 0),
          casual_pending: Number(bal.casual_leave_pending ?? 0),
          sick_total: Number(bal.sick_leave_total ?? 0),
          sick_used: Number(bal.sick_leave_used ?? 0),
          sick_pending: Number(bal.sick_leave_pending ?? 0),
        })
        const hist = Array.isArray(ar?.rows) ? ar.rows.map((r) => normalizeAttendanceRow(r)) : []
        setDashboardWeekRows(hist)
        setDashboardRecentLogs(hist.slice(0, 8))
        const slipsList = Array.isArray(ps) ? ps : []
        const latest = slipsList.find((s) => String(s?.status || '').toLowerCase() === 'published') || slipsList[0] || null
        setDashboardLatestPayslip(latest || null)
      } catch {
        if (!cancelled) {
          setDashboardLeaveBalance(null)
          setDashboardWeekRows([])
          setDashboardRecentLogs([])
          setDashboardLatestPayslip(null)
        }
      }
    }

    loadDashboardSnapshot()
    const onFocus = () => loadDashboardSnapshot()
    window.addEventListener('focus', onFocus)
    const tid = window.setInterval(loadDashboardSnapshot, 90000)
    return () => {
      cancelled = true
      window.removeEventListener('focus', onFocus)
      window.clearInterval(tid)
    }
  }, [token, location.pathname])

  useEffect(() => {
    if (!token) return undefined
    const path = String(location?.pathname || '').trim()
    let cancelled = false

    async function syncWorkspaceData() {
      if (path === '/user/team-directory') {
        try {
          const rows = await apiFetch('/user/directory', {}, token)
          if (!cancelled) setTeamDirectoryRows(Array.isArray(rows) ? rows : [])
        } catch {
          if (!cancelled) setTeamDirectoryRows([])
        }
        return
      }

      if (path === '/user/holidays') {
        try {
          const yr = new Date().getFullYear()
          const rows = await apiFetch(`/user/holidays?year=${encodeURIComponent(String(yr))}`, {}, token)
          if (!cancelled) setHolidayRows(Array.isArray(rows) ? rows : [])
        } catch {
          if (!cancelled) setHolidayRows([])
        }
        return
      }

      if (path === '/user/performance') {
        if (!cancelled) setPerformanceSnapshot(null)
        try {
          const claims = decodeToken(token) || {}
          const empId = String(claims.employee_id || '').trim()
          if (!empId) return

          const toDate = formatDateInput()
          const fromDate = dateKeyOffsetFromToday(-89)
          const snap = await apiFetch(
            `/api/analytics/employee-performance?employee_id=${encodeURIComponent(empId)}&from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`,
            {},
            token,
          )
          if (!cancelled) setPerformanceSnapshot(snap && typeof snap === 'object' ? snap : null)
        } catch {
          if (!cancelled) setPerformanceSnapshot(null)
        }
      }
    }

    syncWorkspaceData()
    return () => {
      cancelled = true
    }
  }, [token, location.pathname])

  useEffect(() => {
    if (!payslipExportJob) return undefined
    let cancelled = false

    const run = async () => {
      await new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve))
      })
      if (cancelled) return

      const host = payslipExportHostRef.current
      const el = host?.querySelector?.(".payslip-doc")
      if (!el) {
        setError("Payslip preview not ready. Please try again.")
        setPayslipExportJob(null)
        setPayslipDownloading(false)
        return
      }

      try {
        const html2canvas = (await import("html2canvas")).default
        const { jsPDF } = await import("jspdf")

        const canvas = await html2canvas(el, {
          scale: 2,
          useCORS: true,
          logging: false,
          backgroundColor: "#ffffff",
          scrollX: 0,
          scrollY: -window.scrollY,
        })

        const imgData = canvas.toDataURL("image/png", 1.0)
        const pdf = new jsPDF({ orientation: "p", unit: "mm", format: "a4" })
        const margin = 8
        const pageW = pdf.internal.pageSize.getWidth()
        const pageH = pdf.internal.pageSize.getHeight()
        const usableW = pageW - margin * 2
        const usableH = pageH - margin * 2

        const imgHmm = (canvas.height * usableW) / canvas.width
        let heightLeft = imgHmm
        let position = margin

        pdf.addImage(imgData, "PNG", margin, position, usableW, imgHmm)
        heightLeft -= usableH

        while (heightLeft > 0.5) {
          position = margin - (imgHmm - heightLeft)
          pdf.addPage()
          pdf.addImage(imgData, "PNG", margin, position, usableW, imgHmm)
          heightLeft -= usableH
        }

        pdf.save(payslipExportJob.fileName)
      } catch (err) {
        if (!cancelled) {
          setError(err?.message || "Unable to generate payslip PDF right now.")
        }
      } finally {
        if (!cancelled) {
          setPayslipExportJob(null)
          setPayslipDownloading(false)
        }
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [payslipExportJob])

  function downloadLatestEmployeePayslip() {
    const row = dashboardLatestPayslip
    if (!row) return
    if (row.status !== 'approved') {
      setError("Payslip is not yet approved by admin. Please wait for HR to finalize your payslip.")
      return
    }
    setPayslipDownloading(true)
    setError("")
    try {
      const props = buildPayslipDocPropsFromPublishedRow(row, employee)
      const safeName = String(props.employee?.name || "employee")
        .replace(/\s+/g, "_")
        .replace(/[^A-Za-z0-9_-]/g, "")
      setPayslipExportJob({
        props,
        fileName: `payslip_${safeName}_${row?.year || "YYYY"}_${row?.month || "MM"}.pdf`,
      })
    } catch (err) {
      setPayslipDownloading(false)
      setError(err?.message || "Unable to prepare payslip download.")
    }
  }


  function openAttendanceHistoryModal() {
    const fromDate = dateKeyOffsetFromToday(-29)
    const toDate = formatDateInput()
    setAttendanceHistoryDayRange('30')
    setAttendanceHistoryFromDate(fromDate)
    setAttendanceHistoryToDate(toDate)
    if (attendanceHistoryPdfRevokeRef.current) {
      URL.revokeObjectURL(attendanceHistoryPdfRevokeRef.current)
      attendanceHistoryPdfRevokeRef.current = null
    }
    setAttendanceHistoryPdfUrl('')
    setAttendanceHistoryModalOpen(true)
    loadUserAttendanceHistory(fromDate, toDate)
  }

  function closeAttendanceHistoryModal() {
    setAttendanceHistoryModalOpen(false)
    if (attendanceHistoryPdfRevokeRef.current) {
      URL.revokeObjectURL(attendanceHistoryPdfRevokeRef.current)
      attendanceHistoryPdfRevokeRef.current = null
    }
    setAttendanceHistoryPdfUrl('')
  }

  function downloadAttendanceHistoryPdf() {
    if (!attendanceHistoryPdfUrl) return
    const safe = String(employee?.name || 'employee')
      .replace(/\s+/g, '_')
      .replace(/[^A-Za-z0-9_-]/g, '')
    const a = document.createElement('a')
    a.href = attendanceHistoryPdfUrl
    a.download = `attendance_history_${safe}_${attendanceHistoryFromDate}_to_${attendanceHistoryToDate}.pdf`
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
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
      setEmployee({
        name: payload.employee_name,
        login_id: payload.login_id,
        department: 'General',
        must_change_password: payload.must_change_password,
      })
      await refreshTodayAttendance(token)
      await loadMyTasks(token)
    } catch (err) {
      setError(err?.message || 'Session validation failed. Please login again.')
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
    try {
      await updatePasswordCredentials(currentPassword, newPassword)
      setCurrentPassword('')
      setNewPassword('')
    } catch {
      // handled in helper
    }
  }

  async function updatePasswordCredentials(currentPwd, newPwd) {
    if (!token) return
    if (!currentPwd || !newPwd) {
      setError('Current and new password are required')
      throw new Error('Current and new password are required')
    }
    const passwordIssue = validatePasswordInput(newPwd, 'New password')
    if (passwordIssue) {
      setError(passwordIssue)
      throw new Error(passwordIssue)
    }
    try {
      const data = await apiFetch('/user/change_password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPwd, new_password: newPwd }),
      }, token)
      if (data.token) {
        localStorage.setItem(USER_KEY, data.token)
        setToken(data.token)
      }
      setEmployee(data.employee || employee)
      setMessage(data.message || 'Password updated')
      setError('')
      return data
    } catch (err) {
      setError(err.message)
      throw err
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

  useEffect(() => {
    const pathname = String(location?.pathname || '').trim()
    if (pathname === '/user' || pathname === '/user/dashboard') {
      setEmployeeSidebarActive('dashboard')
      setEmployeeSidebarExpandedSection('attendance')
      return
    }
    if (pathname === '/user/attendance') {
      setEmployeeSidebarActive('attendance-mark')
      setEmployeeSidebarExpandedSection('attendance')
      return
    }
    if (pathname === '/user/leave') {
      setEmployeeSidebarActive('leave-apply')
      setEmployeeSidebarExpandedSection('leave')
      return
    }
  }, [location.pathname])

  if (!token) {
    return (
      <main className="page center">
        <LoginCard
          title={`${BRAND_NAME} Employee Login`}
          message={error || `Use your ${BRAND_NAME} employee login credentials.`}
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
  // Allow punch-in when status is "absent" only as a placeholder (auto-absent / no check-in yet);
  // backend converts that row to a real check-in. "leave_marked" stays disabled.
  const canPunchIn = !['checked_in', 'checked_out', 'already_recorded', 'leave_marked'].includes(attendanceStatus)
  const canPunchOut = attendanceStatus === 'checked_in'
  const canMarkLeave = !['checked_in', 'checked_out', 'already_recorded', 'leave_marked'].includes(attendanceStatus)
  const punchInDisabledReason =
    attendanceStatus === 'leave_marked'
      ? 'You are marked on leave for today. Contact HR if this is wrong.'
      : ''
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

  const dashboardWeekWorkedHours = dashboardWeekRows.reduce((sum, row) => {
    const h = employeeHistoryHours(row)
    return sum + (typeof h === 'number' && Number.isFinite(h) ? h : 0)
  }, 0)

  const dashboardWeekBars = (() => {
    const end = formatDateInput()
    const map = new Map(
      dashboardWeekRows.map((r) => [String(r.date || '').slice(0, 10), r]),
    )
    const days = []
    for (let i = 6; i >= 0; i -= 1) {
      const dk = dateKeyShift(end, -i)
      const row = map.get(dk)
      const h = row ? employeeHistoryHours(row) : null
      days.push({
        key: dk,
        label: formatWeekdayFromDateKey(dk).slice(0, 3),
        pct: typeof h === 'number' && h > 0 ? Math.min(100, (h / 9) * 100) : 3,
      })
    }
    return days
  })()

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
  const unreadNotificationCount = (employeeNotifications || []).length
  const notificationBadgeCount = unreadNotificationCount
  const lastSessionRefreshLabel = sessionRefreshedAt ? formatTimeAgo(sessionRefreshedAt) : 'Not refreshed yet'
  const employeeFirstName = String(employee?.name || 'Employee').trim().split(/\s+/)[0] || 'Employee'
  const employeeRouteMeta = {
    dashboard: {
      path: '/user/dashboard',
      title: 'Employee Dashboard',
      subtitle: 'Track attendance, complete tasks, and stay synced with admin updates.',
      hint: 'Overview and day-to-day productivity dashboard.',
    },
    attendance: {
      path: '/user/attendance',
      title: 'My Attendance',
      subtitle: 'Attendance module for employee check-ins.',
      hint: 'Attendance module placeholder. Functional modules can be connected next.',
    },
    leave: {
      path: '/user/leave',
      title: 'Leave Management',
      subtitle: 'Apply leaves and review leave history and balances.',
      hint: 'Leave module placeholder. Policies and approval flow can be added next.',
    },
    assets: {
      path: '/user/assets',
      title: 'Assets',
      subtitle: 'Track assigned assets and raise new asset requests.',
      hint: 'Assets module placeholder. Assignment lifecycle can be attached next.',
    },
    profile: {
      path: '/user/profile',
      title: 'Profile',
      subtitle: 'Manage personal information, documents, and account security.',
      hint: 'Profile module placeholder. Detailed profile forms can be added next.',
    },
    support: {
      path: '/user/support',
      title: 'Support',
      subtitle: 'Access helpdesk support and company policies.',
      hint: 'Enterprise support desk with ticket history, policy access, and live HR/IT chat.',
    },
    performance: {
      path: '/user/performance',
      title: 'Performance',
      subtitle: 'Track KPIs, goals, and monthly performance summaries.',
      hint: 'Minimal performance insights with goals and manager notes.',
    },
    teamDirectory: {
      path: '/user/team-directory',
      title: 'Team Directory',
      subtitle: 'Find teammates and key contacts quickly.',
      hint: 'Searchable team directory with department filters.',
    },
    holidays: {
      path: '/user/holidays',
      title: 'Holidays',
      subtitle: 'Company holiday calendar and upcoming dates.',
      hint: 'Quick holiday reference with list and calendar view.',
    },
    notifications: {
      path: '/user/notifications',
      title: 'Notifications',
      subtitle: 'Track updates, reminders, and action items.',
      hint: 'Centralized company notification center with read/unread controls and archiving.',
    },
  }

  const performanceSummary = (() => {
    if (!performanceSnapshot) return { score: '—', kpiCompletion: '—', tasksCompleted: '—' }
    const att = performanceSnapshot.attendance || {}
    const tasks = performanceSnapshot.tasks || {}
    return {
      score: Math.round(Number(att.attendance_rate ?? 0)),
      kpiCompletion: Math.round(Number(tasks.completion_rate ?? 0)),
      tasksCompleted: Number(tasks.completed ?? 0),
    }
  })()

  const performanceRows = (() => {
    if (!performanceSnapshot) return []
    const p = performanceSnapshot.period || {}
    const att = performanceSnapshot.attendance || {}
    const tasks = performanceSnapshot.tasks || {}
    const wh = performanceSnapshot.working_hours || {}
    return [{
      month: `${p.from_date || ''} → ${p.to_date || ''}`,
      rating: '—',
      goals: `${tasks.completed ?? 0} / ${tasks.total ?? 0} tasks`,
      note: `Present ${att.present ?? 0} · Late ${att.late ?? 0} · Avg ${wh.average_daily ?? '—'}h / day`,
    }]
  })()

  const performanceGoals = (() => {
    if (!performanceSnapshot) return []
    const att = performanceSnapshot.attendance || {}
    const tasks = performanceSnapshot.tasks || {}
    return [
      {
        name: 'Attendance rate',
        progress: Math.min(100, Math.max(0, Math.round(Number(att.attendance_rate ?? 0)))),
        status: 'Reporting period',
      },
      {
        name: 'Task completion',
        progress: Math.min(100, Math.max(0, Math.round(Number(tasks.completion_rate ?? 0)))),
        status: Number(tasks.total ?? 0) > 0 ? 'Tasks in range' : 'No tasks assigned',
      },
    ]
  })()

  const teamDepartments = ['all', ...Array.from(new Set((teamDirectoryRows || []).map((row) => row.department)))]
  const teamQuery = teamDirectorySearch.trim().toLowerCase()
  const filteredTeamDirectory = (teamDirectoryRows || []).filter((row) => {
    const matchesDept = teamDirectoryDeptFilter === 'all' || String(row.department).toLowerCase() === String(teamDirectoryDeptFilter).toLowerCase()
    if (!matchesDept) return false
    if (!teamQuery) return true
    return [row.name, row.role, row.email, row.phone, row.department, row.login_id]
      .some((val) => String(val || '').toLowerCase().includes(teamQuery))
  })

  const todayKey = formatDateInput()
  const upcomingHolidays = (holidayRows || []).filter((row) => row.date >= todayKey).slice(0, 6)
  const employeeSidebarSections = [
    {
      id: 'attendance',
      icon: ScanFace,
      label: 'Time & Attendance',
      items: [
        { id: 'attendance-mark', label: 'Attendance', icon: ScanFace, path: '/user/attendance' },
        { id: 'leave-apply', label: 'Leave', icon: CalendarClock, path: '/user/leave' },
      ],
    },
  ]
  const currentEmployeeRoute = (() => {
    const pathname = String(location?.pathname || '').trim()
    if (!pathname || pathname === '/user' || pathname === '/user/dashboard') return 'dashboard'
    if (pathname === '/user/attendance') return 'attendance'
    if (pathname === '/user/leave') return 'leave'
    if (pathname === '/user/performance') return 'performance'
    if (pathname === '/user/team-directory') return 'teamDirectory'
    if (pathname === '/user/holidays') return 'holidays'
    if (pathname === '/user/assets') return 'assets'
    return 'dashboard'
  })()
  const currentRouteMeta = employeeRouteMeta[currentEmployeeRoute] || employeeRouteMeta.dashboard
  const isDashboardRoute = currentEmployeeRoute === 'dashboard'
  return (
    <main className="page hrms-shell employee-workspace-page">
      {employeeMobileSidebarOpen && (
        <div className="hrms-sidebar-backdrop" onClick={() => setEmployeeMobileSidebarOpen(false)} aria-hidden="true" />
      )}
      <div className={`hrms-app-layout ${employeeSidebarCollapsed ? 'sidebar-collapsed' : ''}`}>

        {/* ═══════════ SIDEBAR ═══════════ */}
        <aside className={`hrms-v2-sidebar ${employeeMobileSidebarOpen ? 'mobile-open' : ''}`}>

          {/* Brand row */}
          <div className="hrms-v2-brand">
            <div className="hrms-v2-brand-inner">
              <img src={BRAND_LOGO_SRC} alt={BRAND_NAME} className="hrms-v2-logo" />
              {!employeeSidebarCollapsed && (
                <div className="hrms-v2-brand-text">
                  <span className="hrms-v2-brand-name">{BRAND_NAME}</span>
                  <span className="hrms-v2-brand-sub">ENTERPRISE</span>
                </div>
              )}
            </div>
            <SidebarToggle collapsed={employeeSidebarCollapsed} onToggle={() => setEmployeeSidebarCollapsed((old) => !old)} />
          </div>

          {/* Nav groups */}
          <nav className="hrms-v2-nav">
            {/* My Workspace */}
            <div className="hrms-v2-nav-group">
              {!employeeSidebarCollapsed && <span className="hrms-v2-group-label">My Workspace</span>}
              <SidebarItem
                icon={LayoutDashboard}
                label="Dashboard"
                active={currentEmployeeRoute === 'dashboard'}
                collapsed={employeeSidebarCollapsed}
                onClick={() => goToEmployeeWorkspace({ id: 'dashboard', path: '/user/dashboard', sectionId: 'employee-overview-section' }, 'attendance')}
              />
              
            </div>

            {/* Dynamic sections */}
            {employeeSidebarSections.map((section) => (
              <div key={section.id} className="hrms-v2-nav-group">
                {!employeeSidebarCollapsed && <span className="hrms-v2-group-label">{section.label}</span>}
                {section.items.map((item) => (
                  <SidebarItem
                    key={item.id}
                    icon={item.icon}
                    label={item.label}
                    collapsed={employeeSidebarCollapsed}
                    active={employeeSidebarActive === item.id}
                    onClick={() => goToEmployeeWorkspace(item, section.id)}
                  />
                ))}
              </div>
            ))}

            {/* Settings & Support removed per request */}
          </nav>

          {/* Sidebar footer: Need help + user */}
            <div className="hrms-v2-sidebar-footer">
            <div className="hrms-v2-footer-user-row">
              {!employeeSidebarCollapsed ? (
                <div className="hrms-v2-user-chip">
                  <span className="hrms-v2-user-avatar">{employeeFirstName.slice(0, 1).toUpperCase()}</span>
                  <div className="hrms-v2-user-info">
                    <span className="hrms-v2-user-name">{employee?.name || 'Employee'}</span>
                    <span className="hrms-v2-user-role">Employee</span>
                  </div>
                </div>
              ) : (
                <div className="hrms-v2-user-avatar-sm">{employeeFirstName.slice(0, 1).toUpperCase()}</div>
              )}
              <div className="hrms-v2-footer-btns">
                <button className="hrms-v2-footer-btn" onClick={() => setDarkMode((v) => !v)} title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}>
                  {darkMode ? <Moon size={15} /> : <Sun size={15} />}
                </button>
                <button className="hrms-v2-footer-btn" onClick={() => goToEmployeeWorkspace({ id: 'logout', action: 'logout' }, 'support')} title="Logout">
                  <LogOut size={15} />
                </button>
              </div>
            </div>
          </div>
        </aside>

        {/* ═══════════ MAIN AREA ═══════════ */}
        <div className="hrms-main-area">

          <CurrentCompanyBanner companyName={String(employee?.company_name || '').trim()} />

          {/* ── Topbar ── */}
          <header className="hrms-topbar-v2 emp-min-topbar">
            <div className="hrms-topbar-left">
              <button type="button" className="hrms-mobile-menu-btn" onClick={() => setEmployeeMobileSidebarOpen(true)} aria-label="Open navigation">
                <Menu size={20} />
              </button>
              <span className="emp-min-topbar-title">{currentRouteMeta.title}</span>
            </div>
            <div className="hrms-topbar-right">
              <div className="hrms-notif-anchor">
                <button type="button" className="hrms-topbar-icon-btn" onClick={() => setEmployeeNotifOpen((old) => !old)} aria-label="Notifications">
                  <Bell size={18} />
                  {unreadNotificationCount > 0 && <span className="hrms-notif-pip">{unreadNotificationCount > 9 ? '9+' : unreadNotificationCount}</span>}
                </button>
                {employeeNotifOpen && (
                  <div className="hrms-notif-panel">
                    <div className="hrms-notif-panel-hdr">
                      <strong>Notifications</strong>
                      <button type="button" className="ghost" onClick={clearEmployeeNotifications}>Clear all</button>
                    </div>
                    <div className="hrms-notif-list">
                      {(employeeNotifications || []).map((item) => (
                        <article key={item.id} className="hrms-notif-item">
                          <button type="button" className="hrms-notif-body" onClick={() => openNotificationWork(item)}>
                            <p className="hrms-notif-title">{item.title || 'Notification'}</p>
                            <p className="hrms-notif-msg">{item.message || '-'}</p>
                            <span className="hrms-notif-time">{formatTimeAgo(item.at)}</span>
                          </button>
                          <button type="button" className="hrms-notif-x" onClick={() => removeEmployeeNotification(item.id)} aria-label="Dismiss">✕</button>
                        </article>
                      ))}
                      {!employeeNotifications.length && <p className="muted small" style={{ margin: '12px 16px' }}>No notifications yet.</p>}
                    </div>
                  </div>
                )}
              </div>
              <div className="hrms-topbar-profile">
                <div className="hrms-topbar-avatar">{employeeFirstName.slice(0, 1).toUpperCase()}</div>
                <div className="hrms-topbar-profile-info">
                  <span className="hrms-topbar-profile-name">{employee?.name || 'Employee'}</span>
                  <span className="hrms-topbar-profile-role">EMPLOYEE</span>
                </div>
              </div>
            </div>
          </header>

          {/* ── Page body ── */}
          <div className="hrms-page-body">
            {isDashboardRoute ? (
              <>
                {/* ── Welcome header ── */}
                <div className="lhr-welcome-row" id="employee-overview-section">
                  <div className="lhr-welcome-left">
                    <div className="lhr-welcome-check">
                      <CalendarCheck2 size={16} />
                    </div>
                    <div>
                      <h1 className="lhr-welcome-title">Welcome back, {employeeFirstName}</h1>
                      <p className="lhr-welcome-sub">
                        {dashboardWeekWorkedHours > 0
                          ? `${dashboardWeekWorkedHours.toFixed(1)} hours logged in the past 7 days (from attendance records synced with HR).`
                          : 'No payable hours logged in the past 7 days yet — clock in after you arrive on site.'}
                      </p>
                    </div>
                  </div>
                  <div className="lhr-welcome-actions">
                    <button type="button" className="lhr-btn-analytics" onClick={openAttendanceHistoryModal}>
                      Attendance history
                    </button>
                    <button
                      type="button"
                      className="lhr-btn-clockin"
                      onClick={() => punchAttendance(canPunchIn ? 'in' : 'out')}
                      disabled={!canPunchIn && !canPunchOut}
                    >
                      {canPunchOut ? 'Clock Out' : 'Clock In Now'}
                    </button>
                  </div>
                </div>

                {/* ── 4 Stat Cards ── */}
                <div className="lhr-stat-row">
                  {/* STATUS */}
                  <div className="lhr-stat-card">
                    <div className="lhr-stat-top">
                      <span className="lhr-stat-label">STATUS</span>
                      <span className={`lhr-stat-badge ${todayCheckedIn ? 'lhr-badge-active' : 'lhr-badge-pending'}`}>
                        {todayCheckedIn ? 'ACTIVE' : 'PENDING'}
                      </span>
                    </div>
                    <div className="lhr-stat-icon-wrap lhr-icon-status">
                      <CalendarCheck2 size={18} />
                    </div>
                    <p className="lhr-stat-value">{todayCheckedIn ? 'Marked' : 'Pending'}</p>
                    <p className="lhr-stat-sub">Last updated: {checkedInAtText !== '--' ? checkedInAtText : 'Not yet'}</p>
                  </div>

                  {/* CHECK IN */}
                  <div className="lhr-stat-card">
                    <div className="lhr-stat-top">
                      <span className="lhr-stat-label">CHECK IN</span>
                    </div>
                    <div className="lhr-stat-icon-wrap lhr-icon-checkin">
                      <Clock size={18} />
                    </div>
                    <p className="lhr-stat-value">{checkedInAtText !== '--' ? checkedInAtText : '—'}</p>
                    <p className={`lhr-stat-sub ${todayCheckedIn ? 'lhr-sub-green' : ''}`}>
                      {todayCheckedIn ? '✦ On Time' : 'Not checked in'}
                    </p>
                  </div>

                  {/* CHECK OUT */}
                  <div className="lhr-stat-card">
                    <div className="lhr-stat-top">
                      <span className="lhr-stat-label">CHECK OUT</span>
                    </div>
                    <div className="lhr-stat-icon-wrap lhr-icon-checkout">
                      <Power size={18} />
                    </div>
                    <p className="lhr-stat-value lhr-stat-dashes">{checkedOutAtText !== '--' ? checkedOutAtText : '——/——'}</p>
                    <p className="lhr-stat-sub">{canPunchOut ? 'Session in progress' : (checkedOutAtText !== '--' ? 'Session ended' : 'Not started')}</p>
                  </div>

                  {/* HOURS LOGGED */}
                  <div className="lhr-stat-card">
                    <div className="lhr-stat-top">
                      <span className="lhr-stat-label">HOURS LOGGED</span>
                    </div>
                    <div className="lhr-stat-icon-wrap lhr-icon-hours">
                      <BarChart3 size={18} />
                    </div>
                    <p className="lhr-stat-value">{hoursWorkedText !== '--' ? hoursWorkedText : '0h 0m'}</p>
                    <div className="lhr-hours-bar">
                      <div
                        className="lhr-hours-fill"
                        style={{ width: `${Math.min(100, (totalWorkedSec / (9 * 3600)) * 100)}%` }}
                      />
                    </div>
                    <p className="lhr-stat-sub muted">Rolling 7d: {dashboardWeekWorkedHours.toFixed(1)}h</p>
                  </div>
                </div>

                {!!dashboardLeaveBalance && (
                  <div className="emp-dash-leave-grid" role="region" aria-label="Leave balances">
                    {[
                      { key: 'earned', label: 'Earned Leave', total: dashboardLeaveBalance.paid_total, used: dashboardLeaveBalance.paid_used, pending: dashboardLeaveBalance.paid_pending },
                      { key: 'casual', label: 'Casual Leave', total: dashboardLeaveBalance.casual_total, used: dashboardLeaveBalance.casual_used, pending: dashboardLeaveBalance.casual_pending },
                      { key: 'sick', label: 'Sick Leave', total: dashboardLeaveBalance.sick_total, used: dashboardLeaveBalance.sick_used, pending: dashboardLeaveBalance.sick_pending },
                    ].map((entry) => (
                      <button
                        key={entry.key}
                        type="button"
                        className="emp-leave-card"
                        onClick={() => navigate('/user/leave')}
                        title="View leave history and apply"
                      >
                        <span className="emp-leave-card-label">{entry.label}</span>
                        <span className="emp-leave-card-value">{Number(entry.total || 0)} <span>d</span></span>
                        <span className="emp-leave-card-meta">
                          {Number(entry.used || 0)} used · {Number(entry.pending || 0)} pending
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                <div className="emp-dash-payslip-card">
                  <div>
                    <p className="emp-dash-payslip-title">Latest payslip</p>
                    <p className="emp-dash-payslip-sub">
                      {dashboardLatestPayslip
                        ? dashboardLatestPayslip.status === 'approved'
                          ? `${monthYearLabel(dashboardLatestPayslip.year, dashboardLatestPayslip.month)} · ${payslipKindLabel(dashboardLatestPayslip)} · ${formatINRWhole(dashboardLatestPayslip.net_salary)}`
                          : `${monthYearLabel(dashboardLatestPayslip.year, dashboardLatestPayslip.month)} · Pending approval by admin`
                        : 'Available once HR publishes and approves your salary slip from the admin panel.'}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="emp-dash-payslip-btn"
                    disabled={!dashboardLatestPayslip || dashboardLatestPayslip.status !== 'approved' || payslipDownloading}
                    onClick={downloadLatestEmployeePayslip}
                    title={dashboardLatestPayslip && dashboardLatestPayslip.status !== 'approved' ? 'Payslip not yet approved by admin' : ''}
                  >
                    {payslipDownloading ? 'Preparing…' : dashboardLatestPayslip?.status === 'approved' ? 'Download Payslip' : 'Awaiting Approval'}
                  </button>
                </div>

                {/* ── Middle: Productivity Snapshot + Action Center / Critical Alerts ── */}
                <div className="lhr-dash-mid">

                  {/* Left: week attendance (same data HR / payroll uses) */}
                  <div className="lhr-productivity-card emp-week-card">
                    <div className="lhr-prod-header">
                      <div>
                        <h3 className="lhr-prod-title">This week&apos;s attendance</h3>
                        <p className="lhr-prod-sub">Last 7 calendar days</p>
                      </div>
                    </div>
                    <div className="lhr-bar-chart">
                      {dashboardWeekBars.map((d) => {
                        const todayKey = formatDateInput()
                        const isTodayCol = d.key === todayKey
                        return (
                          <div key={d.key} className="lhr-bar-col">
                            <div className="lhr-bar-track">
                              <div
                                className={`lhr-bar-fill ${isTodayCol ? 'lhr-bar-today' : 'lhr-bar-default'}`}
                                style={{ height: `${Math.max(d.pct, 2)}%` }}
                              />
                            </div>
                            <span className="lhr-bar-label">{d.label}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Right: Action Center + Critical Alerts */}
                  <div className="lhr-right-col">

                    {/* Action Center */}
                    <div className="lhr-action-card">
                      <h3 className="lhr-action-title">Quick actions</h3>
                      <div className="lhr-action-grid">
                        <button
                          type="button"
                          className="lhr-action-btn"
                          onClick={() => punchAttendance('in')}
                          disabled={!canPunchIn}
                          title={!canPunchIn && punchInDisabledReason ? punchInDisabledReason : 'Record check-in (location may be required)'}
                        >
                          <Fingerprint size={22} />
                          <span>Punch In</span>
                        </button>
                        <button
                          type="button"
                          className="lhr-action-btn lhr-action-danger"
                          onClick={() => punchAttendance('out')}
                          disabled={!canPunchOut}
                          title={!canPunchOut ? 'Check in first' : 'Record check-out'}
                        >
                          <Power size={22} />
                          <span>Punch Out</span>
                        </button>
                        <button
                          type="button"
                          className="lhr-action-btn"
                          onClick={markLeaveForToday}
                          disabled={!canMarkLeave || leaveSubmitting}
                          title={
                            !canMarkLeave && attendanceStatus === 'leave_marked'
                              ? 'Already marked on leave for today'
                              : 'Apply for leave (quick mark for today)'
                          }
                        >
                          <CalendarDays size={22} />
                          <span>Request Leave</span>
                        </button>
                        <button
                          type="button"
                          className="lhr-action-btn"
                          onClick={openAttendanceHistoryModal}
                        >
                          <History size={22} />
                          <span>View Logs</span>
                        </button>
                        <button
                          type="button"
                          className="lhr-action-btn"
                          onClick={() => openManualRequestModal('outside_office')}
                        >
                          <Building2 size={22} />
                          <span>External Work</span>
                        </button>
                        <button
                          type="button"
                          className="lhr-action-btn"
                          onClick={() => openManualRequestModal('wfh')}
                        >
                          <Home size={22} />
                          <span>WFH Setup</span>
                        </button>
                      </div>
                      {!!statusText && statusText !== 'Ready' && (
                        <p className="lhr-action-status-msg">{statusText}</p>
                      )}
                    </div>

                    {/* Reminders */}
                    <div className="lhr-alerts-card">
                      <div className="lhr-alerts-header">
                        <h3 className="lhr-alerts-title">Reminders</h3>
                        <span className="lhr-alerts-dot" />
                      </div>
                      <div className="lhr-alerts-list">
                        {employee?.must_change_password && (
                          <div className="lhr-alert-item lhr-alert-warn">
                            <span className="lhr-alert-icon">⚠</span>
                            <div>
                              <p className="lhr-alert-title">Password Change Required</p>
                              <p className="lhr-alert-desc">Please update your password to avoid account issues.</p>
                            </div>
                          </div>
                        )}
                        {!todayCheckedIn && (
                          <div className="lhr-alert-item lhr-alert-warn">
                            <span className="lhr-alert-icon">⚠</span>
                            <div>
                              <p className="lhr-alert-title">No check-in yet</p>
                              <p className="lhr-alert-desc">Clock in when you start work so payroll and HR records stay accurate.</p>
                            </div>
                          </div>
                        )}
                        {overdueTasks > 0 && (
                          <div className="lhr-alert-item lhr-alert-warn">
                            <span className="lhr-alert-icon">⚠</span>
                            <div>
                              <p className="lhr-alert-title">Overdue Tasks</p>
                              <p className="lhr-alert-desc">{overdueTasks} task{overdueTasks > 1 ? 's are' : ' is'} overdue. Please update progress.</p>
                            </div>
                          </div>
                        )}
                        {!employee?.must_change_password && todayCheckedIn && overdueTasks <= 0 && (
                          <p className="muted small" style={{ margin: '12px 14px' }}>You&apos;re up to date.</p>
                        )}
                      </div>
                      <button
                        type="button"
                        className="lhr-alerts-clear"
                        onClick={clearEmployeeNotifications}
                      >
                        Clear inbox
                      </button>
                    </div>

                  </div>
                </div>

                {/* ── Recent Logs ── */}
                <div className="lhr-recent-logs-card">
                  <div className="lhr-logs-header">
                    <h3 className="lhr-logs-title">Recent Logs</h3>
                    <button type="button" className="lhr-logs-history-btn" onClick={openAttendanceHistoryModal}>
                      Full History <ChevronRight size={14} />
                    </button>
                  </div>
                  <div className="lhr-logs-table-wrap">
                    <table className="lhr-logs-table">
                      <thead>
                        <tr>
                          <th>DATE</th>
                          <th>STATUS</th>
                          <th>CHECK IN</th>
                          <th>HOURS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {dashboardRecentLogs.map((row) => {
                          const dk = String(row.date || '').slice(0, 10)
                          const h = employeeHistoryHours(row)
                          const hoursLabel = formatHistHoursCell(row)
                          const pct = typeof h === 'number' && h > 0 ? Math.min(100, (h / 9) * 100) : 0
                          return (
                            <tr key={`${dk}-${String(row.check_in_at || row.check_in || '')}`}>
                              <td>
                                <div className="lhr-log-date">
                                  <span>{dk}</span>
                                  <span className="lhr-log-weekday">{dk ? new Date(`${dk}T12:00:00`).toLocaleDateString('en-IN', { weekday: 'long' }) : ''}</span>
                                </div>
                              </td>
                              <td>
                                <span className={`lhr-log-status lhr-status-${historyLogStatusSuffix(row)}`}>
                                  {historyStatusDisplay(row)}
                                </span>
                              </td>
                              <td>{employeeHistoryCheckInDisplay(row)}</td>
                              <td>
                                <div className="lhr-log-hours">
                                  <span>{hoursLabel}</span>
                                  {pct > 0 && (
                                    <div className="lhr-log-bar">
                                      <div className="lhr-log-bar-fill" style={{ width: `${pct}%` }} />
                                    </div>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                        {!dashboardRecentLogs.length && (
                          <tr>
                            <td colSpan={4} style={{ padding: '18px 16px' }}>
                              <p className="muted small" style={{ margin: 0 }}>
                                No attendance rows yet for the last 7 days. Use <strong>Clock In</strong> or open <strong>Attendance history</strong>.
                              </p>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Change password prompt (hidden in alerts card above, but keep inline if needed) */}
                {employee?.must_change_password && (
                  <div className="hrms-panel hrms-panel-warn" style={{ marginTop: 16 }}>
                    <h3 className="hrms-panel-title">Password Change Required</h3>
                    <p className="muted small" style={{ marginTop: 4 }}>Minimum 6 characters with at least 1 number.</p>
                    <div className="hrms-pw-form">
                      <input type="password" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                      <input type="password" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                      <button onClick={changePassword}>Update Password</button>
                    </div>
                  </div>
                )}
            </>
          ) : currentEmployeeRoute === 'attendance' ? (
            <AttendanceHistoryCorrectionPanel
              token={token}
              attendanceState={attendanceState}
              attendanceTimes={attendanceTimes}
              canPunchIn={canPunchIn}
              canPunchOut={canPunchOut}
              onPunchIn={() => punchAttendance('in')}
              onPunchOut={() => punchAttendance('out')}
            />
          ) : currentEmployeeRoute === 'leave' ? (
            <LeaveManagementPanel />
          ) : currentEmployeeRoute === 'performance' ? (
            <section className="employee-module-shell">
              <div className="employee-module-grid">
                <article className="card employee-module-card">
                  <p className="muted small">Performance Score</p>
                  <h3>{performanceSummary.score}</h3>
                  <p className="muted small">Quarterly rating snapshot</p>
                </article>
                <article className="card employee-module-card">
                  <p className="muted small">KPI Completion %</p>
                  <h3>{performanceSummary.kpiCompletion}%</h3>
                  <p className="muted small">Based on active KPIs</p>
                </article>
                <article className="card employee-module-card">
                  <p className="muted small">Tasks Completed</p>
                  <h3>{performanceSummary.tasksCompleted}</h3>
                  <p className="muted small">Last 30 days</p>
                </article>
              </div>

              <article className="card employee-module-card">
                <div className="row between" style={{ marginBottom: 12 }}>
                  <h4 style={{ margin: 0 }}>Monthly Performance</h4>
                  <span className="muted small">Last 3 months</span>
                </div>
                <div className="employee-performance-table-wrap">
                  <table className="employee-performance-table">
                    <thead>
                      <tr>
                        <th>Month</th>
                        <th>Rating</th>
                        <th>Goals Completed</th>
                        <th>Manager Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {performanceRows.map((row) => (
                        <tr key={row.month}>
                          <td>{row.month}</td>
                          <td>{row.rating}</td>
                          <td>{row.goals}</td>
                          <td>{row.note}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>

              <article className="card employee-module-card">
                <div className="row between" style={{ marginBottom: 12 }}>
                  <h4 style={{ margin: 0 }}>Goals</h4>
                  <span className="muted small">Current cycle</span>
                </div>
                <div className="employee-goals-grid">
                  {performanceGoals.map((goal) => (
                    <div className="employee-goal-item" key={goal.name}>
                      <div className="row between">
                        <strong>{goal.name}</strong>
                        <span className="employee-goal-status">{goal.status}</span>
                      </div>
                      <div className="employee-goal-bar">
                        <span style={{ width: `${Math.min(100, Math.max(0, goal.progress))}%` }} />
                      </div>
                      <p className="muted small">{goal.progress}% complete</p>
                    </div>
                  ))}
                </div>
              </article>
            </section>
          ) : currentEmployeeRoute === 'teamDirectory' ? (
            <section className="employee-module-shell">
              <article className="card employee-module-card employee-directory-controls">
                <div className="employee-directory-search">
                  <label className="muted small">Search</label>
                  <input
                    className="table-search"
                    placeholder="Search by name, role, email, or phone"
                    value={teamDirectorySearch}
                    onChange={(e) => setTeamDirectorySearch(e.target.value)}
                  />
                </div>
                <div className="employee-directory-filter">
                  <label className="muted small">Department</label>
                  <select value={teamDirectoryDeptFilter} onChange={(e) => setTeamDirectoryDeptFilter(e.target.value)}>
                    {teamDepartments.map((dept) => (
                      <option key={dept} value={dept}>{dept === 'all' ? 'All Departments' : dept}</option>
                    ))}
                  </select>
                </div>
              </article>

              <div className="employee-directory-grid">
                {filteredTeamDirectory.map((row) => (
                  <article key={row.id || row.email || row.login_id || row.name} className="card employee-directory-card">
                    <div className="employee-directory-avatar">{row.name.slice(0, 1).toUpperCase()}</div>
                    <div>
                      <h4>{row.name}</h4>
                      <p className="muted small">{row.role} · {row.department}</p>
                      <p className="employee-directory-contact">{row.email}</p>
                      <p className="employee-directory-contact">{row.phone}</p>
                    </div>
                  </article>
                ))}
                {!filteredTeamDirectory.length && (
                  <article className="card employee-directory-empty">
                    <p className="muted">No employees found. Try another filter.</p>
                  </article>
                )}
              </div>
            </section>
          ) : currentEmployeeRoute === 'holidays' ? (
            <section className="employee-module-shell">
              <article className="card employee-module-card employee-holiday-header">
                <div>
                  <h4 style={{ margin: 0 }}>Holidays</h4>
                  <p className="muted small">Company holiday calendar and upcoming dates.</p>
                </div>
                <div className="employee-toggle-group">
                  <button
                    type="button"
                    className={`ghost ${holidayView === 'list' ? 'active' : ''}`}
                    onClick={() => setHolidayView('list')}
                  >
                    List View
                  </button>
                  <button
                    type="button"
                    className={`ghost ${holidayView === 'calendar' ? 'active' : ''}`}
                    onClick={() => setHolidayView('calendar')}
                  >
                    Calendar View
                  </button>
                </div>
              </article>

              {holidayView === 'calendar' ? (
                <div className="employee-holiday-calendar">
                  {(holidayRows || []).map((row) => (
                    <div key={`${row.date}-${row.name}`} className="card employee-holiday-card">
                      <strong>{row.name}</strong>
                      <p className="muted small">{row.date}</p>
                      <span className="employee-holiday-type">{row.type}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="employee-holiday-list">
                  {upcomingHolidays.map((row) => (
                    <article key={row.name} className="card employee-holiday-item">
                      <div>
                        <strong>{row.name}</strong>
                        <p className="muted small">{row.date}</p>
                      </div>
                      <span className="employee-holiday-type">{row.type}</span>
                    </article>
                  ))}
                  {!upcomingHolidays.length && (
                    <article className="card employee-holiday-item">
                      <p className="muted">No upcoming holidays found.</p>
                    </article>
                  )}
                </div>
              )}
            </section>
          ) : currentEmployeeRoute === 'assets' ? (
            <EmployeeAssetsModule employee={employee} activeItem={employeeSidebarActive} />
          ) : (
            <section className="employee-placeholder-shell">
              <article className="card employee-placeholder-hero">
                <h3>{currentRouteMeta.title}</h3>
                <p className="muted">{currentRouteMeta.hint}</p>
                <div className="employee-placeholder-kpis">
                  <span className="status-badge">Workspace: Ready</span>
                  <span className="status-badge">Theme: {darkMode ? 'Dark' : 'Light'}</span>
                  <span className="status-badge">Notifications: {notificationBadgeCount}</span>
                </div>
              </article>

              <div className="employee-placeholder-grid">
                <article className="card employee-placeholder-card">
                  <h4>Module Structure</h4>
                  <ul>
                    <li>Professional sidebar navigation is configured.</li>
                    <li>Top-level route is active and connected.</li>
                    <li>Submodules are ready for feature development.</li>
                  </ul>
                </article>
                <article className="card employee-placeholder-card">
                  <h4>Next Integration</h4>
                  <ul>
                    <li>Connect APIs for this module.</li>
                    <li>Add data tables and filters.</li>
                    <li>Enable request forms and workflows.</li>
                  </ul>
                </article>
              </div>
            </section>
          )}
          </div>
        </div>
      </div>

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

      {attendanceHistoryModalOpen && (
        <div className="modal-overlay" onClick={closeAttendanceHistoryModal}>
          <div className="modal-card employee-attendance-history-modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between align-start employee-attendance-history-modal-head">
              <div>
                <h3 style={{ marginBottom: 4 }}>Attendance history</h3>
                <p className="muted small" style={{ margin: 0 }}>Your records for the selected period are shown below as a PDF.</p>
              </div>
              <div className="row modal-actions employee-attendance-history-modal-actions">
                <button type="button" className="ghost" onClick={closeAttendanceHistoryModal}>Close</button>
                <button type="button" onClick={downloadAttendanceHistoryPdf} disabled={!attendanceHistoryPdfUrl}>
                  Download PDF
                </button>
              </div>
            </div>

            <div className="employee-attendance-history-toolbar">
              <label className="muted small employee-attendance-history-date-field">
                <span>From</span>
                <input
                  type="date"
                  value={attendanceHistoryFromDate}
                  onChange={(e) => setAttendanceHistoryFromDate(e.target.value)}
                />
              </label>
              <label className="muted small employee-attendance-history-date-field">
                <span>To</span>
                <input
                  type="date"
                  value={attendanceHistoryToDate}
                  onChange={(e) => setAttendanceHistoryToDate(e.target.value)}
                />
              </label>
              <button type="button" onClick={applyAttendanceHistoryDateRange} disabled={attendanceHistoryLoading}>
                Apply range
              </button>
              <div className="employee-attendance-history-quick">
                <span className="muted small">Quick</span>
                <button type="button" className="ghost" disabled={attendanceHistoryLoading} onClick={() => applyAttendanceHistoryDayRange('7')}>7d</button>
                <button type="button" className="ghost" disabled={attendanceHistoryLoading} onClick={() => applyAttendanceHistoryDayRange('30')}>30d</button>
                <button type="button" className="ghost" disabled={attendanceHistoryLoading} onClick={() => applyAttendanceHistoryDayRange('90')}>90d</button>
              </div>
            </div>

            <div className="employee-attendance-history-pdf-frame">
              {attendanceHistoryLoading && (
                <div className="employee-attendance-history-pdf-placeholder">
                  <p className="muted small" style={{ margin: 0 }}>Loading attendance from the server…</p>
                </div>
              )}
              {!attendanceHistoryLoading && attendanceHistoryPdfUrl ? (
                <iframe title="Attendance history PDF preview" src={`${attendanceHistoryPdfUrl}#view=FitH`} />
              ) : null}
              {!attendanceHistoryLoading && !attendanceHistoryPdfUrl ? (
                <div className="employee-attendance-history-pdf-placeholder">
                  <p className="muted small" style={{ margin: 0 }}>Generating PDF preview… try Download PDF after the report loads.</p>
                </div>
              ) : null}
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

      <div
        ref={payslipExportHostRef}
        style={{
          position: 'fixed',
          left: -12000,
          top: 0,
          width: 720,
          zIndex: -3,
          pointerEvents: 'none',
        }}
        aria-hidden
      >
        {payslipExportJob?.props ? <PayslipDoc {...payslipExportJob.props} /> : null}
      </div>
    </main>
  )
}
