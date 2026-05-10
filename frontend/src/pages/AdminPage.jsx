import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Bell,
  BarChart3,
  Building2,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Eye,
  FileSpreadsheet,
  Filter,
  Loader2,
  Menu,
  MoreVertical,
  Pencil,
  RotateCcw,
  Search,
  Timer,
  Users,
  UserCheck,
  UserPlus,
  UserX,
  ClipboardCheck,
  ClipboardList,
  Settings,
  Clock3,
  CheckCircle2,
  AlertCircle,
  Activity,
  LogOut,
  Sun,
  Moon,
  Sparkles,
  ShieldCheck,
  Upload,
  ImageIcon,
  Video,
  FileText,
  Trash2,
  X,
  IndianRupee,
  Sheet,
  Printer,
  RefreshCw,
  Info,
  AlertTriangle,
  BellRing,
} from 'lucide-react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { apiFetch } from '../api'
import { BASE_URL } from '../config/apiConfig'
import { firstNameOf, isAfterDailyCutoff } from '../utils/dashboardV2'
import AttendancePolicyEngine from '../components/policies/AttendancePolicyEngine'
import EmployeePayrollCalculator from '../components/payroll/EmployeePayrollCalculator'
import BulkPayrollRun from '../components/payroll/BulkPayrollRun'
import AddEmployeeOnboarding from '../components/admin/AddEmployeeOnboarding'
import '../components/payroll/BulkPayrollRun.css'
import { useCompany } from '../context/CompanyContext'
import AccountPage from './Account'
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
  DASHBOARD_V2_ENABLED,
  DASHBOARD_AUTO_REFRESH_SECONDS,
  AUTO_ABSENT_CUTOFF_HOUR,
  ATTENDANCE_POLICY_STORAGE_KEY,
  ASSET_MAX_FILE_SIZE_BYTES,
  ASSET_ALLOWED_EXTENSIONS,
  ASSET_INPUT_ACCEPT,
} from '../config/constants'
import {
  normalizeAttendancePolicyConfig,
  fileExtensionOf,
  splitFileName,
  nextUniqueAssetName,
  validateAssetFile,
  uploadEmployeeAssetWithProgress,
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
  assetTypeLabel,
  assetTypeClass,
  formatAssetUploadDate,
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
import { normalizeCompanyCatalog } from '../utils/companyCatalog'
import LoginCard from '../components/common/LoginCard'
import AnimatedCounter from '../components/common/AnimatedCounter'
import EmptyState from '../components/common/EmptyState'
import HrmsMetricCard from '../components/common/HrmsMetricCard'
import CurrentCompanyBanner from '../components/common/CurrentCompanyBanner'
import SidebarToggle from '../components/common/SidebarToggle'
import SidebarItem from '../components/common/SidebarItem'
import SidebarSection from '../components/common/SidebarSection'

/** Unpaid buckets (LOP/LWP) must not inflate paid-leave totals; see backend DEFAULT_LEAVE_TYPES `paid: false`. */
const UNPAID_LEAVE_BALANCE_CODES = new Set(['LOP', 'LWP', 'UNPAID', 'UNPAID_LEAVE', 'LWOP', 'UPL'])
const DASH_LEAVE_PIE_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#94a3b8', '#8b5cf6']

function leaveBalanceCountsTowardPaidTotal(code, entry) {
  if (entry && typeof entry.paid === 'boolean' && !entry.paid) return false
  const c = String(code || '').trim().toUpperCase()
  if (!c) return true
  return !UNPAID_LEAVE_BALANCE_CODES.has(c)
}

export default function AdminPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const routeParams = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    companies: globalCompanies,
    setCompanies: setGlobalCompanyList,
    selectedCompanyId,
    selectedCompany,
    selectCompany,
    fetchCompanies,
  } = useCompany()
  const [companySwitcherOpen, setCompanySwitcherOpen] = useState(false)
  const companySwitcherRef = useRef(null)
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
  const [clockTick, setClockTick] = useState(Date.now())
  const [loading, setLoading] = useState(false)
  const [date, setDate] = useState(formatDateInput())
  const [logsFromDate, setLogsFromDate] = useState(dateKeyOffsetFromToday(-6))
  const [logsToDate, setLogsToDate] = useState(formatDateInput())
  const [employees, setEmployees] = useState([])
  const [attendance, setAttendance] = useState([])
  const [manualRequests, setManualRequests] = useState([])
  const [leaveAnalytics, setLeaveAnalytics] = useState(null)
  const [manualStatusFilter, setManualStatusFilter] = useState('pending')
  const [requestsViewMode, setRequestsViewMode] = useState('table')
  const [directorySearch, setDirectorySearch] = useState('')
  const [assetsHubSearch, setAssetsHubSearch] = useState('')
  const [assetsHubDeptFilter, setAssetsHubDeptFilter] = useState('all')
  const [directoryDeptFilter, setDirectoryDeptFilter] = useState('all')
  const [directoryRoleFilter, setDirectoryRoleFilter] = useState('all')
  const [directoryStatusFilter, setDirectoryStatusFilter] = useState('all')
  const [directoryMissingOnly, setDirectoryMissingOnly] = useState(false)
  const [directorySort, setDirectorySort] = useState({ key: 'name', direction: 'asc' })
  const [directoryPage, setDirectoryPage] = useState(1)
  const [selectedEmployeeIds, setSelectedEmployeeIds] = useState([])
  const [directoryActionMenuId, setDirectoryActionMenuId] = useState('')
  const [logsSearch, setLogsSearch] = useState('')
  const [logsRangeFilter, setLogsRangeFilter] = useState('today')
  const [logsDeptFilter, setLogsDeptFilter] = useState('all')
  const [logsStatusFilter, setLogsStatusFilter] = useState('all')
  const [logsShiftFilter, setLogsShiftFilter] = useState('all')
  const [logsViewMode, setLogsViewMode] = useState('daily')
  const [logsSort, setLogsSort] = useState({ key: 'employee_name', direction: 'asc' })
  const [logsPage, setLogsPage] = useState(1)
  const [logsAdvancedFiltersOpen, setLogsAdvancedFiltersOpen] = useState(false)
  const [logsExpandedRows, setLogsExpandedRows] = useState([])
  const [logsExporting, setLogsExporting] = useState('')
  const [exceptionTypeFilter, setExceptionTypeFilter] = useState('both')
  const [exceptionNotesByKey, setExceptionNotesByKey] = useState({})
  const [exceptionHalfDayKeys, setExceptionHalfDayKeys] = useState([])
  const [exceptionResolvedKeys, setExceptionResolvedKeys] = useState([])
  const [exceptionNoteModal, setExceptionNoteModal] = useState({ open: false, key: '', row: null, note: '' })
  const [exceptionActionMenuId, setExceptionActionMenuId] = useState('')
  const [selectedExceptionKeys, setSelectedExceptionKeys] = useState([])
  const [warningSendingByKey, setWarningSendingByKey] = useState({})
  const [bulkWarningSending, setBulkWarningSending] = useState(false)
  const [warningCountsByEmployee, setWarningCountsByEmployee] = useState({})
  const [warningHistoryModal, setWarningHistoryModal] = useState({
    open: false,
    employeeId: '',
    employeeName: '',
    loading: false,
    error: '',
    rows: [],
  })
  const [exceptionsExporting, setExceptionsExporting] = useState('')
  const [exceptionsPolicyOpen, setExceptionsPolicyOpen] = useState(false)
  const [selectedAttendanceIds, setSelectedAttendanceIds] = useState([])
  const [attendanceDetailModal, setAttendanceDetailModal] = useState({ open: false, row: null, requestId: '' })
  const [liveTrackingOn] = useState(true)
  const [requestsSearch, setRequestsSearch] = useState('')
  const [requestsTypeFilter, setRequestsTypeFilter] = useState('all')
  const [requestsDeptFilter, setRequestsDeptFilter] = useState('all')
  const [requestsPriorityFilter, setRequestsPriorityFilter] = useState('all')
  const [requestsPage, setRequestsPage] = useState(1)
  const [selectedRequestIds, setSelectedRequestIds] = useState([])
  const [view, setView] = useState('overview')
  const initialRouteHandledRef = useRef(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [expandedSidebarSection, setExpandedSidebarSection] = useState('attendance')
  const [activeSidebarItem, setActiveSidebarItem] = useState('attendance-dashboard')
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false)
  const [overviewRange, setOverviewRange] = useState('today')
  const [overviewCustomFrom, setOverviewCustomFrom] = useState(dateKeyOffsetFromToday(-6))
  const [overviewCustomTo, setOverviewCustomTo] = useState(formatDateInput())
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true)
  const [reportsRange, setReportsRange] = useState('week')
  const [reportsFromDate, setReportsFromDate] = useState(dateKeyOffsetFromToday(-6))
  const [reportsToDate, setReportsToDate] = useState(formatDateInput())
  const [reportsDepartmentFilter, setReportsDepartmentFilter] = useState('all')
  const [reportsEmployeeFilter, setReportsEmployeeFilter] = useState('all')
  const [reportsStatusFilter, setReportsStatusFilter] = useState('all')
  const [reportsSearchInput, setReportsSearchInput] = useState('')
  const [reportsSearch, setReportsSearch] = useState('')
  const [reportsPage, setReportsPage] = useState(1)
  const [reportsSort, setReportsSort] = useState({ key: 'date', direction: 'desc' })
  const [analyticsData, setAnalyticsData] = useState(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [analyticsError, setAnalyticsError] = useState('')
  const [profileMenuOpen, setProfileMenuOpen] = useState(false)
  const EMPTY_NEW_EMP = {
    // Basic
    name: '', email: '', login_id: '', password: '',
    // Job
    emp_id: '', designation: '', department: 'General', company_name: selectedCompany?.name || '',
    employment_type: 'Full-time', date_of_joining: '', reporting_manager: '', role: 'staff', status: 'active',
    // Personal
    mobile: '', father_name: '', dob: '', gender: '', blood_group: '', marital_status: '',
    emergency_contact_name: '', emergency_contact_phone: '', permanent_address: '',
    // Documents
    aadhaar_number: '', pan_number: '', photo_url: '',
    // Bank
    bank_account_no: '', bank_ifsc: '', bank_name: '',
    // Compensation
    salary_type: 'CTC_BASED', monthly_salary: '', net_target_monthly: '',
    portal_access: true,
    send_invite_email: false,
    // Work policy
    work_policy: { saturdayPolicy: 'OFF', shiftStart: '09:00', shiftEnd: '18:00', graceMinutes: 15, overtimeEligible: true, paidLeavesPerMonth: 2 },
  }
  const [newEmp, setNewEmp] = useState(EMPTY_NEW_EMP)
  const [companies, setCompanies] = useState([])
  const [addCompanyMode, setAddCompanyMode] = useState(false)
  const [newCompanyName, setNewCompanyName] = useState('')
  const [addCompanyError, setAddCompanyError] = useState('')
  const [addCompanyBusy, setAddCompanyBusy] = useState(false)
  const [showInlineDeptManager, setShowInlineDeptManager] = useState(false)
  const [showInlineRoleManager, setShowInlineRoleManager] = useState(false)
  const [employeeFormEmail, setEmployeeFormEmail] = useState('')
  const [employeeFormRole, setEmployeeFormRole] = useState('staff')
  const [employeeFormStatus, setEmployeeFormStatus] = useState('active')
  const [employeesLoading, setEmployeesLoading] = useState(false)
  const [employeesError, setEmployeesError] = useState('')
  const [employeeProfileId, setEmployeeProfileId] = useState('')
  const [employeeProfileData, setEmployeeProfileData] = useState(null)
  const [employeeProfileLoading, setEmployeeProfileLoading] = useState(false)
  const [employeeProfileError, setEmployeeProfileError] = useState('')
  const [employeeProfileTab, setEmployeeProfileTab] = useState('overview')
  const [employeePayrollEmployeeId, setEmployeePayrollEmployeeId] = useState('')
  const [employeePayrollCompany,    setEmployeePayrollCompany]    = useState(() => selectedCompanyId || 'PR')
  const [employeeProfileAttendanceHistory, setEmployeeProfileAttendanceHistory] = useState([])
  const [employeeProfileSalaryData, setEmployeeProfileSalaryData] = useState(null)
  const [employeeProfileLeaveBalance, setEmployeeProfileLeaveBalance] = useState(null)
  const [employeeProfileLeaveRequests, setEmployeeProfileLeaveRequests] = useState([])
  const [employeeProfilePayslips, setEmployeeProfilePayslips] = useState([])
  const [employeeProfileSupplementLoading, setEmployeeProfileSupplementLoading] = useState(false)
  const [employeeProfileInsights, setEmployeeProfileInsights] = useState({
    loading: false,
    presentDays: 0,
    absentDays: 0,
    lateCount: 0,
    totalWorkHours: 0,
    lastAttendance: null,
    lastRequest: null,
  })
  const [employeeAssets, setEmployeeAssets] = useState([])
  const [employeeAssetsLoading, setEmployeeAssetsLoading] = useState(false)
  const [employeeAssetsError, setEmployeeAssetsError] = useState('')
  const [employeeAssetsSearch, setEmployeeAssetsSearch] = useState('')
  const [employeeAssetsFilter, setEmployeeAssetsFilter] = useState('all')
  const [employeeAssetsSort, setEmployeeAssetsSort] = useState('newest')
  const [employeeAssetsPage, setEmployeeAssetsPage] = useState(1)
  const [employeeAssetsTotal, setEmployeeAssetsTotal] = useState(0)
  const [employeeAssetsDownloadingAll, setEmployeeAssetsDownloadingAll] = useState(false)
  const [employeeAssetsUploadModal, setEmployeeAssetsUploadModal] = useState({
    open: false,
    dragActive: false,
    files: [],
    rejected: [],
    uploading: false,
    progressPercent: 0,
    uploadedCount: 0,
    totalCount: 0,
    currentFileName: '',
  })
  const [employeeAssetPreviewModal, setEmployeeAssetPreviewModal] = useState({
    open: false,
    asset: null,
  })
  const [employeeAssetRenameModal, setEmployeeAssetRenameModal] = useState({
    open: false,
    asset: null,
    fileName: '',
    saving: false,
  })
  const [departments, setDepartments] = useState([])
  const [roles, setRoles] = useState([])
  const [newDepartmentName, setNewDepartmentName] = useState('')
  const [newRoleName, setNewRoleName] = useState('')
  const [catalogBusy, setCatalogBusy] = useState(false)
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
  const [attendancePolicy, setAttendancePolicy] = useState(() => {
    try {
      const raw = localStorage.getItem(ATTENDANCE_POLICY_STORAGE_KEY)
      if (!raw) return normalizeAttendancePolicyConfig()
      return normalizeAttendancePolicyConfig(JSON.parse(raw))
    } catch {
      return normalizeAttendancePolicyConfig()
    }
  })
  const [attendancePolicyInitial, setAttendancePolicyInitial] = useState(() => {
    try {
      const raw = localStorage.getItem(ATTENDANCE_POLICY_STORAGE_KEY)
      if (!raw) return normalizeAttendancePolicyConfig()
      return normalizeAttendancePolicyConfig(JSON.parse(raw))
    } catch {
      return normalizeAttendancePolicyConfig()
    }
  })
  const [attendancePolicySaving, setAttendancePolicySaving] = useState(false)
  const [cameraStatus, setCameraStatus] = useState(null)
  const [settingsFeedback, setSettingsFeedback] = useState({ type: '', text: '' })
  const [settingsLastUpdated, setSettingsLastUpdated] = useState(null)
  const [geofenceSaving, setGeofenceSaving] = useState(false)
  const [geofenceTesting, setGeofenceTesting] = useState(false)
  const [geofenceFetching, setGeofenceFetching] = useState(false)
  const [geofenceTestResult, setGeofenceTestResult] = useState({ type: '', text: '' })
  
  // Unified Settings States
  const [activeSettingsSection, setActiveSettingsSection] = useState('company')
  const [settingsFormData, setSettingsFormData] = useState({
    companyName: 'Acme Corp', companyAddress: '', hrEmail: 'hr@acme.com', website: '',
    currency: 'INR', timezone: 'Asia/Kolkata', gst: '', pan: '',
    officeTimings: '09:00 - 18:00', gracePeriod: '15', halfDayThreshold: '4', overtimeRules: 'After 9 hours',
    elCount: 16, clCount: 10, slCount: 6, sandwichPolicy: true, carryForward: true,
    pfDeduction: true, tdsEnabled: true, payrollCycle: '1st to 30th',
    notifyPayroll: true, notifyLeave: true, notifyAttendance: true,
    darkMode: false, compactMode: true
  })
  const [settingsFormDataInitial, setSettingsFormDataInitial] = useState(null)
  const [isSettingsSaving, setIsSettingsSaving] = useState(false)
  
  useEffect(() => {
    if (!settingsFormDataInitial) setSettingsFormDataInitial(settingsFormData)
  }, [settingsFormData])
  
  const hasSettingsChanges = useMemo(() => {
    if (!settingsFormDataInitial) return false
    return JSON.stringify(settingsFormData) !== JSON.stringify(settingsFormDataInitial)
  }, [settingsFormData, settingsFormDataInitial])
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
    requestIds: [],
    reason: 'Rejected by admin',
    saving: false,
  })
  const [approveReasonModal, setApproveReasonModal] = useState({
    open: false,
    requestIds: [],
    reason: 'Approved by admin',
    saving: false,
  })
  const EMPTY_EDIT_EMP = {
    open: false, row: null, saving: false,
    name: '', email: '', loginId: '', department: 'General', role: 'staff', status: 'active',
    monthly_salary: '', salary_type: 'CTC_BASED', net_target_monthly: '',
    work_policy: { saturdayPolicy: 'OFF', shiftStart: '09:00', shiftEnd: '18:00', graceMinutes: 15, overtimeEligible: true, paidLeavesPerMonth: 2 },
    // Extended
    emp_id: '', designation: '', company_name: '', employment_type: 'Full-time',
    date_of_joining: '', reporting_manager: '', mobile: '', father_name: '',
    dob: '', gender: '', blood_group: '', marital_status: '',
    emergency_contact_name: '', emergency_contact_phone: '', permanent_address: '',
    aadhaar_number: '', pan_number: '', bank_account_no: '', bank_ifsc: '', bank_name: '', photo_url: '',
  }
  const [editEmployeeModal, setEditEmployeeModal] = useState(EMPTY_EDIT_EMP)
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
  const [createEmployeeSubmitting, setCreateEmployeeSubmitting] = useState(false)
  const [addEmployeeFieldErrors, setAddEmployeeFieldErrors] = useState({ name: '', email: '', login_id: '', password: '' })
  const [addEmployeeShowPassword, setAddEmployeeShowPassword] = useState(false)
  const [adminBellToast, setAdminBellToast] = useState({ show: false, title: '', message: '', type: 'info' })
  const [adminNotifications, setAdminNotifications] = useState([])
  const [adminNotificationOpen, setAdminNotificationOpen] = useState(false)
  const [adminNotificationDrawerOpen, setAdminNotificationDrawerOpen] = useState(false)
  const [adminNotificationsLoading, setAdminNotificationsLoading] = useState(false)
  const [adminNotificationsBusy, setAdminNotificationsBusy] = useState(false)
  const [adminAlertsTotal, setAdminAlertsTotal] = useState(0)
  const [adminNotificationReadMap, setAdminNotificationReadMap] = useState({})
  const [adminNotificationsClearedAt, setAdminNotificationsClearedAt] = useState(null)
  const [activityTypeFilter, setActivityTypeFilter] = useState('all')
  const [globalSearchInput, setGlobalSearchInput] = useState('')
  const [globalSearchQuery, setGlobalSearchQuery] = useState('')
  const [globalSearchOpen, setGlobalSearchOpen] = useState(false)
  const [shortcutsModalOpen, setShortcutsModalOpen] = useState(false)
  const enrollmentVideoRef = useRef(null)
  const enrollmentCanvasRef = useRef(null)
  const enrollmentStreamRef = useRef(null)
  const adminRefreshInFlightRef = useRef(false)
  const analyticsCacheRef = useRef(new Map())
  const reportsUrlInitializedRef = useRef(false)
  const adminBellToastTimerRef = useRef(null)
  const adminTaskNotifyRef = useRef({ initialized: false, tasks: {} })
  const adminNotificationWrapRef = useRef(null)
  const successToastMsgRef = useRef('')
  const errorToastMsgRef = useRef('')

  const viewMeta = {
    overview: { label: 'Dashboard', subtitle: 'Workforce pulse and quick controls' },
    logs: { label: 'Attendance', subtitle: 'All records, exceptions and analytics' },
    reports: { label: 'Reports & Analytics', subtitle: 'Insights, trends and workforce performance analytics' },
    employeePayroll: { label: 'Employee Payroll', subtitle: 'Separate employee payroll management and salary previews' },
    bulkPayroll: { label: 'Run Payroll', subtitle: 'Process monthly payroll for all employees in bulk' },
    assets: { label: 'Assets', subtitle: 'Employee files, documents and media access' },
    directory: { label: 'All Employees', subtitle: 'Team directory and account management' },
    employeeProfile: { label: 'Employee Profile', subtitle: 'Individual employee details and status' },
    add: { label: 'Onboarding', subtitle: 'Create employee profiles and credentials' },
    requests: { label: 'Requests', subtitle: 'Leave, manual attendance and approvals' },
    tasks: { label: 'Tasks', subtitle: 'Assign, track and manage employee tasks' },
    settings: { label: 'Settings', subtitle: 'Geofence, camera and system controls' },
    accountProfile: { label: 'Profile', subtitle: 'Personal details and sign-in identity' },
    accountChangePassword: { label: 'Change password', subtitle: 'Use a strong, unique password' },
    accountSecurity: { label: 'Security', subtitle: 'Active sessions and device access' },
  }

  const sidebarSections = [
    {
      id: 'employees',
      label: 'Employees',
      icon: Users,
      items: [
        { id: 'employees-all', label: 'All Employees', view: 'directory' },
        { id: 'employees-add', label: 'Add Employee', view: 'add' },
      ],
    },
    {
      id: 'payroll',
      label: 'Payroll',
      icon: FileSpreadsheet,
      items: [
        { id: 'employee-payroll', label: 'Employee Payroll', view: 'employeePayroll', path: '/admin/employee-payroll' },
      ],
    },
    {
      id: 'attendance',
      label: 'Attendance',
      icon: ClipboardCheck,
      items: [
        { id: 'attendance-dashboard', label: 'Attendance Dashboard', view: 'overview' },
        { id: 'attendance-all-records', label: 'All Records', view: 'logs' },
        { id: 'attendance-requests', label: 'Leave Management', view: 'requests' },
        { id: 'attendance-exceptions', label: 'Exceptions (Late / Early Out)', view: 'logs' },
      ],
    },
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      items: [
        { id: 'settings-general', label: 'General Settings', view: 'settings' },
      ],
    },
    {
      id: 'account',
      label: 'Account',
      icon: ShieldCheck,
      items: [
        { id: 'account-profile', label: 'Profile', view: 'accountProfile', path: '/account/profile' },
        { id: 'account-change-password', label: 'Change Password', view: 'accountChangePassword', path: '/account/change-password' },
        { id: 'account-security', label: 'Security', view: 'accountSecurity', path: '/account/security' },
      ],
    },
  ]

  function applyOverviewRange(range) {
    const next = String(range || 'today')
    setOverviewRange(next)
    const today = formatDateInput()
    if (next === 'today') {
      setDate(today)
      setLogsFromDate(today)
      setLogsToDate(today)
      return
    }
    if (next === 'week') {
      setDate(today)
      setLogsFromDate(dateKeyOffsetFromToday(-6))
      setLogsToDate(today)
      return
    }
    if (next === 'custom') {
      const from = String(overviewCustomFrom || today)
      const to = String(overviewCustomTo || today)
      setDate(to)
      setLogsFromDate(from)
      setLogsToDate(to)
      return
    }
    setDate(today)
    setLogsFromDate(dateKeyOffsetFromToday(-29))
    setLogsToDate(today)
  }

  function openKpiView(target = 'attendance', status = 'all') {
    if (target === 'requests') {
      goToView('requests', 'attendance', 'attendance-requests')
      return
    }
    goToView('logs', 'attendance', 'attendance-all-records')
    const statusKey = String(status || 'all').toLowerCase()
    if (statusKey === 'present') {
      setLogsStatusFilter('present')
    } else if (statusKey === 'absent') {
      setLogsStatusFilter('absent')
    } else if (statusKey === 'leave') {
      setLogsStatusFilter('leave')
    } else {
      setLogsStatusFilter('all')
    }
    setDate(formatDateInput())
    setLogsRangeFilter('today')
    setLogsFromDate(formatDateInput())
    setLogsToDate(formatDateInput())
  }

  function openOverviewInsight(insightId) {
    const id = String(insightId || '').trim().toLowerCase()
    if (!id) return

    if (id === 'predictive-absenteeism') {
      goToView('logs', 'attendance', 'attendance-all-records')
      setLogsStatusFilter('absent')
    } else if (id === 'late-arrivals') {
      goToView('logs', 'attendance', 'attendance-all-records')
      setLogsStatusFilter('late')
    } else if (id === 'missing-checkins' || id === 'attendance-drop' || id === 'anomaly-checkin-drop') {
      setDirectoryMissingOnly(true)
      setDirectorySearch('')
      setDirectoryDeptFilter('all')
      setDirectoryRoleFilter('all')
      setDirectoryStatusFilter('active')
      navigate('/employees')
      goToView('directory', 'employees', 'employees-all')
      return
    } else {
      goToView('logs', 'attendance', 'attendance-all-records')
      setLogsStatusFilter('all')
    }

    setLogsSearch('')
    setLogsDeptFilter('all')
    setLogsShiftFilter('all')
    setLogsSort({ key: 'employee_name', direction: 'asc' })

    // Match the current dashboard date window (Today/Week/Month/Custom).
    setDate(String(dashboardRangeBounds?.to || formatDateInput()))
    setLogsFromDate(String(dashboardRangeBounds?.from || formatDateInput()))
    setLogsToDate(String(dashboardRangeBounds?.to || formatDateInput()))
    setLogsRangeFilter(String(overviewRange || 'today'))
  }

  function notifyMissingCheckins() {
    const targets = Array.from(missingCheckinEmployeeIdSet)
    if (!targets.length) {
      flash('No missing check-ins to notify')
      return
    }

    setConfirmModal({
      open: true,
      title: 'Notify Missing Check-ins',
      message: `Send warning email to ${targets.length} employee(s) for missing attendance record in the selected range?`,
      confirmText: 'Send',
      onConfirm: async () => {
        setBulkWarningSending(true)
        try {
          const results = await Promise.all(
            targets.map((employeeId) => handleWarnEmployee(employeeId, 'Missing attendance record', { key: `missing-${employeeId}` }, false)),
          )
          const ok = results.filter(Boolean).length
          if (ok > 0) flash(`${ok} notification(s) sent`)
        } finally {
          setBulkWarningSending(false)
        }
      },
    })
  }

  function applyLogsRange(range) {
    const next = String(range || 'today')
    const today = formatDateInput()
    setLogsRangeFilter(next)
    setDate(today)

    if (next === 'today') {
      setLogsFromDate(today)
      setLogsToDate(today)
      return
    }
    if (next === 'week') {
      setLogsFromDate(dateKeyOffsetFromToday(-6))
      setLogsToDate(today)
      return
    }
    if (next === 'month') {
      setLogsFromDate(dateKeyOffsetFromToday(-29))
      setLogsToDate(today)
      return
    }
  }

  function applyReportsRange(range) {
    const next = String(range || 'week')
    const today = formatDateInput()
    setReportsRange(next)
    if (next === 'today') {
      setReportsFromDate(today)
      setReportsToDate(today)
      return
    }
    if (next === 'week') {
      setReportsFromDate(dateKeyOffsetFromToday(-6))
      setReportsToDate(today)
      return
    }
    if (next === 'month') {
      setReportsFromDate(dateKeyOffsetFromToday(-29))
      setReportsToDate(today)
      return
    }
  }

  function goToView(nextView, group = 'attendance', itemId = '') {
    setView(nextView)
    setExpandedSidebarSection(group)
    if (itemId) setActiveSidebarItem(itemId)
    setMobileSidebarOpen(false)
    setProfileMenuOpen(false)
  }

  function toggleSidebarSection(sectionId) {
    if (sidebarCollapsed) {
      setSidebarCollapsed(false)
      setExpandedSidebarSection(sectionId)
      return
    }
    setExpandedSidebarSection((old) => (old === sectionId ? '' : sectionId))
  }

  function handleSidebarItemClick(item, sectionId) {
    if (!item) return
    setActiveSidebarItem(String(item.id || ''))
    setExpandedSidebarSection(sectionId)

    if (item.id === 'attendance-all-records') {
      setLogsStatusFilter('all')
    }
    if (item.id === 'attendance-exceptions') {
      setLogsSearch('')
      setLogsStatusFilter('all')
      setLogsDeptFilter('all')
      setLogsShiftFilter('all')
      setExceptionTypeFilter('both')
      setLogsSort({ key: 'check_in', direction: 'desc' })
      applyLogsRange('week')
    }

    if (item.action === 'logout') {
      logout()
      setMobileSidebarOpen(false)
      return
    }
    if (item.view) {
      if (item.path) {
        navigate(String(item.path))
      }
      if (item.view === 'directory') navigate('/employees')
      if (item.view === 'add') navigate('/admin/employees/add')
      if (item.view === 'assets') navigate('/admin/assets')
      if (item.view === 'tasks') navigate('/admin/tasks')
      if (item.id === 'settings-general') navigate('/admin/settings/general')
      goToView(item.view, sectionId, item.id)
    }
  }

  useEffect(() => {
    const employeeId = String(routeParams?.employeeId || '').trim()
    const pathname = String(location?.pathname || '')
    if (!initialRouteHandledRef.current) {
      initialRouteHandledRef.current = true
    }
    if (pathname === '/account/profile') {
      setView('accountProfile')
      setExpandedSidebarSection('account')
      setActiveSidebarItem('account-profile')
      return
    }
    if (pathname === '/admin/assets') {
      setView('assets')
      setExpandedSidebarSection('employees')
      setActiveSidebarItem('employees-assets')
      return
    }
    if (pathname === '/admin/tasks') {
      setView('tasks')
      setExpandedSidebarSection('attendance')
      setActiveSidebarItem('attendance-tasks')
      return
    }
    if (pathname === '/account/change-password') {
      setView('accountChangePassword')
      setExpandedSidebarSection('account')
      setActiveSidebarItem('account-change-password')
      return
    }
    if (pathname === '/account/security') {
      setView('accountSecurity')
      setExpandedSidebarSection('account')
      setActiveSidebarItem('account-security')
      return
    }
    if (pathname === '/admin/employee-payroll') {
      setView('employeePayroll')
      setExpandedSidebarSection('payroll')
      setActiveSidebarItem('employee-payroll')
      return
    }
    if (pathname === '/admin/employees/add') {
      setView('add')
      setExpandedSidebarSection('employees')
      setActiveSidebarItem('employees-add')
      return
    }
    if (pathname === '/admin/settings/general') {
      setView('settings')
      setExpandedSidebarSection('settings')
      setActiveSidebarItem('settings-general')
      return
    }
    if (employeeId) {
      setView('employeeProfile')
      setExpandedSidebarSection('employees')
      setActiveSidebarItem('employees-all')
      setEmployeeAssetsSearch('')
      setEmployeeAssetsFilter('all')
      setEmployeeAssetsSort('newest')
      setEmployeeAssetsPage(1)
      if (employeeId !== String(employeeProfileId || '')) {
        setEmployeeProfileId(employeeId)
        loadEmployeeProfileById(employeeId)
        loadEmployeeProfileDashboardData(employeeId)
      }
      return
    }
    if (pathname === '/employees') {
      setView('directory')
      setExpandedSidebarSection('employees')
      setActiveSidebarItem('employees-all')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, routeParams.employeeId])

  const employeePayrollSelectedEmployee = useMemo(() => {
    const selectedId = String(employeePayrollEmployeeId || '').trim()
    const employeeList = Array.isArray(employees) ? employees : []
    if (!employeeList.length) return null
    if (selectedId) {
      const matched = employeeList.find((employee) => String(employee?.id || employee?._id || '').trim() === selectedId)
      if (matched) return matched
    }
    return employeeList[0] || null
  }, [employees, employeePayrollEmployeeId])

  useEffect(() => {
    if (view !== 'employeePayroll') return
    const employeeList = Array.isArray(employees) ? employees : []
    if (!employeeList.length) return
    const selectedId = String(employeePayrollEmployeeId || '').trim()
    const selectedExists = selectedId && employeeList.some((employee) => String(employee?.id || employee?._id || '').trim() === selectedId)
    if (!selectedExists) {
      setEmployeePayrollEmployeeId(String(employeeList[0]?.id || employeeList[0]?._id || ''))
    }
  }, [view, employees, employeePayrollEmployeeId])

  const employeeProfileAttendanceRows = useMemo(() => {
    const employeeId = String(employeeProfileData?.id || employeeProfileId || '').trim()
    if (!employeeId) return []
    const sourceRows = Array.isArray(employeeProfileAttendanceHistory) && employeeProfileAttendanceHistory.length
      ? employeeProfileAttendanceHistory
      : (Array.isArray(attendance) ? attendance : [])
    return sourceRows
      .filter((row) => {
        const rowEmployeeId = String(row?.employee_id || row?.id || '').trim()
        return rowEmployeeId === employeeId
      })
      .slice()
      .sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))
  }, [attendance, employeeProfileAttendanceHistory, employeeProfileData, employeeProfileId])

  const employeeProfileRequestRows = useMemo(() => {
    const employeeId = String(employeeProfileData?.id || employeeProfileId || '').trim()
    const employeeName = String(employeeProfileData?.name || '').trim().toLowerCase()
    return (Array.isArray(manualRequests) ? manualRequests : [])
      .filter((req) => {
        const reqEmployeeId = String(req?.employee_id || '').trim()
        const reqEmployeeName = String(req?.employee_name || '').trim().toLowerCase()
        if (employeeId && reqEmployeeId && employeeId === reqEmployeeId) return true
        if (employeeName && reqEmployeeName && employeeName === reqEmployeeName) return true
        return false
      })
      .slice()
      .sort((a, b) => {
        const aMs = parseBackendDateMs(a?.created_at || a?.updated_at || a?.date)
        const bMs = parseBackendDateMs(b?.created_at || b?.updated_at || b?.date)
        return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
      })
  }, [manualRequests, employeeProfileData, employeeProfileId])

  const filteredEmployeeAssets = useMemo(() => (Array.isArray(employeeAssets) ? employeeAssets : []), [employeeAssets])
  const employeeAssetsPageSize = 12
  const employeeAssetsTotalPages = Math.max(1, Math.ceil(Number(employeeAssetsTotal || 0) / employeeAssetsPageSize))
  const canDeleteEmployeeAssets = useMemo(() => {
    const claims = decodeToken(token || '') || {}
    const role = String(claims?.role || '').trim().toLowerCase()
    return role === 'admin' || role === 'hr'
  }, [token])

  const employeeProfileLeaveRows = useMemo(() => {
    const rows = []
    const seen = new Set()
    const addRow = (row, source) => {
      if (!row) return
      const key = String(row?.id || row?._id || `${source}-${row?.start_date || row?.date || ''}-${row?.created_at || ''}`).trim()
      if (key && seen.has(key)) return
      if (key) seen.add(key)
      rows.push({ ...row, source })
    }
    ;(Array.isArray(employeeProfileLeaveRequests) ? employeeProfileLeaveRequests : []).forEach((row) => addRow(row, 'leave'))
    ;(Array.isArray(employeeProfileRequestRows) ? employeeProfileRequestRows : [])
      .filter((row) => ['leave', 'wfh'].includes(requestTypeKey(row)))
      .forEach((row) => addRow(row, 'manual'))
    return rows.sort((a, b) => {
      const aMs = parseBackendDateMs(a?.updated_at || a?.created_at || a?.start_date || a?.date)
      const bMs = parseBackendDateMs(b?.updated_at || b?.created_at || b?.start_date || b?.date)
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
    })
  }, [employeeProfileLeaveRequests, employeeProfileRequestRows])

  const employeeProfileLeaveStats = useMemo(() => {
    const balances = employeeProfileLeaveBalance?.balances || {}
    const entries = Object.entries(balances)
    if (entries.length) {
      return entries.reduce((acc, [code, value]) => {
        const towardPaid = leaveBalanceCountsTowardPaidTotal(code, value)
        acc.items.push({
          code,
          name: String(value?.name || code),
          total: Number(value?.total || 0),
          used: Number(value?.used || 0),
          pending: Number(value?.pending || 0),
          available: Number(value?.available || 0),
          isPaidLeave: towardPaid,
        })
        if (towardPaid) {
          acc.total += Number(value?.total || 0)
          acc.used += Number(value?.used || 0)
          acc.pending += Number(value?.pending || 0)
          acc.available += Number(value?.available || 0)
        }
        return acc
      }, { total: 0, used: 0, pending: 0, available: 0, items: [] })
    }

    const annualQuota = Number(employeeProfileData?.work_policy?.paidLeavesPerMonth ?? 2) * 12
    const approvedUsed = employeeProfileLeaveRows
      .filter((row) => requestStatusKey(row) === 'approved')
      .reduce((sum, row) => sum + leaveRequestDays(row), 0)
    const pending = employeeProfileLeaveRows
      .filter((row) => requestStatusKey(row) === 'pending')
      .reduce((sum, row) => sum + leaveRequestDays(row), 0)

    return {
      total: annualQuota,
      used: approvedUsed,
      pending,
      available: Math.max(0, annualQuota - approvedUsed - pending),
      items: [
        {
          code: 'PL',
          name: 'Paid Leave',
          total: annualQuota,
          used: approvedUsed,
          pending,
          available: Math.max(0, annualQuota - approvedUsed - pending),
          isPaidLeave: true,
        },
      ],
    }
  }, [employeeProfileData, employeeProfileLeaveBalance, employeeProfileLeaveRows])

  const employeeProfileCurrentSalary = useMemo(() => {
    const salaryType = String(employeeProfileSalaryData?.salaryType || employeeProfileData?.salary_type || '').toUpperCase()
    if (salaryType === 'IN_HAND') {
      return Number(employeeProfileSalaryData?.netTargetMonthly || employeeProfileData?.net_target_monthly || 0)
    }
    return Number(employeeProfileSalaryData?.monthlySalary || employeeProfileData?.monthly_salary || 0)
  }, [employeeProfileData, employeeProfileSalaryData])

  const employeeProfileOvertimeHours = useMemo(() => {
    const overtimeMinutes = employeeProfileAttendanceRows.reduce((sum, row) => Math.max(0, calculateWorkedMinutes(row) - 480) + sum, 0)
    return Math.round((overtimeMinutes / 60) * 10) / 10
  }, [employeeProfileAttendanceRows])

  const employeeProfileCalendarDays = useMemo(() => {
    const monthKey = String(date || formatDateInput()).slice(0, 7)
    const [year, month] = monthKey.split('-').map((x) => Number(x))
    if (!Number.isFinite(year) || !Number.isFinite(month)) return []
    const lastDay = new Date(year, month, 0).getDate()
    const byDate = new Map(employeeProfileAttendanceRows.map((row) => [String(row?.date || '').slice(0, 10), row]))
    return Array.from({ length: lastDay }).map((_, index) => {
      const day = index + 1
      const dayKey = `${monthKey}-${String(day).padStart(2, '0')}`
      const row = byDate.get(dayKey)
      const status = row ? attendanceStatusKey(row, dayKey) : (isWeekendDateKey(dayKey) ? 'holiday' : 'empty')
      return {
        date: dayKey,
        day,
        status,
        label: row ? attendanceStatusLabel(row, dayKey) : (status === 'holiday' ? 'HOLIDAY' : ''),
        row,
      }
    })
  }, [date, employeeProfileAttendanceRows])

  const employeeProfileDocuments = useMemo(() => buildEmployeeProfileDocuments(employeeProfileData, filteredEmployeeAssets), [employeeProfileData, filteredEmployeeAssets])

  const employeeProfileActivityRows = useMemo(() => {
    const rows = []
    employeeProfileAttendanceRows
      .filter((row) => row?.manual_entry || row?.manual_reason)
      .slice(0, 10)
      .forEach((row) => rows.push({
        type: 'Attendance Edit',
        detail: `${row?.date || '-'} · ${row?.manual_reason || 'Manual attendance update'}`,
        at: row?.updated_at || row?.created_at || row?.date,
      }))
    employeeProfileLeaveRows.slice(0, 10).forEach((row) => rows.push({
      type: 'Leave Approval',
      detail: `${requestTypeLabel(row)} · ${requestStatusLabel(row)} · ${row?.start_date || row?.date || '-'}`,
      at: row?.updated_at || row?.created_at || row?.start_date || row?.date,
    }))
    employeeProfilePayslips.slice(0, 10).forEach((row) => rows.push({
      type: 'Payroll Update',
      detail: `${monthLabel(row?.year, row?.month)} · ${formatMoney(row?.net_salary || row?.net || 0)}`,
      at: row?.generated_at || row?.paid_at || `${row?.year || ''}-${String(row?.month || '').padStart(2, '0')}-01`,
    }))
    if (employeeProfileData?.updated_at || employeeProfileData?.created_at) {
      rows.push({
        type: 'Profile Modification',
        detail: `${employeeProfileData?.designation || employeeProfileData?.role || 'Employee'} profile record updated`,
        at: employeeProfileData?.updated_at || employeeProfileData?.created_at,
      })
    }
    return rows
      .sort((a, b) => {
        const aMs = parseBackendDateMs(a?.at)
        const bMs = parseBackendDateMs(b?.at)
        return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
      })
      .slice(0, 30)
  }, [employeeProfileAttendanceRows, employeeProfileData, employeeProfileLeaveRows, employeeProfilePayslips])

  function clearRetryAction() {
    setRetryAction(null)
    setRetryLabel('')
  }

  const dashboardRangeBounds = useMemo(() => {
    const end = String(date || formatDateInput()).trim() || formatDateInput()
    if (overviewRange === 'week') {
      return { from: dateKeyShift(end, -6), to: end, label: 'Last 7 days' }
    }
    if (overviewRange === 'month') {
      return { from: dateKeyShift(end, -29), to: end, label: 'Last 30 days' }
    }
    if (overviewRange === 'custom') {
      const from = String(overviewCustomFrom || end).trim() || end
      const to = String(overviewCustomTo || end).trim() || end
      return { from: from <= to ? from : to, to: from <= to ? to : from, label: 'Custom range' }
    }
    return { from: end, to: end, label: 'Today' }
  }, [date, overviewRange, overviewCustomFrom, overviewCustomTo])

  function inDashboardRange(value, fallbackDate = '') {
    const explicit = String(fallbackDate || '').trim()
    const dayKey = explicit || dateKeyInIST(value)
    if (!dayKey) return false
    return dayKey >= dashboardRangeBounds.from && dayKey <= dashboardRangeBounds.to
  }

  const dashboardAttendanceRows = useMemo(() => {
    const rows = Array.isArray(attendance) ? attendance : []
    return rows.filter((row) => {
      const rowDate = String(row?.date || '').slice(0, 10)
      const fallback = row?.check_in_at || row?.check_out_at || row?.updated_at || row?.created_at || ''
      return inDashboardRange(fallback, rowDate)
    })
  }, [attendance, dashboardRangeBounds])

  const dashboardManualRequestRows = useMemo(() => {
    const rows = Array.isArray(manualRequests) ? manualRequests : []
    return rows.filter((request) => {
      const rowDate = String(request?.date || '').slice(0, 10)
      const fallback = request?.updated_at || request?.created_at || request?.requested_at || ''
      return inDashboardRange(fallback, rowDate)
    })
  }, [manualRequests, dashboardRangeBounds])

  const dashboardTaskRows = useMemo(() => {
    const rows = Array.isArray(tasks) ? tasks : []
    return rows.filter((task) => {
      const fallback = task?.updated_at || task?.created_at || task?.start_date || task?.deadline || ''
      return inDashboardRange(fallback)
    })
  }, [tasks, dashboardRangeBounds])

  const missingCheckinEmployeeIdSet = useMemo(() => {
    const employeeRows = Array.isArray(employees) ? employees : []
    if (!employeeRows.length) return new Set()

    const attendanceRows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    const seen = new Set()
    for (const row of attendanceRows) {
      const id = String(row?.employee_id || row?.employee_login_id || row?.login_id || row?.id || '').trim()
      if (id) seen.add(id)
    }

    const missing = new Set()
    for (const emp of employeeRows) {
      const status = String(emp?.status || 'active').toLowerCase()
      if (status === 'inactive' || status === 'exited') continue
      const empId = String(emp?.id || emp?.employee_id || '').trim()
      if (!empId) continue
      if (!seen.has(empId)) missing.add(empId)
    }

    return missing
  }, [employees, dashboardAttendanceRows])

  const missingCheckinEmployees = useMemo(() => {
    const employeeRows = Array.isArray(employees) ? employees : []
    if (!employeeRows.length) return []
    if (!missingCheckinEmployeeIdSet.size) return []
    return employeeRows.filter((emp) => missingCheckinEmployeeIdSet.has(String(emp?.id || emp?.employee_id || '').trim()))
  }, [employees, missingCheckinEmployeeIdSet])

  const counts = useMemo(() => {
    const checkedOut = dashboardAttendanceRows.filter((a) => !!a.check_out).length
    const checkedInOnly = dashboardAttendanceRows.filter((a) => !a.check_out).length
    return {
      total: dashboardAttendanceRows.length,
      checkedOut,
      checkedInOnly,
    }
  }, [dashboardAttendanceRows])

  const adminFirstName = useMemo(() => {
    const claims = decodeToken(token || '') || {}
    const displayName = String(
      claims?.first_name
      || claims?.name
      || claims?.full_name
      || claims?.username
      || claims?.login_id
      || username
      || 'admin',
    )
    return firstNameOf(displayName)
  }, [token, username])

  const absentTodayCount = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.filter((row) => String(row?.status || '').toLowerCase() === 'absent').length
  }, [dashboardAttendanceRows])

  const lateCount = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.filter((row) => String(resolveTimingStatus(row) || '').toLowerCase() === 'late').length
  }, [dashboardAttendanceRows])

  const halfDayCount = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.filter((row) => attendanceUiStatusKey(row) === 'half_day').length
  }, [dashboardAttendanceRows])

  const presentCount = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.filter((row) => {
      const status = String(row?.status || '').toLowerCase()
      return status === 'checked_in' || status === 'checked_out'
    }).length
  }, [dashboardAttendanceRows])

  const onLeaveTodayCount = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.filter((row) => {
      const status = String(row?.status || '').toLowerCase()
      const rowDate = String(row?.date || '').slice(0, 10)
      const leaveMarked = status === 'leave_marked' || status === 'leave' || status === 'on_leave'
      return leaveMarked && inDashboardRange('', rowDate)
    }).length
  }, [dashboardAttendanceRows, dashboardRangeBounds])

  const derivedAutoAbsentCount = useMemo(() => {
    const isTodayScope = dashboardRangeBounds.from === dashboardRangeBounds.to && dashboardRangeBounds.to === formatDateInput()
    const noRecordedRows = Number(presentCount || 0) === 0 && Number(absentTodayCount || 0) === 0
    if (!isTodayScope || !noRecordedRows || !isAfterDailyCutoff(AUTO_ABSENT_CUTOFF_HOUR)) return 0
    return Math.max(0, Number(employees.length || 0) - Number(onLeaveTodayCount || 0))
  }, [dashboardRangeBounds, presentCount, absentTodayCount, employees.length, onLeaveTodayCount])

  const effectiveAbsentTodayCount = useMemo(
    () => (derivedAutoAbsentCount > 0 ? derivedAutoAbsentCount : absentTodayCount),
    [derivedAutoAbsentCount, absentTodayCount],
  )

  const totalWorkMinutesToday = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.reduce((sum, row) => {
      const rowDate = String(row?.date || '').slice(0, 10)
      if (rowDate && !inDashboardRange('', rowDate)) return sum
      return sum + calculateWorkedMinutes(row)
    }, 0)
  }, [dashboardAttendanceRows, dashboardRangeBounds])

  const averageCheckInTimeText = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    const checkInMinutes = rows
      .map((row) => parseAttendanceTimeToMinutes(row?.check_in))
      .filter((value) => Number.isFinite(value))
    if (!checkInMinutes.length) return 'N/A — no data yet'
    const avgMinutes = checkInMinutes.reduce((sum, minutes) => sum + minutes, 0) / checkInMinutes.length
    return formatMinutesAs12Hour(avgMinutes)
  }, [dashboardAttendanceRows])

  const averageWorkHoursText = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    if (!rows.length) return 'N/A — no data yet'
    const avgMinutes = totalWorkMinutesToday / Math.max(1, rows.length)
    return `${(avgMinutes / 60).toFixed(1)}h`
  }, [dashboardAttendanceRows, totalWorkMinutesToday])

  const totalWorkHoursTodayText = useMemo(() => {
    const safeMinutes = Math.max(0, Number(totalWorkMinutesToday || 0))
    const hours = Math.floor(safeMinutes / 60)
    const minutes = safeMinutes % 60
    return `${hours}h ${minutes}m`
  }, [totalWorkMinutesToday])

  const overtimeMinutesToday = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.reduce((sum, row) => {
      const worked = calculateWorkedMinutes(row)
      // Standard shift is 8 hours (480 mins). Overtime = anything beyond that.
      return sum + Math.max(0, worked - 480)
    }, 0)
  }, [dashboardAttendanceRows])

  const overtimeHoursText = useMemo(() => {
    const safe = Math.max(0, Number(overtimeMinutesToday || 0))
    const hours = Math.floor(safe / 60)
    const mins = safe % 60
    return `${hours}h ${mins}m`
  }, [overtimeMinutesToday])

  const activelyWorkingCount = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows.filter((row) => {
      const status = String(row?.status || '').toLowerCase()
      const hasCheckIn = !!String(row?.check_in || '').trim()
      const hasCheckOut = !!String(row?.check_out || '').trim()
      return hasCheckIn && !hasCheckOut && status !== 'absent'
    }).length
  }, [dashboardAttendanceRows])

  const attendancePercent = useMemo(() => {
    const totalActive = Math.max(1, employees.filter(e => String(e?.status || 'active').toLowerCase() !== 'inactive').length)
    return Math.round((presentCount / totalActive) * 100)
  }, [employees, presentCount])

  const attendanceTrendData = useMemo(() => {
    const from = String(dashboardRangeBounds?.from || formatDateInput())
    const to = String(dashboardRangeBounds?.to || formatDateInput())

    const safeKeys = listDateKeysInRange(from, to)
    const trimmedKeys = (safeKeys.length ? safeKeys : [to]).slice(-31)

    const toPresentAbsent = (row) => {
      const status = String(row?.status || '').toLowerCase()
      const hasAttendance = !!String(row?.check_in || '').trim() || !!String(row?.check_out || '').trim()
      if (status === 'absent') return 'absent'
      if (status === 'checked_in' || status === 'checked_out' || status === 'already_recorded' || hasAttendance) return 'present'
      return ''
    }

    if (trimmedKeys.length <= 7) {
      const buckets = trimmedKeys.map((dateKey) => ({
        dateKey,
        label: formatWeekdayFromDateKey(dateKey),
        present: 0,
        absent: 0,
      }))
      const idx = new Map(buckets.map((b, i) => [b.dateKey, i]))

      for (const row of (dashboardAttendanceRows || [])) {
        const rowDate = String(row?.date || '').slice(0, 10)
        if (!rowDate || !idx.has(rowDate)) continue
        const key = toPresentAbsent(row)
        if (!key) continue
        buckets[idx.get(rowDate)][key] += 1
      }

      return buckets.map((b) => ({ label: b.label, present: b.present, absent: b.absent }))
    }

    const bucketCount = 7
    const perBucket = Math.max(1, Math.ceil(trimmedKeys.length / bucketCount))
    const buckets = Array.from({ length: Math.min(bucketCount, Math.ceil(trimmedKeys.length / perBucket)) }, (_, i) => {
      const start = trimmedKeys[i * perBucket]
      const end = trimmedKeys[Math.min(trimmedKeys.length - 1, (i + 1) * perBucket - 1)]
      return {
        start,
        end,
        label: `${String(start).slice(5)}-${String(end).slice(5)}`,
        present: 0,
        absent: 0,
      }
    })

    const bucketIndexForDate = (dayKey) => {
      for (let i = 0; i < buckets.length; i += 1) {
        if (dayKey >= buckets[i].start && dayKey <= buckets[i].end) return i
      }
      return -1
    }

    for (const row of (dashboardAttendanceRows || [])) {
      const rowDate = String(row?.date || '').slice(0, 10)
      if (!rowDate) continue
      const i = bucketIndexForDate(rowDate)
      if (i < 0) continue
      const key = toPresentAbsent(row)
      if (!key) continue
      buckets[i][key] += 1
    }

    return buckets.map((b) => ({ label: b.label, present: b.present, absent: b.absent }))
  }, [dashboardAttendanceRows, dashboardRangeBounds])

  const dashboardPayrollBarData = useMemo(() => {
    const months = ['Jul', 'Aug', 'Sep', 'Oct', 'Nov']
    const active = employees.filter((e) => String(e?.status || 'active').toLowerCase() !== 'inactive')
    const headcount = Math.max(0, active.length)
    const companyTag = String(selectedCompanyId || selectedCompany?.id || '').length
    const hash = Math.max(1, headcount * 17 + companyTag * 31)
    const baseK = headcount <= 0
      ? 52
      : Math.max(
        36,
        Math.round(headcount * 26.25 * (0.91 + ((hash % 11) / 200))),
      )
    return months.map((name, i) => {
      const ripple = Math.round(5 * Math.sin((i + (hash % 5)) * 1.07))
      const glide = Math.round((i - 2) * 2.25 + ((hash >> 3) % 5))
      return {
        name,
        expense: Math.max(42, Math.round(baseK + ripple + glide)),
      }
    })
  }, [employees, selectedCompany?.id, selectedCompanyId])

  const leavePieChartData = useMemo(() => {
    const fromApi = Array.isArray(leaveAnalytics?.usage_by_type) ? leaveAnalytics.usage_by_type : []
    const mapped = fromApi
      .map((u) => ({
        name: String(u?._id || u?.name || 'Leave').trim() || 'Leave',
        value: Number(u?.total_days || u?.value || 0),
      }))
      .filter((d) => d.value > 0)
    if (mapped.length) return mapped

    const seed = Math.max(3, Number(employees.length || 12))
    return [
      { name: 'Earned Leave', value: Math.max(6, (seed % 9) + 8) },
      { name: 'Casual Leave', value: Math.max(4, (seed % 6) + 4) },
      { name: 'Sick Leave', value: Math.max(2, (seed % 4) + 2) },
      { name: 'LOP', value: Math.max(0, (seed >> 2) % 3) },
    ].filter((d) => d.value > 0)
  }, [leaveAnalytics, employees.length])

  const liveAttendanceRows = useMemo(() => {
    const rows = Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : []
    return rows
      .filter((row) => {
        const status = String(row?.status || '').toLowerCase()
        const hasCheckIn = !!String(row?.check_in || '').trim()
        const hasCheckOut = !!String(row?.check_out || '').trim()
        return hasCheckIn && !hasCheckOut && status !== 'absent'
      })
      .sort((a, b) => String(b?.check_in_at || b?.check_in || '').localeCompare(String(a?.check_in_at || a?.check_in || '')))
      .slice(0, 6)
  }, [dashboardAttendanceRows])

  const recentActivities = useMemo(() => {
    const items = []

    const attendanceRows = (Array.isArray(dashboardAttendanceRows) ? dashboardAttendanceRows : [])
      .slice()
      .sort((a, b) => {
        const aAt = a?.updated_at || a?.check_out_at || a?.check_in_at || a?.date || ''
        const bAt = b?.updated_at || b?.check_out_at || b?.check_in_at || b?.date || ''
        return String(bAt).localeCompare(String(aAt))
      })
      .slice(0, 15)

    for (const row of attendanceRows) {
      const empName = row?.employee_name || 'Employee'
      const firstName = empName.split(' ')[0] || empName
      const status = String(row?.status || '').toLowerCase()
      const timing = String(resolveTimingStatus(row) || '').toLowerCase()
      const checkIn = row?.check_in ? formatTime12Hour(row.check_in) : null
      const checkOut = row?.check_out ? formatTime12Hour(row.check_out) : null
      const isLate = timing.includes('late')
      const isEarlyExit = timing.includes('left early') || timing.includes('early')
      const isLeave = status === 'leave' || status === 'leave_marked' || Boolean(row?.leave_marked)
      const isAbsent = status === 'absent' || Boolean(row?.auto_absent)
      const workedMins = calculateWorkedMinutes(row)
      const isHalfDay = workedMins > 0 && workedMins < 4 * 60

      let label, detail, badge, tone
      if (isLeave) {
        label = `${firstName} is on leave`
        detail = `Full day leave · ${row?.date || ''}`
        badge = 'leave'
        tone = 'info'
      } else if (isAbsent) {
        label = `${firstName} marked absent`
        detail = `No check-in recorded · ${row?.date || ''}`
        badge = 'absent'
        tone = 'danger'
      } else if (checkOut && isEarlyExit) {
        label = `${firstName} checked out early`
        detail = checkOut ? `Left at ${checkOut}` : 'Early exit recorded'
        badge = 'early-exit'
        tone = 'warning'
      } else if (checkOut) {
        label = `${firstName} checked out at ${checkOut}`
        detail = checkIn ? `In ${checkIn} · ${formatDurationLabel(workedMins)} worked` : 'Check-out recorded'
        badge = 'checkout'
        tone = 'success'
      } else if (checkIn && isLate) {
        label = `${firstName} checked in late at ${checkIn}`
        detail = `Late arrival · ${row?.date || ''}`
        badge = 'late'
        tone = 'warning'
      } else if (checkIn) {
        label = `${firstName} checked in at ${checkIn}`
        detail = isHalfDay ? 'Half-day attendance' : 'Currently working'
        badge = 'checkin'
        tone = 'success'
      } else {
        label = `${firstName} attendance updated`
        detail = `Status: ${status || 'unknown'}`
        badge = 'general'
        tone = 'neutral'
      }

      items.push({
        id: `att-${row?.id || row?.employee_name || Math.random()}`,
        icon: Clock3,
        type: 'attendance',
        label,
        detail,
        badge,
        tone,
        initials: empName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(),
        at: row?.updated_at || row?.check_out_at || row?.check_in_at || row?.date || '',
      })
    }

    const requestRows = (Array.isArray(dashboardManualRequestRows) ? dashboardManualRequestRows : [])
      .slice()
      .sort((a, b) => {
        const aAt = a?.updated_at || a?.created_at || a?.requested_at || a?.date || ''
        const bAt = b?.updated_at || b?.created_at || b?.requested_at || b?.date || ''
        return String(bAt).localeCompare(String(aAt))
      })
      .slice(0, 12)

    for (const request of requestRows) {
      const empName = request?.employee_name || 'Employee'
      const firstName = empName.split(' ')[0] || empName
      const reqStatus = String(request?.status || 'submitted').toLowerCase()
      const reqType = String(request?.request_type || request?.reason || 'Request').trim()
      const action = reqStatus === 'approved' ? 'approved' : reqStatus === 'rejected' ? 'rejected' : 'requested'

      items.push({
        id: `req-${request?.id || Math.random()}`,
        icon: ClipboardList,
        type: 'request',
        label: `${firstName} ${action} ${reqType.toLowerCase()}`,
        detail: `${reqType} · ${reqStatus}`,
        badge: reqStatus,
        tone: reqStatus === 'approved' ? 'info' : reqStatus === 'rejected' ? 'danger' : 'warning',
        initials: empName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(),
        at: request?.updated_at || request?.created_at || request?.date || '',
      })
    }

    const taskRows = (Array.isArray(dashboardTaskRows) ? dashboardTaskRows : [])
      .slice()
      .sort((a, b) => String(b?.updated_at || b?.created_at || '').localeCompare(String(a?.updated_at || a?.created_at || '')))
      .slice(0, 12)

    for (const task of taskRows) {
      const empName = task?.assigned_to_name || task?.assigned_to || 'Employee'
      const firstName = empName.split(' ')[0] || empName
      const title = task?.title || 'Task update'

      items.push({
        id: `task-${task?.id || Math.random()}`,
        icon: CheckCircle2,
        type: 'task',
        label: `${firstName}: ${title}`,
        detail: String(task?.status || 'pending').replace(/_/g, ' '),
        badge: String(task?.status || 'pending'),
        tone: String(task?.status || '').includes('complete') ? 'success' : 'info',
        initials: empName.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase(),
        at: task?.updated_at || task?.created_at || '',
      })
    }

    // Demo fallback: if no real data, show realistic seed activities
    if (!items.length) {
      const nowDate = new Date()
      items.push({ id: 'demo-1', icon: Clock3, type: 'attendance', label: 'Rahul S. checked in at 9:12 AM', detail: 'On time', badge: 'present', tone: 'success', initials: 'RS', at: new Date(nowDate.getTime() - 15 * 60000).toISOString() })
      items.push({ id: 'demo-2', icon: ClipboardList, type: 'request', label: 'Priya Singh approved SL', detail: 'Approved for 2 days', badge: 'approved', tone: 'info', initials: 'PS', at: new Date(nowDate.getTime() - 45 * 60000).toISOString() })
      items.push({ id: 'demo-3', icon: UserPlus, type: 'general', label: 'Aman Kumar added to Marketing', detail: 'New Employee Onboarded', badge: 'onboarded', tone: 'info', initials: 'AK', at: new Date(nowDate.getTime() - 120 * 60000).toISOString() })
      items.push({ id: 'demo-4', icon: IndianRupee, type: 'general', label: 'Payroll November Generated', detail: 'System Action', badge: 'processed', tone: 'success', initials: 'HR', at: new Date(nowDate.getTime() - 240 * 60000).toISOString() })
      items.push({ id: 'demo-5', icon: Clock3, type: 'attendance', label: 'Neha Patel late arrival', detail: 'Checked in at 10:05 AM', badge: 'late', tone: 'warning', initials: 'NP', at: new Date(nowDate.getTime() - 360 * 60000).toISOString() })
    }

    return items
      .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')))
      .slice(0, 15)
  }, [dashboardAttendanceRows, dashboardManualRequestRows, dashboardTaskRows])

  const filteredRecentActivities = useMemo(() => {
    const key = String(activityTypeFilter || 'all').toLowerCase()
    if (key === 'all') return recentActivities
    return (recentActivities || []).filter((item) => {
      const type = String(item?.type || 'general').toLowerCase()
      if (key === 'checkins') return type === 'attendance'
      if (key === 'approvals') return type === 'request'
      if (key === 'edits') return type === 'task'
      if (key === 'system') return type === 'general'
      return true
    })
  }, [recentActivities, activityTypeFilter])

  const groupedRecentActivities = useMemo(() => {
    const todayKey = formatDateInput()
    const today = []
    const earlier = []
    for (const item of (filteredRecentActivities || [])) {
      const eventDate = dateKeyInIST(item?.at || '')
      if (eventDate === todayKey) {
        today.push(item)
      } else {
        earlier.push(item)
      }
    }
    return { today, earlier }
  }, [filteredRecentActivities])

  const liveFallbackTimeline = useMemo(
    () => filteredRecentActivities.filter((item) => item?.type === 'attendance').slice(0, 4),
    [filteredRecentActivities],
  )

  const globalSearchResults = useMemo(() => {
    const q = String(globalSearchQuery || '').trim().toLowerCase()
    if (!q) return []
    const rows = []
    for (const e of (employees || [])) {
      const name = String(e?.name || '').trim()
      const loginId = String(e?.login_id || '').trim()
      if (`${name} ${loginId}`.toLowerCase().includes(q)) {
        rows.push({ id: `emp-${e.id || loginId || name}`, type: 'Employee', title: name || loginId || 'Employee', subtitle: loginId || '-' })
      }
    }
    for (const req of (manualRequests || [])) {
      const emp = String(req?.employee_name || '').trim()
      const status = String(req?.status || 'pending').trim()
      const reason = String(req?.reason || req?.request_type || '').trim()
      if (`${emp} ${status} ${reason}`.toLowerCase().includes(q)) {
        rows.push({ id: `req-${req.id || Math.random()}`, type: 'Request', title: emp || 'Request', subtitle: `${status}${reason ? ` · ${reason}` : ''}` })
      }
    }
    for (const task of (tasks || [])) {
      const title = String(task?.title || '').trim()
      const assignee = String(task?.assigned_to_name || task?.assigned_to || '').trim()
      if (`${title} ${assignee}`.toLowerCase().includes(q)) {
        rows.push({ id: `task-${task.id || Math.random()}`, type: 'Task', title: title || 'Task', subtitle: assignee || '-' })
      }
    }
    return rows.slice(0, 10)
  }, [globalSearchQuery, employees, manualRequests, tasks])

  const adminAlertItems = useMemo(() => {
    const rows = Array.isArray(adminNotifications) ? adminNotifications : []
    if (!adminNotificationsClearedAt) return rows
    const clearedMs = Date.parse(adminNotificationsClearedAt)
    if (!Number.isFinite(clearedMs)) return rows
    return rows.filter((item) => {
      const createdAt = String(item?.createdAt || item?.created_at || '')
      const createdMs = Date.parse(createdAt)
      if (!Number.isFinite(createdMs)) return true
      return createdMs > clearedMs
    })
  }, [adminNotifications, adminNotificationsClearedAt])

  const adminAlertBadgeCount = useMemo(() => {
    if (adminNotificationsClearedAt) return adminAlertItems.length
    const total = Number(adminAlertsTotal || 0)
    if (Number.isFinite(total) && total > 0) return total
    return adminAlertItems.length
  }, [adminAlertsTotal, adminAlertItems, adminNotificationsClearedAt])

  const groupedNotificationDrawerItems = useMemo(() => {
    const todayKey = formatDateInput()
    const grouped = { today: [], earlier: [] }
    for (const item of adminAlertItems) {
      const createdAt = String(item?.createdAt || item?.created_at || '')
      const dateKey = dateKeyInIST(createdAt)
      if (dateKey === todayKey) {
        grouped.today.push(item)
      } else {
        grouped.earlier.push(item)
      }
    }
    return grouped
  }, [adminAlertItems])

  const smartInsights = useMemo(() => {
    const trendRows = Array.isArray(attendanceTrendData) ? attendanceTrendData : []
    const latest = trendRows[trendRows.length - 1] || { present: 0 }
    const previous = trendRows[trendRows.length - 2] || { present: 0 }
    const presentDrop = Math.max(0, Number(previous.present || 0) - Number(latest.present || 0))
    const missingCheckIns = Math.max(0, Number(employees.length || 0) - Number(counts.total || 0))
    const sevenDayAvg = trendRows.length
      ? trendRows.reduce((sum, row) => sum + Number(row.present || 0), 0) / trendRows.length
      : 0
    const dropPct = sevenDayAvg > 0 ? ((sevenDayAvg - Number(latest.present || 0)) / sevenDayAvg) * 100 : 0

    const fridayAbsenceByEmployee = new Map()
    const today = new Date()
    const fourWeeksAgo = new Date(today)
    fourWeeksAgo.setDate(today.getDate() - 28)
    for (const row of (attendance || [])) {
      const rowDateText = String(row?.date || '').slice(0, 10)
      if (!rowDateText) continue
      const rowDate = new Date(`${rowDateText}T00:00:00`)
      if (rowDate < fourWeeksAgo || rowDate > today || rowDate.getDay() !== 5) continue
      const status = String(row?.status || '').toLowerCase()
      if (status !== 'absent') continue
      const name = String(row?.employee_name || '').trim() || 'Employee'
      fridayAbsenceByEmployee.set(name, Number(fridayAbsenceByEmployee.get(name) || 0) + 1)
    }
    const likelyAbsentNames = Array.from(fridayAbsenceByEmployee.entries())
      .filter(([, count]) => count >= 2)
      .map(([name]) => name)
      .slice(0, 3)

    return [
      {
        id: 'attendance-drop',
        title: 'Attendance drop',
        summary: presentDrop > 0
          ? `${presentDrop} fewer present employees vs previous tracked day.`
          : 'Attendance is stable versus previous tracked day.',
        tone: presentDrop > 0 ? 'warning' : 'success',
      },
      {
        id: 'missing-checkins',
        title: 'Missing check-ins',
        summary: missingCheckIns > 0
          ? `${missingCheckIns} employees still have no attendance record in this range.`
          : 'No missing check-ins in the current range.',
        tone: missingCheckIns > 0 ? 'warning' : 'success',
      },
      {
        id: 'late-arrivals',
        title: 'Late arrivals',
        summary: lateCount > 0
          ? `${lateCount} late arrivals detected. Consider a manager follow-up.`
          : 'No late arrivals detected in this range.',
        tone: lateCount > 0 ? 'warning' : 'success',
      },
      {
        id: 'predictive-absenteeism',
        title: 'Predictive absenteeism',
        summary: likelyAbsentNames.length
          ? `Likely absent this Friday: ${likelyAbsentNames.join(', ')}.`
          : 'No high-risk Friday absenteeism pattern detected in last 4 weeks.',
        tone: likelyAbsentNames.length ? 'warning' : 'success',
      },
      {
        id: 'anomaly-checkin-drop',
        title: 'Check-in anomaly monitor',
        summary: dropPct > 40
          ? `Today check-ins are down ${Math.round(dropPct)}% vs 7-day average.`
          : 'No major check-in anomaly vs 7-day trend.',
        tone: dropPct > 40 ? 'warning' : 'success',
      },
    ]
  }, [attendanceTrendData, counts.total, employees.length, lateCount, attendance])

  const departmentAttendanceBreakdown = useMemo(() => {
    const byDept = new Map()
    for (const employee of (employees || [])) {
      const dept = String(employee?.department || 'General').trim() || 'General'
      if (!byDept.has(dept)) byDept.set(dept, { department: dept, present: 0, absent: 0, total: 0 })
      byDept.get(dept).total += 1
    }
    for (const row of (dashboardAttendanceRows || [])) {
      const dept = String(row?.department || 'General').trim() || 'General'
      if (!byDept.has(dept)) byDept.set(dept, { department: dept, present: 0, absent: 0, total: 0 })
      const status = attendanceUiStatusKey(row)
      if (status === 'present' || status === 'late' || status === 'half_day') byDept.get(dept).present += 1
      if (status === 'absent') byDept.get(dept).absent += 1
    }
    return Array.from(byDept.values())
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
  }, [employees, dashboardAttendanceRows])

  const joinersAndExitsThisMonth = useMemo(() => {
    const currentMonth = formatDateInput().slice(0, 7)
    const joiners = (employees || []).filter((e) => {
      const joined = String(e?.joining_date || e?.date_of_joining || e?.joined_on || '').slice(0, 7)
      return joined === currentMonth
    })
    const exits = (employees || []).filter((e) => {
      const status = String(e?.status || '').toLowerCase()
      const exitDate = String(e?.exit_date || e?.last_working_day || e?.updated_at || '').slice(0, 7)
      return (status === 'inactive' || status === 'exited') && exitDate === currentMonth
    })
    return {
      joiners: joiners.slice(0, 5),
      exits: exits.slice(0, 5),
      joinersCount: joiners.length,
      exitsCount: exits.length,
    }
  }, [employees])

  const directoryDepartments = useMemo(() => {
    const set = new Set((employees || []).map((e) => (e.department || 'General').trim() || 'General'))
    for (const item of (departments || [])) {
      const dept = String(item?.name || item || '').trim()
      if (dept) set.add(dept)
    }
    for (const t of (tasks || [])) {
      const dept = String(t?.department_tag || '').trim()
      if (dept) set.add(dept)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [employees, tasks, departments])

  const directoryRoles = useMemo(() => {
    const set = new Set((employees || []).map((e) => String(e.role || 'staff').trim().toLowerCase() || 'staff'))
    for (const item of (roles || [])) {
      const roleName = String(item?.name || item || '').trim().toLowerCase()
      if (roleName) set.add(roleName)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [employees, roles])

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

  function formatMoney(value) {
    const amount = Number(value || 0)
    if (!Number.isFinite(amount)) return '₹0.00'
    return `₹${amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
  }

  function monthLabel(year, month) {
    const y = Number(year)
    const m = Number(month)
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return '-'
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
  }

  function formatEmployeeDate(value) {
    const text = String(value || '').trim()
    if (!text) return '-'
    const day = text.slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return text
    return new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  }

  function normalizeEmployeeProfileTab(tab) {
    const key = String(tab || '').trim().toLowerCase()
    if (key === 'profile') return 'overview'
    if (key === 'assets') return 'documents'
    if (['overview', 'attendance', 'leaves', 'payroll', 'documents', 'activity'].includes(key)) return key
    return 'overview'
  }

  function employeeIsActive(employee = {}) {
    const statusText = String(employee.status || '').toLowerCase()
    const isInactiveByStatus = statusText === 'inactive'
    const hasIsActiveFlag = typeof employee.is_active === 'boolean'
    const hasActiveFlag = typeof employee.active === 'boolean'
    return hasIsActiveFlag ? !!employee.is_active : (hasActiveFlag ? !!employee.active : !isInactiveByStatus)
  }

  function leaveRequestDays(row = {}) {
    const explicit = Number(row?.num_days || row?.days || row?.duration_days || 0)
    if (Number.isFinite(explicit) && explicit > 0) return explicit
    if (row?.half_day) return 0.5
    const start = String(row?.start_date || row?.from_date || row?.date || '').slice(0, 10)
    const end = String(row?.end_date || row?.to_date || start || '').slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return 1
    const startMs = new Date(`${start}T00:00:00`).getTime()
    const endMs = new Date(`${end}T00:00:00`).getTime()
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return 1
    return Math.floor((endMs - startMs) / 86400000) + 1
  }

  function buildEmployeeProfileDocuments(employee = {}, assets = []) {
    const assetRows = Array.isArray(assets) ? assets : []
    const findAsset = (patterns) => assetRows.find((asset) => {
      const name = String(asset?.file_name || '').toLowerCase()
      return patterns.some((pattern) => name.includes(pattern))
    })
    const mask = (value, visible = 4) => {
      const text = String(value || '').replace(/\s+/g, '').trim()
      if (!text) return ''
      return `${'•'.repeat(Math.max(0, text.length - visible))}${text.slice(-visible)}`
    }
    const rows = [
      {
        key: 'aadhaar',
        label: 'Aadhaar',
        detail: mask(employee?.aadhaar_number),
        asset: findAsset(['aadhaar', 'aadhar']),
      },
      {
        key: 'pan',
        label: 'PAN',
        detail: mask(employee?.pan_number),
        asset: findAsset(['pan']),
      },
      {
        key: 'bank',
        label: 'Bank Details',
        detail: [employee?.bank_name, mask(employee?.bank_account_no)].filter(Boolean).join(' · '),
        asset: findAsset(['bank', 'passbook', 'cheque', 'cancelled']),
      },
      {
        key: 'offer',
        label: 'Offer Letter',
        detail: '',
        asset: findAsset(['offer', 'appointment']),
      },
      {
        key: 'certificates',
        label: 'Certificates',
        detail: '',
        asset: findAsset(['certificate', 'degree', 'education']),
      },
    ]
    return rows.map((row) => ({
      ...row,
      status: row.detail || row.asset ? 'uploaded' : 'missing',
      fileName: row.asset?.file_name || '',
    }))
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

  async function loadEmployeeProfileById(employeeId) {
    if (!employeeId) return
    setEmployeeProfileLoading(true)
    setEmployeeProfileError('')
    try {
      try {
        const data = await apiFetch(`/api/employees/${encodeURIComponent(employeeId)}`, {}, token)
        setEmployeeProfileData(data?.employee || null)
      } catch (apiErr) {
        const code = Number(apiErr?.status || 0)
        if (code !== 404 && code !== 405) throw apiErr
        const fallback = (employees || []).find((e) => String(e.id) === String(employeeId)) || null
        setEmployeeProfileData(fallback)
      }
      setEmployeeProfileError('')
    } catch (err) {
      setEmployeeProfileData(null)
      setEmployeeProfileError(err.message || 'Unable to load employee profile')
    } finally {
      setEmployeeProfileLoading(false)
    }
  }

  function buildEmployeeProfileInsights(historyRows = [], employeeName = '', employeeId = '') {
    const rows = Array.isArray(historyRows) ? historyRows : []
    let presentDays = 0
    let absentDays = 0
    let lateCount = 0
    let totalMinutes = 0

    for (const row of rows) {
      const status = attendanceStatusKey(row, row?.date)
      const timing = String(resolveTimingStatus(row) || '').toLowerCase()
      const isLeaveOrHoliday = status === 'leave_marked' || status === 'holiday'
      const hasAttendance = !!String(row?.check_in || '').trim() || !!String(row?.check_out || '').trim()
      if (!isLeaveOrHoliday && status === 'absent') {
        absentDays += 1
      } else if (!isLeaveOrHoliday && hasAttendance) {
        presentDays += 1
      }
      if (timing.includes('late')) lateCount += 1
      totalMinutes += calculateWorkedMinutes(row)
    }

    const lastAttendance = rows
      .slice()
      .sort((a, b) => {
        const aMs = parseBackendDateMs(a?.updated_at || a?.check_out_at || a?.check_in_at || a?.date)
        const bMs = parseBackendDateMs(b?.updated_at || b?.check_out_at || b?.check_in_at || b?.date)
        return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
      })[0] || null

    const normalizedName = String(employeeName || '').trim().toLowerCase()
    const normalizedId = String(employeeId || '').trim()
    const requestRows = (manualRequests || []).filter((req) => {
      const reqName = String(req?.employee_name || '').trim().toLowerCase()
      const reqId = String(req?.employee_id || '').trim()
      if (normalizedId && reqId && normalizedId === reqId) return true
      if (normalizedName && reqName && normalizedName === reqName) return true
      return false
    })

    const lastRequest = requestRows
      .slice()
      .sort((a, b) => {
        const aMs = parseBackendDateMs(a?.updated_at || a?.created_at || a?.date)
        const bMs = parseBackendDateMs(b?.updated_at || b?.created_at || b?.date)
        return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0)
      })[0] || null

    return {
      loading: false,
      presentDays,
      absentDays,
      lateCount,
      totalWorkHours: Math.round((totalMinutes / 60) * 10) / 10,
      lastAttendance,
      lastRequest,
    }
  }

  async function loadEmployeeProfileInsights(employeeId, fallbackName = '') {
    if (!employeeId) return
    setEmployeeProfileInsights((old) => ({
      ...old,
      loading: true,
    }))
    try {
      const toDate = formatDateInput()
      const fromDate = dateKeyOffsetFromToday(-29)
      const payload = await apiFetch(
        `/admin/employee_attendance_history?employee_id=${encodeURIComponent(employeeId)}&from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`,
        {},
        token,
      )
      const rows = Array.isArray(payload?.rows) ? payload.rows.map((row) => normalizeAttendanceRow(row)) : []
      const employeeName = String(payload?.employee_name || fallbackName || '').trim()
      setEmployeeProfileAttendanceHistory(rows)
      setEmployeeProfileInsights(buildEmployeeProfileInsights(rows, employeeName, employeeId))
    } catch {
      const fallbackRows = (attendance || []).filter((row) => {
        const rowEmployeeId = String(row?.employee_id || row?.id || '').trim()
        return rowEmployeeId && rowEmployeeId === String(employeeId)
      })
      setEmployeeProfileAttendanceHistory(fallbackRows)
      setEmployeeProfileInsights(buildEmployeeProfileInsights(fallbackRows, fallbackName, employeeId))
    }
  }

  async function loadEmployeeProfileDashboardData(employeeId, fallbackName = '') {
    const id = String(employeeId || '').trim()
    if (!id) return
    setEmployeeProfileSupplementLoading(true)
    const year = new Date().getFullYear()
    try {
      const [
        salaryResult,
        leaveBalanceResult,
        leaveRequestsResult,
        payslipsResult,
      ] = await Promise.allSettled([
        apiFetch(`/api/employees/${encodeURIComponent(id)}/salary-structure`, {}, token),
        apiFetch(`/api/leave-balance/${encodeURIComponent(id)}?year=${encodeURIComponent(year)}`, {}, token),
        apiFetch(`/api/leave_requests?employee_id=${encodeURIComponent(id)}`, {}, token),
        apiFetch(`/api/payroll/payslips?employee_id=${encodeURIComponent(id)}`, {}, token),
        loadEmployeeProfileInsights(id, fallbackName),
        loadEmployeeAssets(id),
      ])

      setEmployeeProfileSalaryData(salaryResult.status === 'fulfilled' ? salaryResult.value : null)
      setEmployeeProfileLeaveBalance(leaveBalanceResult.status === 'fulfilled' ? leaveBalanceResult.value : null)
      setEmployeeProfileLeaveRequests(leaveRequestsResult.status === 'fulfilled' && Array.isArray(leaveRequestsResult.value) ? leaveRequestsResult.value : [])
      setEmployeeProfilePayslips(payslipsResult.status === 'fulfilled' && Array.isArray(payslipsResult.value) ? payslipsResult.value : [])
    } finally {
      setEmployeeProfileSupplementLoading(false)
    }
  }

  function employeeAssetFileUrl(asset, options = {}) {
    const rawPath = String(asset?.file_url || '').trim()
    if (!rawPath) return ''
    const isAbsolute = /^https?:\/\//i.test(rawPath)
    if (isAbsolute) {
      return rawPath
    }
    const absolute = `${String(BASE_URL || '').replace(/\/+$/, '')}${rawPath.startsWith('/') ? rawPath : `/${rawPath}`}`
    try {
      const base = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1'
      const url = new URL(absolute, base)
      if (token) url.searchParams.set('token', token)
      if (options.download) url.searchParams.set('download', '1')
      return url.toString()
    } catch {
      return absolute
    }
  }

  function revokeAssetUploadPreviews(fileRows = []) {
    for (const row of (Array.isArray(fileRows) ? fileRows : [])) {
      const previewUrl = String(row?.previewUrl || '')
      if (previewUrl && previewUrl.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(previewUrl)
        } catch {
          // no-op
        }
      }
    }
  }

  function closeEmployeeAssetsUploadModal() {
    setEmployeeAssetsUploadModal((old) => {
      revokeAssetUploadPreviews(old.files)
      return {
        open: false,
        dragActive: false,
        files: [],
        rejected: [],
        uploading: false,
        progressPercent: 0,
        uploadedCount: 0,
        totalCount: 0,
        currentFileName: '',
      }
    })
  }

  function openEmployeeAssetsUploadModal() {
    setEmployeeAssetsUploadModal((old) => {
      revokeAssetUploadPreviews(old.files)
      return {
        open: true,
        dragActive: false,
        files: [],
        rejected: [],
        uploading: false,
        progressPercent: 0,
        uploadedCount: 0,
        totalCount: 0,
        currentFileName: '',
      }
    })
  }

  function buildAssetDraftRows(files = [], existingRows = []) {
    const usedNames = new Set(
      (Array.isArray(existingRows) ? existingRows : [])
        .map((row) => String(row?.fileName || '').trim().toLowerCase())
        .filter(Boolean),
    )
    const accepted = []
    const rejected = []
    for (const file of (Array.isArray(files) ? files : [])) {
      const validationError = validateAssetFile(file)
      if (validationError) {
        rejected.push({ fileName: String(file?.name || 'file'), reason: validationError })
        continue
      }
      const mime = String(file?.type || '').toLowerCase()
      const kind = mime.startsWith('image/') ? 'image' : (mime.startsWith('video/') ? 'video' : 'document')
      const canPreview = kind === 'image' || kind === 'video'
      const uniqueName = nextUniqueAssetName(String(file?.name || 'file'), usedNames)
      usedNames.add(uniqueName.toLowerCase())
      accepted.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        fileName: uniqueName,
        size: Number(file?.size || 0),
        fileType: kind,
        previewUrl: canPreview ? URL.createObjectURL(file) : '',
      })
    }
    return { accepted, rejected }
  }

  function appendFilesToUploadModal(files = []) {
    if (!Array.isArray(files) || !files.length) return
    setEmployeeAssetsUploadModal((old) => {
      const existingRows = Array.isArray(old.files) ? old.files : []
      const { accepted, rejected } = buildAssetDraftRows(files, existingRows)
      if (rejected.length) {
        setError(rejected[0]?.reason || 'Unsupported file format')
      }
      return {
        ...old,
        files: [...existingRows, ...accepted],
        rejected: [...(Array.isArray(old.rejected) ? old.rejected : []), ...rejected],
      }
    })
  }

  function removeAssetDraftRow(draftId) {
    setEmployeeAssetsUploadModal((old) => {
      const rows = Array.isArray(old.files) ? old.files : []
      const target = rows.find((item) => String(item.id) === String(draftId))
      if (target?.previewUrl && target.previewUrl.startsWith('blob:')) {
        try {
          URL.revokeObjectURL(target.previewUrl)
        } catch {
          // no-op
        }
      }
      return {
        ...old,
        files: rows.filter((item) => String(item.id) !== String(draftId)),
      }
    })
  }

  async function loadEmployeeAssets(employeeId) {
    const id = String(employeeId || '').trim()
    if (!id) {
      setEmployeeAssets([])
      setEmployeeAssetsTotal(0)
      return
    }
    setEmployeeAssetsLoading(true)
    setEmployeeAssetsError('')
    try {
      const params = new URLSearchParams()
      params.set('employeeId', id)
      params.set('page', String(employeeAssetsPage))
      params.set('pageSize', String(employeeAssetsPageSize))
      params.set('sort', String(employeeAssetsSort || 'newest'))
      if (employeeAssetsFilter !== 'all') params.set('fileType', String(employeeAssetsFilter))
      if (String(employeeAssetsSearch || '').trim()) params.set('search', String(employeeAssetsSearch || '').trim())
      const payload = await apiFetch(`/api/assets?${params.toString()}`, {}, token)
      const rows = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.items) ? payload.items : [])
      setEmployeeAssets(rows)
      setEmployeeAssetsTotal(Number(payload?.total || rows.length || 0))
      const nextTotalPages = Math.max(1, Math.ceil(Number(payload?.total || 0) / employeeAssetsPageSize))
      if (employeeAssetsPage > nextTotalPages) {
        setEmployeeAssetsPage(nextTotalPages)
      }
      setEmployeeAssetsError('')
    } catch (err) {
      setEmployeeAssets([])
      setEmployeeAssetsTotal(0)
      setEmployeeAssetsError(err.message || 'Unable to load employee assets')
    } finally {
      setEmployeeAssetsLoading(false)
    }
  }

  useEffect(() => {
    const id = String(employeeProfileData?.id || employeeProfileId || '').trim()
    if (!id || employeeProfileTab !== 'documents') return
    loadEmployeeAssets(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeProfileData?.id, employeeProfileId, employeeProfileTab, employeeAssetsPage, employeeAssetsFilter, employeeAssetsSearch, employeeAssetsSort])

  async function submitEmployeeAssetsUpload() {
    const employeeId = String(employeeProfileData?.id || employeeProfileId || '').trim()
    const files = Array.isArray(employeeAssetsUploadModal.files) ? employeeAssetsUploadModal.files : []
    if (!employeeId) {
      setError('Select a valid employee first')
      return
    }
    if (!files.length) {
      setError('Please select at least one file to upload')
      return
    }

    setEmployeeAssetsUploadModal((old) => ({
      ...old,
      uploading: true,
      progressPercent: 0,
      uploadedCount: 0,
      totalCount: files.length,
      currentFileName: '',
    }))
    setError('')
    try {
      const total = files.length
      for (let i = 0; i < files.length; i += 1) {
        const row = files[i]
        setEmployeeAssetsUploadModal((old) => ({
          ...old,
          uploading: true,
          uploadedCount: i,
          totalCount: total,
          currentFileName: String(row?.fileName || row?.file?.name || ''),
          progressPercent: Math.round((i / Math.max(1, total)) * 100),
        }))
        await uploadEmployeeAssetWithProgress({
          employeeId,
          file: row.file,
          token,
          onProgress: (filePercent) => {
            const overall = ((i + (Number(filePercent || 0) / 100)) / Math.max(1, total)) * 100
            setEmployeeAssetsUploadModal((old) => ({
              ...old,
              uploading: true,
              uploadedCount: i,
              totalCount: total,
              currentFileName: String(row?.fileName || row?.file?.name || ''),
              progressPercent: Math.max(0, Math.min(100, Math.round(overall))),
            }))
          },
        })
      }
      setEmployeeAssetsUploadModal((old) => ({
        ...old,
        uploading: true,
        uploadedCount: total,
        totalCount: total,
        currentFileName: '',
        progressPercent: 100,
      }))
      closeEmployeeAssetsUploadModal()
      await loadEmployeeAssets(employeeId)
      flash('Employee asset uploaded successfully')
    } catch (err) {
      setError(err.message || 'Upload failed. Try again')
      setEmployeeAssetsUploadModal((old) => ({ ...old, uploading: false }))
    }
  }

  async function renameEmployeeAsset() {
    const assetId = String(employeeAssetRenameModal?.asset?.id || '').trim()
    const fileName = String(employeeAssetRenameModal?.fileName || '').trim()
    if (!assetId) return
    if (!fileName) {
      setError('File name is required')
      return
    }
    setEmployeeAssetRenameModal((old) => ({ ...old, saving: true }))
    try {
      await apiFetch(
        `/api/assets/${encodeURIComponent(assetId)}/rename`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_name: fileName }),
        },
        token,
      )
      const employeeId = String(employeeProfileData?.id || employeeProfileId || '').trim()
      await loadEmployeeAssets(employeeId)
      setEmployeeAssetRenameModal({ open: false, asset: null, fileName: '', saving: false })
      flash('File renamed successfully')
    } catch (err) {
      setError(err.message || 'Rename failed. Try again')
      setEmployeeAssetRenameModal((old) => ({ ...old, saving: false }))
    }
  }

  async function downloadAllEmployeeAssets() {
    const employeeId = String(employeeProfileData?.id || employeeProfileId || '').trim()
    if (!employeeId) return
    setEmployeeAssetsDownloadingAll(true)
    try {
      const response = await fetch(`${String(BASE_URL || '').replace(/\/+$/, '')}/api/assets/download-all?employeeId=${encodeURIComponent(employeeId)}`, {
        method: 'GET',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      })
      if (!response.ok) {
        let message = 'Unable to download files'
        try {
          const payload = await response.json()
          message = String(payload?.message || message)
        } catch {
          // no-op
        }
        throw new Error(message)
      }
      const blob = await response.blob()
      const contentDisposition = String(response.headers.get('content-disposition') || '')
      const match = contentDisposition.match(/filename="?([^\";]+)"?/i)
      const fileName = match?.[1] || `employee-assets-${employeeId}.zip`
      const downloadUrl = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = downloadUrl
      anchor.download = fileName
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      setTimeout(() => URL.revokeObjectURL(downloadUrl), 500)
      flash('All employee assets downloaded')
    } catch (err) {
      setError(err.message || 'Unable to download files')
    } finally {
      setEmployeeAssetsDownloadingAll(false)
    }
  }

  function confirmDeleteEmployeeAsset(asset) {
    const assetId = String(asset?.id || '')
    if (!assetId) return
    setConfirmModal({
      open: true,
      title: 'Delete asset?',
      message: `Delete ${String(asset?.file_name || 'this file')} permanently?`,
      confirmText: 'Delete',
      onConfirm: async () => {
        try {
          await apiFetch(`/api/assets/${encodeURIComponent(assetId)}`, { method: 'DELETE' }, token)
          const employeeId = String(employeeProfileData?.id || employeeProfileId || '').trim()
          await loadEmployeeAssets(employeeId)
          flash('File deleted successfully')
        } catch (err) {
          setError(err.message || 'Delete failed. Try again')
        }
      },
    })
  }

  async function openEmployeeProfile(employee, initialTab = 'profile') {
    const employeeId = String(employee?.id || '')
    if (!employeeId) return
    navigate(`/employees/${encodeURIComponent(employeeId)}`)
    setEmployeeProfileId(employeeId)
    setEmployeeProfileTab(normalizeEmployeeProfileTab(initialTab))
    setView('employeeProfile')
    await Promise.all([
      loadEmployeeProfileById(employeeId),
      loadEmployeeProfileDashboardData(employeeId, String(employee?.name || '')),
    ])
  }

  function generatePayslipForEmployee(employee) {
    const employeeId = String(employee?.id || employee?._id || '').trim()
    if (!employeeId) return
    setEmployeePayrollCompany('PR')
    setEmployeePayrollEmployeeId(employeeId)
    setView('employeePayroll')
    setExpandedSidebarSection('payroll')
    setActiveSidebarItem('employee-payroll')
    navigate('/admin/employee-payroll')
    flash(`Payroll opened for ${employee?.name || employee?.login_id || 'employee'}`)
  }

  async function downloadEmployeePayslipPdf(row, employee = employeeProfileData) {
    try {
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF()
      const pageWidth = pdf.internal.pageSize.width
      
      const employeeName = String(row?.employee_name || employee?.name || 'Employee')
      const employeeCode = String(employee?.emp_id || row?.employee_id || employee?.id || '-')
      const department = String(row?.department || employee?.department || 'General')
      const designation = String(employee?.designation || employee?.role || '-')
      const earnings = Array.isArray(row?.earnings) ? row.earnings : []
      const deductions = Array.isArray(row?.deductions) ? row.deductions : []

      // Header Section
      pdf.setFillColor(16, 185, 129) // Emerald primary
      pdf.rect(0, 0, pageWidth, 40, 'F')
      pdf.setTextColor(255, 255, 255)
      pdf.setFontSize(22)
      pdf.setFont('helvetica', 'bold')
      pdf.text(BRAND_NAME, 14, 25)
      pdf.setFontSize(10)
      pdf.setFont('helvetica', 'normal')
      pdf.text('PAYSLIP', pageWidth - 14, 25, { align: 'right' })
      pdf.text(monthLabel(row?.year, row?.month).toUpperCase(), pageWidth - 14, 32, { align: 'right' })

      // Employee Details Block
      pdf.setTextColor(0, 0, 0)
      let y = 55
      pdf.setFontSize(11)
      pdf.setFont('helvetica', 'bold')
      pdf.text(employeeName.toUpperCase(), 14, y)
      pdf.setFontSize(10)
      pdf.setFont('helvetica', 'normal')
      y += 6
      pdf.text(`Employee ID: ${employeeCode}`, 14, y)
      pdf.text(`Department: ${department}`, 100, y)
      y += 6
      pdf.text(`Designation: ${designation}`, 14, y)
      pdf.text(`Bank Account: XXXXXX${String(employee?.bank_account || '0000').slice(-4)}`, 100, y)
      y += 10
      
      // Attendance Summary
      pdf.setDrawColor(226, 232, 240)
      pdf.line(14, y, pageWidth - 14, y)
      y += 8
      pdf.setFontSize(10)
      pdf.setFont('helvetica', 'bold')
      pdf.text('Attendance Summary', 14, y)
      y += 6
      pdf.setFontSize(9)
      pdf.setFont('helvetica', 'normal')
      const paidDays = row?.paid_days ?? 30
      const lopDays = row?.lop_days ?? 0
      pdf.text(`Total Days: ${paidDays + lopDays}    Paid Days: ${paidDays}    LOP/Unpaid: ${lopDays}`, 14, y)
      y += 8
      pdf.line(14, y, pageWidth - 14, y)
      y += 12

      // Salary Structure Header
      pdf.setFontSize(11)
      pdf.setFont('helvetica', 'bold')
      pdf.text('EARNINGS', 14, y)
      pdf.text('DEDUCTIONS', pageWidth / 2 + 7, y)
      y += 6
      
      // Salary Split Content
      pdf.setFontSize(9)
      pdf.setFont('helvetica', 'normal')
      let eY = y
      if (earnings.length) {
        earnings.forEach((item) => {
          pdf.text(String(item?.name || item?.code || 'Component'), 14, eY)
          pdf.text(formatMoney(item?.amount || 0), pageWidth / 2 - 14, eY, { align: 'right' })
          eY += 6
        })
      } else {
        pdf.text('Basic Salary', 14, eY)
        pdf.text(formatMoney(row?.gross_salary || 0), pageWidth / 2 - 14, eY, { align: 'right' })
        eY += 6
      }
      
      let dY = y
      if (deductions.length) {
        deductions.forEach((item) => {
          pdf.text(String(item?.name || item?.code || 'Deduction'), pageWidth / 2 + 7, dY)
          pdf.text(formatMoney(item?.amount || 0), pageWidth - 14, dY, { align: 'right' })
          dY += 6
        })
      } else if (row?.total_deductions > 0) {
        pdf.text('Standard Deductions', pageWidth / 2 + 7, dY)
        pdf.text(formatMoney(row?.total_deductions || 0), pageWidth - 14, dY, { align: 'right' })
        dY += 6
      }
      
      y = Math.max(eY, dY) + 6
      
      // Totals Row
      pdf.setDrawColor(226, 232, 240)
      pdf.line(14, y, pageWidth - 14, y)
      y += 6
      pdf.setFontSize(10)
      pdf.setFont('helvetica', 'bold')
      pdf.text('Gross Earnings:', 14, y)
      pdf.text(formatMoney(row?.gross_salary || 0), pageWidth / 2 - 14, y, { align: 'right' })
      
      pdf.text('Total Deductions:', pageWidth / 2 + 7, y)
      pdf.text(formatMoney(row?.total_deductions || 0), pageWidth - 14, y, { align: 'right' })
      y += 6
      pdf.line(14, y, pageWidth - 14, y)
      y += 12

      // Net Salary Highlight
      pdf.setFillColor(241, 245, 249)
      pdf.rect(14, y, pageWidth - 28, 14, 'F')
      pdf.setFontSize(12)
      pdf.setFont('helvetica', 'bold')
      pdf.text('NET PAY:', 20, y + 9)
      pdf.text(formatMoney(row?.net_salary || row?.net || 0), pageWidth - 20, y + 9, { align: 'right' })
      y += 30

      // Digital Signature & Timestamp
      pdf.setFontSize(9)
      pdf.setFont('helvetica', 'normal')
      pdf.setTextColor(100, 116, 139)
      pdf.text('_______________________', pageWidth - 60, y)
      y += 5
      pdf.text('Authorized Signatory', pageWidth - 55, y)
      y += 20
      
      pdf.setFontSize(8)
      pdf.text(`This is a computer generated document. Generated on: ${new Date().toLocaleString()}`, 14, y)
      pdf.save(`payslip_${employeeName.replace(/\s+/g, '_')}_${row?.year || 'year'}_${row?.month || 'month'}.pdf`)
    } catch (err) {
      setError(err.message || 'Unable to generate payslip PDF')
    }
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
      const apiRows = Array.isArray(data?.rows) ? data.rows.map((row) => normalizeAttendanceRow(row)) : []
      const rowByDate = new Map(
        apiRows
          .map((row) => {
            const key = String(row?.date || '').trim()
            return [key, row]
          })
          .filter(([key]) => /^\d{4}-\d{2}-\d{2}$/.test(key)),
      )

      const allDates = listDateKeysInRange(fromDate, toDate)
      const employeeName = String(data?.employee_name || employeeAttendanceModal.employeeName || 'Employee')
      const rows = (allDates.length ? allDates : Array.from(rowByDate.keys()))
        .map((dateKey) => {
          const existing = rowByDate.get(dateKey)
          if (existing) return existing
          const weekend = isWeekendDateKey(dateKey)
          return {
            id: `virtual-${employeeId}-${dateKey}`,
            employee_id: employeeId,
            employee_name: employeeName,
            date: dateKey,
            check_in: '',
            check_out: '',
            manual_reason: '',
            manual_entry: false,
            timing_status: '',
            status: weekend ? 'holiday' : 'absent',
          }
        })
        .sort((a, b) => String(b?.date || '').localeCompare(String(a?.date || '')))

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

  function exportEmployeeAttendanceExcel() {
    const rows = Array.isArray(employeeAttendanceModal.rows) ? employeeAttendanceModal.rows : []
    if (!rows.length) {
      setError('No attendance records to export for selected range')
      return
    }

    const fromDate = String(employeeAttendanceModal.fromDate || '').trim() || dateKeyOffsetFromToday(-29)
    const toDate = String(employeeAttendanceModal.toDate || '').trim() || formatDateInput()
    const employeeName = String(employeeAttendanceModal.employeeName || 'employee')
    const safeEmployeeName = employeeName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'employee'

    const tableRows = rows.map((a) => {
      const statusKey = attendanceStatusKey(a, a.date)
      const timing = statusKey === 'holiday' ? '-' : String(resolveTimingStatus(a) || '-')
      const worked = statusKey === 'holiday' ? '-' : formatWorkedHoursFromAttendanceRow(a)
      const mode = statusKey === 'holiday' ? '-' : (a.manual_entry ? 'MANUAL' : 'AUTO')
      return `
        <tr>
          <td>${escapeHtml(a.date || '-')}</td>
          <td>${escapeHtml(formatWeekdayFromDateKey(a.date))}</td>
          <td>${escapeHtml(a.check_in || '-')}</td>
          <td>${escapeHtml(a.check_out || '-')}</td>
          <td>${escapeHtml(worked)}</td>
          <td>${escapeHtml(timing)}</td>
          <td>${escapeHtml(attendanceStatusLabel(a, a.date))}</td>
          <td>${escapeHtml(mode)}</td>
          <td>${escapeHtml(a.manual_reason || '-')}</td>
        </tr>
      `
    }).join('')

    const workbookHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; }
    th { background: #f3f4f6; font-weight: 700; }
  </style>
</head>
<body>
  <h3>${escapeHtml(employeeName)} · Attendance (${escapeHtml(fromDate)} to ${escapeHtml(toDate)})</h3>
  <table>
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
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`

    const blob = new Blob([workbookHtml], { type: 'application/vnd.ms-excel;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${safeEmployeeName}_attendance_${fromDate}_to_${toDate}.xls`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    flash('Employee attendance Excel exported')
  }

  function printEmployeeAttendanceHistory() {
    const rows = Array.isArray(employeeAttendanceModal.rows) ? employeeAttendanceModal.rows : []
    if (!rows.length) {
      setError('No attendance records to print for selected range')
      return
    }

    const fromDate = String(employeeAttendanceModal.fromDate || '').trim() || dateKeyOffsetFromToday(-29)
    const toDate = String(employeeAttendanceModal.toDate || '').trim() || formatDateInput()
    const employeeName = String(employeeAttendanceModal.employeeName || 'Employee')
    const generatedAt = new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date())

    const summary = rows.reduce((acc, row) => {
      const statusKey = attendanceStatusKey(row, row?.date)
      acc.totalDays += 1
      if (statusKey === 'holiday') acc.holidays += 1
      else if (statusKey === 'leave_marked') acc.leaves += 1
      else if (statusKey === 'absent') acc.absent += 1
      else if (statusKey === 'checked_in' || statusKey === 'checked_out') acc.working += 1
      return acc
    }, {
      totalDays: 0,
      working: 0,
      leaves: 0,
      holidays: 0,
      absent: 0,
    })

    const tableRowsHtml = rows.map((a) => {
      const statusKey = attendanceStatusKey(a, a.date)
      const timing = statusKey === 'holiday' ? '-' : String(resolveTimingStatus(a) || '-')
      const worked = statusKey === 'holiday' ? '-' : formatWorkedHoursFromAttendanceRow(a)
      const mode = statusKey === 'holiday' ? '-' : (a.manual_entry ? 'MANUAL' : 'AUTO')
      return `
        <tr>
          <td>${escapeHtml(a.date || '-')}</td>
          <td>${escapeHtml(formatWeekdayFromDateKey(a.date))}</td>
          <td>${escapeHtml(a.check_in || '-')}</td>
          <td>${escapeHtml(a.check_out || '-')}</td>
          <td>${escapeHtml(worked)}</td>
          <td>${escapeHtml(timing)}</td>
          <td>${escapeHtml(attendanceStatusLabel(a, a.date))}</td>
          <td>${escapeHtml(mode)}</td>
          <td>${escapeHtml(a.manual_reason || '-')}</td>
        </tr>
      `
    }).join('')

    const reportHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(employeeName)} Attendance</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 20px; color: #0f172a; }
    .actions { display:flex; justify-content:flex-end; margin-bottom:10px; }
    button { padding:8px 12px; border:none; border-radius:8px; background:#2563eb; color:#fff; font-weight:600; cursor:pointer; }
    h1 { margin: 0; font-size: 20px; }
    .muted { color:#64748b; font-size:12px; margin:4px 0 12px; }
    .stats { display:grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap:8px; margin: 10px 0 12px; }
    .stat { border:1px solid #e2e8f0; border-radius:10px; padding:8px 10px; }
    .k { font-size:11px; color:#64748b; margin:0; }
    .v { font-size:20px; font-weight:700; margin:2px 0 0; }
    table { width:100%; border-collapse:collapse; }
    th, td { border:1px solid #e2e8f0; padding:7px; font-size:12px; text-align:left; }
    th { background:#f8fafc; }
    @media print { .actions { display:none; } body { margin: 0; } }
  </style>
</head>
<body>
  <div class="actions"><button onclick="window.print()">Print</button></div>
  <h1>${escapeHtml(employeeName)} · Attendance</h1>
  <p class="muted">Date range: ${escapeHtml(fromDate)} to ${escapeHtml(toDate)} · Generated on ${escapeHtml(generatedAt)}</p>
  <div class="stats">
    <div class="stat"><p class="k">Total Days</p><p class="v">${escapeHtml(summary.totalDays)}</p></div>
    <div class="stat"><p class="k">Working Days</p><p class="v">${escapeHtml(summary.working)}</p></div>
    <div class="stat"><p class="k">Leaves</p><p class="v">${escapeHtml(summary.leaves)}</p></div>
    <div class="stat"><p class="k">Holidays</p><p class="v">${escapeHtml(summary.holidays)}</p></div>
    <div class="stat"><p class="k">Absent Days</p><p class="v">${escapeHtml(summary.absent)}</p></div>
  </div>
  <table>
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
      const byRole = directoryRoleFilter === 'all' || String(e.role || 'staff').toLowerCase() === String(directoryRoleFilter).toLowerCase()
      const byStatus = directoryStatusFilter === 'all' || String(e.status || 'active').toLowerCase() === String(directoryStatusFilter).toLowerCase()
      const empId = String(e?.id || e?.employee_id || '').trim()
      const byMissing = !directoryMissingOnly || (empId && missingCheckinEmployeeIdSet.has(empId))
      if (!byDept) return false
      if (!byRole) return false
      if (!byStatus) return false
      if (!byMissing) return false
      if (!q) return true
      return [e.name, e.email, e.login_id, e.department, e.role, e.status].some((v) => String(v || '').toLowerCase().includes(q))
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
  }, [employees, directorySearch, directoryDeptFilter, directoryRoleFilter, directoryStatusFilter, directorySort, directoryMissingOnly, missingCheckinEmployeeIdSet])

  const DIRECTORY_PAGE_SIZE = 10

  const directoryTotalPages = useMemo(
    () => Math.max(1, Math.ceil((filteredEmployees.length || 0) / DIRECTORY_PAGE_SIZE)),
    [filteredEmployees.length],
  )

  const paginatedEmployees = useMemo(() => {
    const start = (directoryPage - 1) * DIRECTORY_PAGE_SIZE
    return filteredEmployees.slice(start, start + DIRECTORY_PAGE_SIZE)
  }, [filteredEmployees, directoryPage])

  const filteredAssetsHubEmployees = useMemo(() => {
    const query = String(assetsHubSearch || '').trim().toLowerCase()
    return (employees || [])
      .filter((employee) => {
        const byDept = assetsHubDeptFilter === 'all' || String(employee?.department || 'General') === String(assetsHubDeptFilter)
        if (!byDept) return false
        if (!query) return true
        return [employee?.name, employee?.login_id, employee?.email, employee?.department, employee?.role]
          .some((value) => String(value || '').toLowerCase().includes(query))
      })
      .slice()
      .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')))
  }, [employees, assetsHubSearch, assetsHubDeptFilter])

  function toggleDirectorySort(key) {
    setDirectorySort((old) => {
      if (old.key === key) {
        return { key, direction: old.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key, direction: 'asc' }
    })
  }

  function printEmployeeDirectoryPdf() {
    const rows = Array.isArray(filteredEmployees) ? filteredEmployees : []
    if (!rows.length) {
      setError('No employees to print for selected filters')
      return
    }

    const toEmployeeMeta = (employee = {}) => {
      const statusText = String(employee.status || '').toLowerCase()
      const isInactiveByStatus = statusText === 'inactive'
      const hasIsActiveFlag = typeof employee.is_active === 'boolean'
      const hasActiveFlag = typeof employee.active === 'boolean'
      const isActive = hasIsActiveFlag ? !!employee.is_active : (hasActiveFlag ? !!employee.active : !isInactiveByStatus)
      const mustChangePassword = !!employee.must_change_password
      return {
        isActive,
        statusLabel: isActive ? 'Active' : 'Inactive',
        passwordLabel: mustChangePassword ? 'Reset required' : 'Protected',
      }
    }

    const generatedAt = new Intl.DateTimeFormat('en-IN', {
      timeZone: APP_TIME_ZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date())

    const summary = rows.reduce((acc, employee) => {
      const meta = toEmployeeMeta(employee)
      acc.total += 1
      if (meta.isActive) acc.active += 1
      else acc.inactive += 1
      if (meta.passwordLabel === 'Reset required') acc.resetRequired += 1
      return acc
    }, { total: 0, active: 0, inactive: 0, resetRequired: 0 })

    const tableRowsHtml = rows.map((employee) => {
      const meta = toEmployeeMeta(employee)
      return `
        <tr>
          <td>${escapeHtml(employee.name || '-')}</td>
          <td>${escapeHtml(employee.login_id || '-')}</td>
          <td>${escapeHtml(employee.department || 'General')}</td>
          <td>${escapeHtml(meta.statusLabel)}</td>
          <td>${escapeHtml(meta.passwordLabel)}</td>
        </tr>
      `
    }).join('')

    const reportHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Employee Directory</title>
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
      <h1>Employee Directory</h1>
      <p class="muted">Generated on ${escapeHtml(generatedAt)}</p>
      <p class="muted">Department filter: ${escapeHtml(directoryDeptFilter === 'all' ? 'All' : directoryDeptFilter)} · Search: ${escapeHtml(directorySearch || '-')}</p>
    </div>
  </div>
  <div class="stats">
    <div class="stat"><p class="k">Total Employees</p><p class="v">${escapeHtml(summary.total)}</p></div>
    <div class="stat"><p class="k">Active</p><p class="v">${escapeHtml(summary.active)}</p></div>
    <div class="stat"><p class="k">Inactive</p><p class="v">${escapeHtml(summary.inactive)}</p></div>
    <div class="stat"><p class="k">Reset Required</p><p class="v">${escapeHtml(summary.resetRequired)}</p></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Name</th>
        <th>Login ID</th>
        <th>Department</th>
        <th>Status</th>
        <th>Password Status</th>
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
        attendanceStatusLabel(a, date),
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

  function openManualAttendanceModal(employee = null) {
    const selectedEmployee = employee || employees?.[0] || null
    setError('')
    setManualAttendanceModal({
      open: true,
      employeeId: String(selectedEmployee?.id || selectedEmployee?._id || ''),
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
        <td>${escapeHtml(attendanceStatusKey(a, reportDate) === 'holiday' ? '-' : (String(a.timing_status || '').trim() || '-'))}</td>
        <td>${escapeHtml(attendanceStatusLabel(a, reportDate))}</td>
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

  async function exportAttendanceRangeExcel() {
    try {
      const { fromDate, toDate, rows } = await buildAttendanceRowsForDateRange(logsFromDate, logsToDate, token)
      if (!rows.length) {
        setError('No attendance logs found for selected date range')
        return
      }

      const tableRows = rows.map((a) => {
        const statusKey = attendanceStatusKey(a, a.date)
        const timing = statusKey === 'holiday' ? '-' : (String(a.timing_status || '').trim() || '-')
        const mode = statusKey === 'holiday' ? '-' : (a.manual_entry ? 'MANUAL' : 'AUTO')
        const worked = statusKey === 'holiday' ? '-' : formatWorkedHoursFromAttendanceRow(a)
        return `
          <tr>
            <td>${escapeHtml(a.date || '')}</td>
            <td>${escapeHtml(a.weekday || formatWeekdayFromDateKey(a.date))}</td>
            <td>${escapeHtml(a.employee_name || '')}</td>
            <td>${escapeHtml(a.check_in || '-')}</td>
            <td>${escapeHtml(a.check_out || '-')}</td>
            <td>${escapeHtml(worked)}</td>
            <td>${escapeHtml(timing)}</td>
            <td>${escapeHtml(attendanceStatusLabel(a, a.date))}</td>
            <td>${escapeHtml(mode)}</td>
            <td>${escapeHtml(a.manual_reason || '-')}</td>
          </tr>
        `
      }).join('')

      const workbookHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    table { border-collapse: collapse; width: 100%; font-family: Arial, sans-serif; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; }
    th { background: #f3f4f6; font-weight: 700; }
  </style>
</head>
<body>
  <h3>Attendance Logs (${escapeHtml(fromDate)} to ${escapeHtml(toDate)})</h3>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Day</th>
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
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`

      const blob = new Blob([workbookHtml], { type: 'application/vnd.ms-excel;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `attendance_logs_${fromDate}_to_${toDate}.xls`
      document.body.appendChild(anchor)
      anchor.click()
      document.body.removeChild(anchor)
      URL.revokeObjectURL(url)
      flash('Attendance Excel exported')
    } catch (err) {
      setError(err.message || 'Unable to export attendance range')
    }
  }

  async function printAttendanceRangePdf() {
    try {
      const { fromDate, toDate, rows } = await buildAttendanceRowsForDateRange(logsFromDate, logsToDate, token)
      if (!rows.length) {
        setError('No attendance logs to print for selected date range')
        return
      }

      const generatedAt = new Intl.DateTimeFormat('en-IN', {
        timeZone: APP_TIME_ZONE,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date())

      const tableRowsHtml = rows.map((a) => {
        const statusKey = attendanceStatusKey(a, a.date)
        const timing = statusKey === 'holiday' ? '-' : (String(a.timing_status || '').trim() || '-')
        const worked = statusKey === 'holiday' ? '-' : formatWorkedHoursFromAttendanceRow(a)
        return `
          <tr>
            <td>${escapeHtml(a.date || '')}</td>
            <td>${escapeHtml(a.weekday || formatWeekdayFromDateKey(a.date))}</td>
            <td>${escapeHtml(a.employee_name || '')}</td>
            <td>${escapeHtml(a.check_in || '-')}</td>
            <td>${escapeHtml(a.check_out || '-')}</td>
            <td>${escapeHtml(worked)}</td>
            <td>${escapeHtml(timing)}</td>
            <td>${escapeHtml(attendanceStatusLabel(a, a.date))}</td>
            <td>${escapeHtml(statusKey === 'holiday' ? '-' : (a.manual_entry ? 'MANUAL' : 'AUTO'))}</td>
            <td>${escapeHtml(a.manual_reason || '-')}</td>
          </tr>
        `
      }).join('')

      const reportHtml = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Attendance Logs ${escapeHtml(fromDate)} to ${escapeHtml(toDate)}</title>
  <style>
    body { font-family: Inter, Arial, sans-serif; margin: 20px; color: #0f172a; }
    .actions { display:flex; justify-content:flex-end; margin-bottom:10px; }
    button { padding:8px 12px; border:none; border-radius:8px; background:#2563eb; color:#fff; font-weight:600; cursor:pointer; }
    h1 { margin:0; font-size:20px; }
    .muted { color:#64748b; font-size:12px; margin:4px 0 12px; }
    table { width:100%; border-collapse:collapse; }
    th, td { border:1px solid #e2e8f0; padding:7px; font-size:12px; text-align:left; }
    th { background:#f8fafc; }
    @media print { .actions { display:none; } body { margin: 0; } }
  </style>
</head>
<body>
  <div class="actions"><button onclick="window.print()">Print</button></div>
  <h1>Attendance Logs (${escapeHtml(fromDate)} to ${escapeHtml(toDate)})</h1>
  <p class="muted">Generated on ${escapeHtml(generatedAt)}</p>
  <table>
    <thead>
      <tr>
        <th>Date</th>
        <th>Day</th>
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

      const printWindow = window.open('about:blank', '_blank', 'width=1280,height=900')
      if (!printWindow) {
        setError('Unable to open print preview. Please allow pop-ups for this site.')
        return
      }
      printWindow.document.open()
      printWindow.document.write(reportHtml)
      printWindow.document.close()
      printWindow.focus()
    } catch (err) {
      setError(err.message || 'Unable to print attendance range')
    }
  }

  const visibleEmployeeIds = useMemo(() => paginatedEmployees.map((e) => e.id), [paginatedEmployees])
  const selectedVisibleCount = useMemo(
    () => visibleEmployeeIds.filter((id) => selectedEmployeeIds.includes(id)).length,
    [visibleEmployeeIds, selectedEmployeeIds],
  )
  const allVisibleSelected = visibleEmployeeIds.length > 0 && selectedVisibleCount === visibleEmployeeIds.length

  useEffect(() => {
    const visibleSet = new Set(visibleEmployeeIds)
    setSelectedEmployeeIds((old) => old.filter((id) => visibleSet.has(id)))
  }, [visibleEmployeeIds])

  useEffect(() => {
    setDirectoryPage(1)
  }, [directorySearch, directoryDeptFilter, directoryRoleFilter, directoryStatusFilter])

  useEffect(() => {
    setDirectoryPage((old) => Math.min(old, directoryTotalPages))
  }, [directoryTotalPages])

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
          await Promise.all(ids.map(async (id) => {
            try {
              await apiFetch(`/api/employees/${id}`, { method: 'DELETE' }, token)
            } catch (apiErr) {
              const code = Number(apiErr?.status || 0)
              if (code !== 404 && code !== 405) throw apiErr
              await apiFetch(`/employees/${id}`, { method: 'DELETE' }, token)
            }
          }))
          setSelectedEmployeeIds([])
          flash(`${ids.length} employee(s) deleted`)
          await loadAll()
        } catch (err) {
          setError(err.message)
        }
      },
    })
  }

  const ATTENDANCE_PAGE_SIZE = 10

  const attendanceEmployeeLookup = useMemo(() => {
    const byName = new Map()
    const byId = new Map()
    for (const employee of (employees || [])) {
      const nameKey = String(employee?.name || '').trim().toLowerCase()
      const loginKey = String(employee?.login_id || '').trim().toLowerCase()
      const idKey = String(employee?.id || '').trim().toLowerCase()
      if (nameKey) byName.set(nameKey, employee)
      if (loginKey) byId.set(loginKey, employee)
      if (idKey) byId.set(idKey, employee)
    }
    return { byName, byId }
  }, [employees])

  function parseAttendanceTimeToMinutes(value) {
    const str = String(value || '').trim()
    const m = str.match(/(\d{1,2}):(\d{2})/)
    if (!m) return null
    const h = Number(m[1])
    const mm = Number(m[2])
    if (!Number.isFinite(h) || !Number.isFinite(mm)) return null
    return (h * 60) + mm
  }

  function calculateWorkedMinutes(row) {
    const inMinutes = parseAttendanceTimeToMinutes(row?.check_in)
    const outMinutes = parseAttendanceTimeToMinutes(row?.check_out)
    if (inMinutes == null || outMinutes == null) return 0
    let diff = outMinutes - inMinutes
    if (diff < 0) diff += (24 * 60)
    return diff
  }

  function inferShiftLabel(row) {
    const start = parseAttendanceTimeToMinutes(row?.check_in)
    if (start == null) return 'General'
    if (start < 12 * 60) return 'Morning'
    if (start < 17 * 60) return 'Day'
    return 'Evening'
  }

  function attendanceDateKey(row) {
    return String(row?.date || row?.clock_date || '').trim()
  }

  function expectedShiftWindow(row) {
    const shiftLabel = String(row?.shift_label || inferShiftLabel(row) || 'General').toLowerCase()
    if (shiftLabel.includes('morning')) {
      return { start: 9 * 60, end: 17 * 60, label: '09:00 - 17:00' }
    }
    if (shiftLabel.includes('evening')) {
      return { start: 13 * 60, end: 21 * 60, label: '13:00 - 21:00' }
    }
    return { start: 9 * 60 + 30, end: 18 * 60, label: '09:30 - 18:00' }
  }

  function formatDurationLabel(minutes) {
    const safe = Math.max(0, Number(minutes || 0))
    if (!safe) return '-'
    const hours = Math.floor(safe / 60)
    const mins = safe % 60
    if (!hours) return `${mins}m`
    return `${hours}h ${String(mins).padStart(2, '0')}m`
  }

  function formatPercent(value) {
    const safe = Number(value || 0)
    if (!Number.isFinite(safe)) return '0%'
    return `${Math.max(0, Math.min(100, Math.round(safe)))}%`
  }

  function exceptionSignals(row) {
    const inMinutes = parseAttendanceTimeToMinutes(row?.check_in)
    const outMinutes = parseAttendanceTimeToMinutes(row?.check_out)
    const shift = expectedShiftWindow(row)
    const timingText = String(resolveTimingStatus(row) || '').toLowerCase()

    const isLate = timingText.includes('late') || (inMinutes != null && inMinutes > shift.start)
    const isEarlyExit = timingText.includes('left early') || (outMinutes != null && outMinutes < shift.end)
    const delayMinutes = isLate && inMinutes != null ? Math.max(0, inMinutes - shift.start) : 0
    const earlyExitMinutes = isEarlyExit && outMinutes != null ? Math.max(0, shift.end - outMinutes) : 0

    let type = 'late'
    if (isLate && isEarlyExit) type = 'both'
    else if (isEarlyExit) type = 'early_exit'

    return {
      isLate,
      isEarlyExit,
      delayMinutes,
      earlyExitMinutes,
      type,
      expectedShiftLabel: shift.label,
    }
  }

  function exceptionTypeLabel(type) {
    if (type === 'both') return 'Both'
    if (type === 'early_exit') return 'Early Exit'
    return 'Late'
  }

  function exceptionStatusMeta(countLast7) {
    if (countLast7 >= 5) return { key: 'critical', label: 'Critical' }
    if (countLast7 >= 3) return { key: 'warning', label: 'Warning' }
    return { key: 'normal', label: 'Normal' }
  }

  /** Operational workflow badge for exceptions table (UI-only; resolved keys are local session state). */
  function exceptionWorkflowStatus(item) {
    const key = String(item?.key || '')
    if (exceptionResolvedKeys.includes(key) || exceptionHalfDayKeys.includes(key)) {
      return { key: 'resolved', label: 'Resolved' }
    }
    if (Number(item?.warningCount || 0) > 0) {
      return { key: 'warning_issued', label: 'Warning issued' }
    }
    if (String(exceptionNotesByKey[key] || '').trim()) {
      return { key: 'under_review', label: 'Under review' }
    }
    return { key: 'open', label: 'Open' }
  }

  function exceptionRowKey(row) {
    return [row?.id, row?.employee_name, row?.date, row?.clock_date, row?.check_in, row?.check_out].map((x) => String(x || '')).join('|')
  }

  function attendanceRowKey(row, idx = 0) {
    const parts = [row?.id, row?.employee_name, row?.check_in, row?.check_out, row?.date, idx]
    return parts.map((x) => String(x || '')).join('|')
  }

  function getAttendanceEmployeeMeta(row) {
    const byName = attendanceEmployeeLookup.byName
    const byId = attendanceEmployeeLookup.byId
    const nameKey = String(row?.employee_name || '').trim().toLowerCase()
    const idKey = String(row?.employee_id || row?.login_id || row?.employee_login_id || '').trim().toLowerCase()
    const employee = byName.get(nameKey) || byId.get(idKey) || null
    const employeeObjectId = String(employee?.id || row?.employee_id || '').trim()
    return {
      employeeId: String(employee?.login_id || row?.login_id || row?.employee_id || row?.employee_login_id || row?.id || '-'),
      employeeObjectId,
      department: String(employee?.department || row?.department || 'General'),
      employee,
    }
  }

  function attendanceRowIsWfh(row) {
    const wm = String(row?.work_mode || row?.attendance_mode || row?.location_type || '').trim().toLowerCase()
    if (wm === 'wfh' || wm.includes('work_from_home') || wm.includes('work from home')) return true
    const st = String(row?.status || '').trim().toLowerCase()
    if (st.includes('wfh') || st.includes('work_from_home')) return true
    const reason = String(row?.manual_reason || '').trim().toLowerCase()
    return reason.includes('wfh') || reason.includes('work from home')
  }

  function attendanceUiStatusKey(row) {
    const base = attendanceStatusKey(row, date)
    if (base === 'absent') return 'absent'
    if (base === 'holiday') return 'holiday'
    if (base === 'leave_marked') return 'leave'
    const timing = String(resolveTimingStatus(row) || '').toLowerCase()
    if (timing.includes('late')) return 'late'
    const workedMinutes = calculateWorkedMinutes(row)
    if (workedMinutes > 0 && workedMinutes < 4 * 60) return 'half_day'
    return 'present'
  }

  function rowMatchesLogsStatusFilter(row) {
    if (logsStatusFilter === 'all') return true
    if (logsStatusFilter === 'wfh') return attendanceRowIsWfh(row)
    if (logsStatusFilter === 'holiday') return attendanceUiStatusKey(row) === 'holiday'
    if (logsStatusFilter === 'present') {
      return attendanceUiStatusKey(row) === 'present' && !attendanceRowIsWfh(row)
    }
    return attendanceUiStatusKey(row) === logsStatusFilter
  }

  function formatLateByForRow(row) {
    const sig = exceptionSignals(row)
    if (!sig.isLate || !sig.delayMinutes) return '—'
    return formatDurationLabel(sig.delayMinutes)
  }

  function formatOvertimeForRow(row) {
    const ot = Math.max(0, calculateWorkedMinutes(row) - 480)
    if (ot <= 0) return '—'
    return formatDurationLabel(ot)
  }

  function attendanceUiStatusLabel(row) {
    const key = attendanceUiStatusKey(row)
    if (key === 'half_day') return 'HALF DAY'
    if (key === 'leave') return 'LEAVE'
    if (key === 'holiday') return 'HOLIDAY'
    return key.toUpperCase().replace(/_/g, ' ')
  }

  const attendanceRequestLookup = useMemo(() => {
    const map = new Map()
    for (const req of (manualRequests || [])) {
      if (String(req?.status || '').toLowerCase() !== 'pending') continue
      const key = `${String(req?.employee_name || '').trim().toLowerCase()}|${String(req?.date || '').trim()}`
      map.set(key, req)
    }
    return map
  }, [manualRequests])

  const logsDepartmentOptions = useMemo(() => {
    const set = new Set()
    for (const row of (attendance || [])) {
      const dept = getAttendanceEmployeeMeta(row).department
      if (dept) set.add(dept)
    }
    return ['all', ...Array.from(set).sort((a, b) => a.localeCompare(b))]
  }, [attendance, attendanceEmployeeLookup])

  const logsShiftOptions = useMemo(() => {
    const set = new Set(['Morning', 'Day', 'Evening'])
    for (const row of (attendance || [])) set.add(inferShiftLabel(row))
    return Array.from(set)
  }, [attendance])

  const logsDeptOptions = useMemo(
    () => logsDepartmentOptions.filter((dept) => String(dept || '').toLowerCase() !== 'all'),
    [logsDepartmentOptions],
  )

  const exceptionCountByEmployeeLast7 = useMemo(() => {
    const map = new Map()
    const startKey = dateKeyOffsetFromToday(-6)
    const endKey = formatDateInput()
    for (const row of (attendance || [])) {
      const rowDate = attendanceDateKey(row)
      if (!rowDate || rowDate < startKey || rowDate > endKey) continue
      const signal = exceptionSignals(row)
      if (!signal.isLate && !signal.isEarlyExit) continue
      const employee = String(row?.employee_name || '').trim().toLowerCase()
      if (!employee) continue
      map.set(employee, Number(map.get(employee) || 0) + 1)
    }
    return map
  }, [attendance])

  const exceptionStreakByEmployee = useMemo(() => {
    const grouped = new Map()
    for (const row of (attendance || [])) {
      const signal = exceptionSignals(row)
      if (!signal.isLate && !signal.isEarlyExit) continue
      const dateKey = attendanceDateKey(row)
      if (!dateKey) continue
      const employeeKey = String(row?.employee_name || '').trim().toLowerCase()
      if (!employeeKey) continue
      const set = grouped.get(employeeKey) || new Set()
      set.add(dateKey)
      grouped.set(employeeKey, set)
    }

    const result = new Map()
    for (const [employeeKey, dateSet] of grouped.entries()) {
      const sortedDesc = Array.from(dateSet).sort((a, b) => String(b).localeCompare(String(a)))
      let streak = 0
      let prev = ''
      for (const current of sortedDesc) {
        if (!streak) {
          streak = 1
          prev = current
          continue
        }
        const expectedPrev = dateKeyShift(current, 1)
        if (expectedPrev === prev) {
          streak += 1
          prev = current
        } else {
          break
        }
      }
      result.set(employeeKey, streak)
    }
    return result
  }, [attendance])

  const allExceptionRows = useMemo(() => {
    return (attendance || []).map((row) => {
      const signal = exceptionSignals(row)
      if (!signal.isLate && !signal.isEarlyExit) return null
      const key = exceptionRowKey(row)
      const meta = getAttendanceEmployeeMeta(row)
      const employeeId = String(meta.employeeObjectId || meta.employeeId || '').trim()
      const warningCount = Number(warningCountsByEmployee[employeeId] || 0)
      const employeeKey = String(row?.employee_name || '').trim().toLowerCase()
      const countLast7 = Number(exceptionCountByEmployeeLast7.get(employeeKey) || 0)
      const status = exceptionStatusMeta(countLast7)
      const duration = signal.type === 'both'
        ? `Late ${formatDurationLabel(signal.delayMinutes)} · Early ${formatDurationLabel(signal.earlyExitMinutes)}`
        : signal.type === 'early_exit'
          ? formatDurationLabel(signal.earlyExitMinutes)
          : formatDurationLabel(signal.delayMinutes)
      const severityMinutes = Number(signal.delayMinutes || 0) + Number(signal.earlyExitMinutes || 0)
      const streakDays = Number(exceptionStreakByEmployee.get(employeeKey) || 0)

      return {
        key,
        row,
        employeeId,
        employeeName: String(row?.employee_name || 'Unknown'),
        department: meta.department,
        expectedShiftTime: signal.expectedShiftLabel,
        checkIn: String(row?.check_in || '-'),
        checkOut: String(row?.check_out || '-'),
        duration,
        exceptionType: signal.type,
        countLast7,
        statusKey: status.key,
        statusLabel: status.label,
        warningCount,
        repeatOffender: countLast7 >= 5,
        rowDate: attendanceDateKey(row),
        severityMinutes,
        streakDays,
      }
    }).filter(Boolean)
  }, [attendance, attendanceEmployeeLookup, exceptionCountByEmployeeLast7, exceptionStreakByEmployee, warningCountsByEmployee])

  const filteredExceptionRows = useMemo(() => {
    const q = String(logsSearch || '').trim().toLowerCase()
    return allExceptionRows
      .filter((item) => {
        const byDept = logsDeptFilter === 'all' || String(item.department || '').toLowerCase() === String(logsDeptFilter || '').toLowerCase()
        if (!byDept) return false

        if (exceptionTypeFilter === 'late' && !(item.exceptionType === 'late' || item.exceptionType === 'both')) return false
        if (exceptionTypeFilter === 'early_exit' && !(item.exceptionType === 'early_exit' || item.exceptionType === 'both')) return false

        if (!q) return true
        return [
          item.employeeName,
          item.department,
          item.expectedShiftTime,
          item.checkIn,
          item.checkOut,
          item.duration,
          exceptionTypeLabel(item.exceptionType),
          item.statusLabel,
          exceptionNotesByKey[item.key],
        ].some((v) => String(v || '').toLowerCase().includes(q))
      })
      .sort((a, b) => {
        if (a.severityMinutes !== b.severityMinutes) return b.severityMinutes - a.severityMinutes
        if (a.countLast7 !== b.countLast7) return b.countLast7 - a.countLast7
        if (a.rowDate !== b.rowDate) return String(b.rowDate || '').localeCompare(String(a.rowDate || ''))
        return String(a.employeeName || '').localeCompare(String(b.employeeName || ''))
      })
  }, [allExceptionRows, logsSearch, logsDeptFilter, exceptionTypeFilter, exceptionNotesByKey])

  const exceptionTotalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredExceptionRows.length / ATTENDANCE_PAGE_SIZE)),
    [filteredExceptionRows.length],
  )

  const pagedExceptionRows = useMemo(() => {
    const start = (logsPage - 1) * ATTENDANCE_PAGE_SIZE
    return filteredExceptionRows.slice(start, start + ATTENDANCE_PAGE_SIZE)
  }, [filteredExceptionRows, logsPage])

  const visibleExceptionKeys = useMemo(() => pagedExceptionRows.map((item) => item.key), [pagedExceptionRows])
  const allVisibleExceptionSelected = visibleExceptionKeys.length > 0 && visibleExceptionKeys.every((key) => selectedExceptionKeys.includes(key))
  const hasSelectedExceptions = selectedExceptionKeys.length > 0

  const exceptionsSummary = useMemo(() => {
    const todayKey = formatDateInput()
    const lateToday = allExceptionRows.filter((item) => item.rowDate === todayKey && (item.exceptionType === 'late' || item.exceptionType === 'both')).length
    const earlyExitsToday = allExceptionRows.filter((item) => item.rowDate === todayKey && (item.exceptionType === 'early_exit' || item.exceptionType === 'both')).length
    const repeatOffenders = new Set(allExceptionRows.filter((item) => item.repeatOffender).map((item) => item.employeeName.toLowerCase())).size
    return { lateToday, earlyExitsToday, repeatOffenders }
  }, [allExceptionRows])

  const frequentOffenderAlerts = useMemo(() => {
    const grouped = new Map()
    for (const row of filteredExceptionRows) {
      if (!row.repeatOffender) continue
      const key = String(row.employeeName || '').toLowerCase()
      if (!grouped.has(key)) grouped.set(key, row)
    }
    return Array.from(grouped.values()).slice(0, 5)
  }, [filteredExceptionRows])

  const filteredAttendance = useMemo(() => {
    const q = logsSearch.trim().toLowerCase()
    const filtered = (attendance || []).filter((a) => {
      const meta = getAttendanceEmployeeMeta(a)
      const shiftLabel = inferShiftLabel(a)
      const byStatus = rowMatchesLogsStatusFilter(a)
      const byDept = logsDeptFilter === 'all' || String(meta.department || '').toLowerCase() === String(logsDeptFilter || '').toLowerCase()
      const byShift = logsShiftFilter === 'all' || String(shiftLabel || '').toLowerCase() === String(logsShiftFilter || '').toLowerCase()
      if (!byStatus || !byDept || !byShift) return false
      if (!q) return true
      return [
        a.employee_name,
        attendanceUiStatusLabel(a),
        a.check_in,
        a.check_out,
        a.timing_status,
        a.manual_reason,
        meta.department,
        meta.employeeId,
      ].some((v) => String(v || '').toLowerCase().includes(q))
    })

    if (!logsSort?.key) return filtered

    const sorted = [...filtered].sort((a, b) => {
      let av
      let bv
      if (logsSort.key === 'employee_name') {
        av = String(a.employee_name || '').toLowerCase()
        bv = String(b.employee_name || '').toLowerCase()
      } else if (logsSort.key === 'check_in' || logsSort.key === 'check_out') {
        av = parseAttendanceTimeToMinutes(a[logsSort.key]) ?? Number.POSITIVE_INFINITY
        bv = parseAttendanceTimeToMinutes(b[logsSort.key]) ?? Number.POSITIVE_INFINITY
      } else if (logsSort.key === 'worked_minutes') {
        av = calculateWorkedMinutes(a)
        bv = calculateWorkedMinutes(b)
      } else if (logsSort.key === 'status') {
        av = String(attendanceUiStatusLabel(a) || '').toLowerCase()
        bv = String(attendanceUiStatusLabel(b) || '').toLowerCase()
      } else {
        av = String(a?.[logsSort.key] || '').toLowerCase()
        bv = String(b?.[logsSort.key] || '').toLowerCase()
      }

      if (av < bv) return logsSort.direction === 'asc' ? -1 : 1
      if (av > bv) return logsSort.direction === 'asc' ? 1 : -1
      return 0
    })

    return sorted
  }, [attendance, logsSearch, logsStatusFilter, logsSort, logsDeptFilter, logsShiftFilter, date, attendanceEmployeeLookup])

  const logsTotalPages = Math.max(1, Math.ceil(filteredAttendance.length / ATTENDANCE_PAGE_SIZE))
  const pagedAttendance = useMemo(() => {
    const start = (logsPage - 1) * ATTENDANCE_PAGE_SIZE
    return filteredAttendance
      .slice(start, start + ATTENDANCE_PAGE_SIZE)
      .map((row, offset) => ({ row, absoluteIndex: start + offset }))
  }, [filteredAttendance, logsPage])

  useEffect(() => {
    setLogsPage(1)
  }, [logsSearch, logsStatusFilter, logsDeptFilter, logsShiftFilter, exceptionTypeFilter, date])

  useEffect(() => {
    setLogsPage((old) => Math.min(old, logsTotalPages))
  }, [logsTotalPages])

  useEffect(() => {
    setLogsPage((old) => Math.min(old, exceptionTotalPages))
  }, [exceptionTotalPages])

  const visibleAttendanceIds = useMemo(
    () => pagedAttendance.map(({ row, absoluteIndex }) => attendanceRowKey(row, absoluteIndex)),
    [pagedAttendance],
  )

  const allVisibleAttendanceSelected = visibleAttendanceIds.length > 0
    && visibleAttendanceIds.every((id) => selectedAttendanceIds.includes(id))

  useEffect(() => {
    const allowed = new Set(filteredAttendance.map((row, idx) => attendanceRowKey(row, idx)))
    setSelectedAttendanceIds((old) => old.filter((id) => allowed.has(id)))
    setLogsExpandedRows((old) => old.filter((id) => allowed.has(id)))
  }, [filteredAttendance])

  useEffect(() => {
    const allowed = new Set(filteredExceptionRows.map((item) => item.key))
    setSelectedExceptionKeys((old) => old.filter((key) => allowed.has(key)))
  }, [filteredExceptionRows])

  function toggleAttendanceSelection(id) {
    setSelectedAttendanceIds((old) => (old.includes(id) ? old.filter((v) => v !== id) : [...old, id]))
  }

  function toggleSelectAllVisibleAttendance() {
    setSelectedAttendanceIds((old) => {
      if (allVisibleAttendanceSelected) return old.filter((id) => !visibleAttendanceIds.includes(id))
      const set = new Set(old)
      visibleAttendanceIds.forEach((id) => set.add(id))
      return Array.from(set)
    })
  }

  const selectedAttendanceRows = useMemo(() => {
    const wanted = new Set(selectedAttendanceIds)
    return filteredAttendance.filter((row, idx) => wanted.has(attendanceRowKey(row, idx)))
  }, [filteredAttendance, selectedAttendanceIds])

  const sortedFilteredAttendance = filteredAttendance
  const paginatedAttendance = pagedAttendance.map((item) => item.row)
  const hasSelectedAttendance = selectedAttendanceIds.length > 0

  const requestPendingByAttendanceKey = useMemo(() => {
    const map = {}
    for (const [idx, row] of filteredAttendance.entries()) {
      const requestKey = `${String(row?.employee_name || '').trim().toLowerCase()}|${String(row?.date || date || '').trim()}`
      const req = attendanceRequestLookup.get(requestKey)
      if (req) {
        map[attendanceRowKey(row, idx)] = req
      }
    }
    return map
  }, [filteredAttendance, attendanceRequestLookup, date])

  function parseWorkedMinutes(row) {
    return calculateWorkedMinutes(row)
  }

  function toggleSelectAttendanceRow(id, checked) {
    setSelectedAttendanceIds((old) => {
      const has = old.includes(id)
      if (checked && !has) return [...old, id]
      if (!checked && has) return old.filter((v) => v !== id)
      return old
    })
  }

  function toggleSelectAllAttendanceRows(checked) {
    setSelectedAttendanceIds((old) => {
      if (!checked) return old.filter((id) => !visibleAttendanceIds.includes(id))
      const set = new Set(old)
      visibleAttendanceIds.forEach((id) => set.add(id))
      return Array.from(set)
    })
  }

  function toggleSelectExceptionRow(key, checked) {
    setSelectedExceptionKeys((old) => {
      const has = old.includes(key)
      if (checked && !has) return [...old, key]
      if (!checked && has) return old.filter((v) => v !== key)
      return old
    })
  }

  function toggleSelectAllVisibleExceptions(checked) {
    setSelectedExceptionKeys((old) => {
      if (!checked) return old.filter((key) => !visibleExceptionKeys.includes(key))
      const set = new Set(old)
      visibleExceptionKeys.forEach((key) => set.add(key))
      return Array.from(set)
    })
  }

  function bulkMarkSelectedAttendance() {
    bulkMarkAttendance()
  }

  function bulkApproveSelectedAttendanceRequests() {
    bulkApproveAttendanceRequests()
  }

  function openEditAttendanceFromRecord(row) {
    openAttendanceEditModal(row)
  }

  function openAttendanceDetailModal(row) {
    const requestKey = `${String(row?.employee_name || '').trim().toLowerCase()}|${String(row?.date || date || '').trim()}`
    const request = attendanceRequestLookup.get(requestKey)
    setAttendanceDetailModal({ open: true, row, requestId: String(request?.id || '') })
  }

  function mapWarningCounts(payload) {
    const list = Array.isArray(payload?.items) ? payload.items : []
    const next = {}
    list.forEach((row) => {
      const id = String(row?.employee_id || '').trim()
      if (!id) return
      next[id] = Number(row?.count || 0)
    })
    return next
  }

  function warningCreatedAtLabel(value) {
    const ms = parseBackendDateMs(value)
    if (!Number.isFinite(ms)) return '-'
    try {
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: APP_TIME_ZONE,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(ms))
    } catch {
      return String(value || '').replace('T', ' ').slice(0, 16)
    }
  }

  async function handleWarnEmployee(employeeId, reason = 'Late attendance', item = null, showSuccessToast = true) {
    const id = String(employeeId || '').trim()
    const key = String(item?.key || id || '').trim()
    if (!id || !token) {
      setError('Failed to send')
      return false
    }

    setWarningSendingByKey((old) => ({ ...old, [key]: true }))
    try {
      await apiFetch('/api/warn-employee', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          employeeId: id,
          reason: String(reason || 'Late attendance').trim() || 'Late attendance',
        }),
      }, token)
      setWarningCountsByEmployee((old) => ({ ...old, [id]: Number(old[id] || 0) + 1 }))
      if (showSuccessToast) flash('Warning email sent')
      return true
    } catch (err) {
      setError(err?.message || 'Failed to send')
      flash('Failed to send')
      return false
    } finally {
      setWarningSendingByKey((old) => {
        const next = { ...old }
        delete next[key]
        return next
      })
    }
  }

  async function openWarningHistory(item) {
    const employeeId = String(item?.employeeId || '').trim()
    if (!employeeId || !token) return
    setWarningHistoryModal({
      open: true,
      employeeId,
      employeeName: String(item?.employeeName || 'Employee'),
      loading: true,
      error: '',
      rows: [],
    })
    try {
      const payload = await apiFetch(`/api/warn-employee/history?employeeId=${encodeURIComponent(employeeId)}&limit=25`, {}, token)
      setWarningHistoryModal((old) => ({ ...old, loading: false, rows: Array.isArray(payload?.items) ? payload.items : [] }))
    } catch (err) {
      setWarningHistoryModal((old) => ({ ...old, loading: false, error: err?.message || 'Failed to load warning history' }))
    }
  }

  function warnEmployeeForException(item) {
    const employeeId = String(item?.employeeId || '').trim()
    if (!employeeId) {
      setError('Unable to resolve employee for warning')
      return
    }
    const reason = item?.exceptionType === 'early_exit' ? 'Early exit attendance' : 'Late attendance'
    setConfirmModal({
      open: true,
      title: 'Warn Employee',
      message: `Send warning to ${item?.employeeName || 'employee'} for repeated attendance exceptions?`,
      confirmText: 'Warn',
      onConfirm: async () => {
        await handleWarnEmployee(employeeId, reason, item)
      },
    })
  }

  function openExceptionNoteModal(item) {
    if (!item?.key) return
    setExceptionNoteModal({
      open: true,
      key: item.key,
      row: item,
      note: String(exceptionNotesByKey[item.key] || ''),
    })
  }

  function saveExceptionNote() {
    const key = String(exceptionNoteModal?.key || '')
    if (!key) return
    setExceptionNotesByKey((old) => ({ ...old, [key]: String(exceptionNoteModal.note || '').trim() }))
    setExceptionNoteModal({ open: false, key: '', row: null, note: '' })
    flash('Exception note updated')
  }

  function markExceptionHalfDay(item) {
    const key = String(item?.key || '')
    if (!key) return
    setConfirmModal({
      open: true,
      title: 'Mark Half Day',
      message: `Mark ${item?.employeeName || 'employee'} as half day for this attendance exception?`,
      confirmText: 'Mark Half Day',
      onConfirm: async () => {
        setExceptionHalfDayKeys((old) => (old.includes(key) ? old : [...old, key]))
        flash(`Half day marked for ${item?.employeeName || 'employee'}`)
      },
    })
  }

  function markExceptionResolved(item) {
    const key = String(item?.key || '')
    if (!key) return
    setConfirmModal({
      open: true,
      title: 'Mark resolved',
      message: `Close this attendance exception as resolved for ${item?.employeeName || 'employee'}?`,
      confirmText: 'Mark resolved',
      onConfirm: () => {
        setExceptionResolvedKeys((old) => (old.includes(key) ? old : [...old, key]))
        flash('Exception marked resolved')
      },
    })
  }


  function bulkWarnExceptions() {
    const targets = filteredExceptionRows.filter((item) => selectedExceptionKeys.includes(item.key))
    if (!targets.length) return
    setConfirmModal({
      open: true,
      title: 'Bulk Warn Employees',
      message: `Send warning to ${targets.length} selected employee record(s)?`,
      confirmText: 'Bulk Warn',
      onConfirm: async () => {
        setBulkWarningSending(true)
        try {
          const jobs = targets.map((item) => handleWarnEmployee(item.employeeId, 'Late attendance', item, false))
          const results = await Promise.all(jobs)
          const okCount = results.filter(Boolean).length
          if (okCount > 0) flash(`${okCount} warning email(s) sent`)
        } finally {
          setBulkWarningSending(false)
        }
      },
    })
  }

  function bulkMarkHalfDayExceptions() {
    const keys = filteredExceptionRows
      .filter((item) => selectedExceptionKeys.includes(item.key))
      .map((item) => item.key)
      .filter((key) => !exceptionHalfDayKeys.includes(key))
    if (!keys.length) return
    setConfirmModal({
      open: true,
      title: 'Bulk Mark Half Day',
      message: `Mark ${keys.length} selected exception record(s) as half day?`,
      confirmText: 'Mark Half Day',
      onConfirm: async () => {
        setExceptionHalfDayKeys((old) => Array.from(new Set([...old, ...keys])))
        flash(`${keys.length} row(s) marked as half day`)
      },
    })
  }

  function exportExceptionsCsv() {
    const rows = Array.isArray(filteredExceptionRows) ? filteredExceptionRows : []
    if (!rows.length) {
      setError('No exception rows to export for selected filters')
      return
    }
    const escapeCsv = (value) => {
      const text = String(value ?? '')
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
    }
    const headers = ['Employee', 'Department', 'Expected Shift', 'Check In', 'Check Out', 'Delay/Early Exit', 'Exception Type', 'Count Last 7 Days', 'Status', 'Streak Days', 'Note']
    const lines = [
      headers.join(','),
      ...rows.map((item) => [
        item.employeeName,
        item.department,
        item.expectedShiftTime,
        item.checkIn,
        item.checkOut,
        item.duration,
        exceptionTypeLabel(item.exceptionType),
        item.countLast7,
        item.statusLabel,
        item.streakDays,
        exceptionNotesByKey[item.key] || '',
      ].map(escapeCsv).join(',')),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `attendance_exceptions_${formatDateInput()}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    flash('Exceptions CSV exported')
  }

  function exportExceptionsExcel() {
    const rows = Array.isArray(filteredExceptionRows) ? filteredExceptionRows : []
    if (!rows.length) {
      setError('No exception rows to export for selected filters')
      return
    }
    const html = `<!doctype html><html><head><meta charset="utf-8" /></head><body><table border="1"><thead><tr><th>Employee</th><th>Department</th><th>Expected Shift</th><th>Check In</th><th>Check Out</th><th>Delay/Early Exit</th><th>Exception Type</th><th>Count Last 7 Days</th><th>Status</th><th>Streak Days</th><th>Note</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${escapeHtml(item.employeeName)}</td><td>${escapeHtml(item.department)}</td><td>${escapeHtml(item.expectedShiftTime)}</td><td>${escapeHtml(item.checkIn)}</td><td>${escapeHtml(item.checkOut)}</td><td>${escapeHtml(item.duration)}</td><td>${escapeHtml(exceptionTypeLabel(item.exceptionType))}</td><td>${escapeHtml(item.countLast7)}</td><td>${escapeHtml(item.statusLabel)}</td><td>${escapeHtml(item.streakDays)}</td><td>${escapeHtml(exceptionNotesByKey[item.key] || '')}</td></tr>`).join('')}</tbody></table></body></html>`
    const blob = new Blob([html], { type: 'application/vnd.ms-excel;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `attendance_exceptions_${formatDateInput()}.xls`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    flash('Exceptions Excel exported')
  }

  async function handleExceptionsExport(kind) {
    try {
      setExceptionsExporting(kind)
      if (kind === 'csv') exportExceptionsCsv()
      else exportExceptionsExcel()
    } finally {
      setTimeout(() => setExceptionsExporting(''), 500)
    }
  }

  function openAttendanceEditModal(row) {
    const employee = getAttendanceEmployeeMeta(row)
    setManualAttendanceModal((old) => ({
      ...old,
      open: true,
      employeeId: String(employee.employee?.id || ''),
      date: String(row?.date || date || formatDateInput()),
      checkIn: String(row?.check_in || ''),
      checkOut: String(row?.check_out || ''),
      reason: String(row?.manual_reason || ''),
      saving: false,
    }))
  }

  async function bulkApproveAttendanceRequests() {
    const selected = selectedAttendanceRows
      .map((row) => {
        const key = `${String(row?.employee_name || '').trim().toLowerCase()}|${String(row?.date || date || '').trim()}`
        return attendanceRequestLookup.get(key)
      })
      .filter(Boolean)

    const ids = Array.from(new Set(selected.map((req) => String(req.id || '')).filter(Boolean)))
    if (!ids.length) {
      setError('No pending requests in selected rows')
      return
    }

    setConfirmModal({
      open: true,
      title: 'Are you sure?',
      message: `Approve ${ids.length} selected request(s)?`,
      confirmText: 'Approve',
      onConfirm: async () => {
        try {
          await Promise.all(ids.map((id) => apiFetch(`/manual_requests/${id}/approve`, { method: 'POST' }, token)))
          setSelectedAttendanceIds([])
          flash(`${ids.length} request(s) approved`)
          await loadAll()
        } catch (err) {
          setError(err.message)
        }
      },
    })
  }

  function bulkMarkAttendance() {
    openManualAttendanceModal()
  }

  function exportAttendanceCsvForRows(rows, filenameSuffix = '') {
    if (!Array.isArray(rows) || !rows.length) {
      setError('No rows selected to export')
      return
    }

    const headers = ['Name', 'Department', 'Date', 'Shift', 'Check In', 'Check Out', 'Work Hours', 'Late By', 'Overtime', 'Timing', 'Status', 'Mode', 'Reason']
    const escapeCsvCell = (value) => {
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
        getAttendanceEmployeeMeta(a).department || '',
        String(a.date || date || '').trim(),
        inferShiftLabel(a),
        String(a.check_in || '').trim(),
        String(a.check_out || '').trim(),
        formatWorkedHoursFromAttendanceRow(a),
        formatLateByForRow(a),
        formatOvertimeForRow(a),
        String(resolveTimingStatus(a) || '').trim(),
        attendanceUiStatusLabel(a),
        attendanceRowIsWfh(a) ? 'wfh' : (a.manual_entry ? 'manual' : 'auto'),
        String(a.manual_reason || '').trim(),
      ].map(escapeCsvCell).join(',')),
    ]

    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `attendance_selection_${filenameSuffix || (date || formatDateInput())}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    flash(`${rows.length} row(s) exported to CSV`)
  }

  function bulkExportSelectedAttendance() {
    exportAttendanceCsvForRows(selectedAttendanceRows, `${selectedAttendanceRows.length}_rows`)
  }

  function bulkAddRemarkAttendance() {
    const rows = selectedAttendanceRows
    if (!rows.length) return
    if (rows.length > 1) {
      flash('Edit opens for the first selected row · use the row actions for others.')
    }
    openEditAttendanceFromRecord(rows[0])
  }

  function bulkMarkLeaveNavigation() {
    flash('Use Leave Management for approvals and leave entries.')
    goToView('requests', 'attendance', 'attendance-requests')
    setSelectedAttendanceIds([])
  }

  function toggleLogsSort(key) {
    setLogsSort((old) => {
      if (old.key === key) {
        return { key, direction: old.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key, direction: 'asc' }
    })
  }

  function toggleLogsExpandedRow(rowKey) {
    setLogsExpandedRows((old) => (old.includes(rowKey) ? old.filter((id) => id !== rowKey) : [...old, rowKey]))
  }

  async function handleLogsExport(kind) {
    try {
      setLogsExporting(kind)
      if (kind === 'csv') {
        exportAttendanceCsv()
      } else {
        await exportAttendanceRangeExcel()
      }
    } finally {
      setTimeout(() => setLogsExporting(''), 600)
    }
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

  const attendanceModuleSummary = useMemo(() => {
    const rows = Array.isArray(attendance) ? attendance : []
    const present = rows.filter((row) => attendanceUiStatusKey(row) === 'present' && !attendanceRowIsWfh(row)).length
    const wfh = rows.filter((row) => attendanceRowIsWfh(row)).length
    const absent = rows.filter((row) => attendanceUiStatusKey(row) === 'absent').length
    const late = rows.filter((row) => attendanceUiStatusKey(row) === 'late').length
    const halfDay = rows.filter((row) => attendanceUiStatusKey(row) === 'half_day').length
    return {
      total: rows.length,
      present,
      wfh,
      absent,
      late,
      halfDay,
    }
  }, [attendance, date])

  const reportsDepartmentOptions = useMemo(() => {
    const set = new Set(['all'])
    for (const dept of (analyticsData?.filters?.departments || [])) {
      const value = String(dept || '').trim()
      if (value) set.add(value)
    }
    for (const employee of (employees || [])) {
      const dept = String(employee?.department || '').trim()
      if (dept) set.add(dept)
    }
    for (const row of (analyticsData?.departmentStats || analyticsData?.departmentData || [])) {
      const dept = String(row?.department || '').trim()
      if (dept) set.add(dept)
    }
    return Array.from(set).sort((a, b) => {
      if (a === 'all') return -1
      if (b === 'all') return 1
      return a.localeCompare(b)
    })
  }, [employees, analyticsData])

  const reportsEmployeeOptions = useMemo(() => {
    const list = (employees || [])
      .filter((employee) => {
        if (reportsDepartmentFilter === 'all') return true
        return String(employee?.department || '').toLowerCase() === String(reportsDepartmentFilter || '').toLowerCase()
      })
      .map((employee) => ({
        key: String(employee?.login_id || employee?.id || ''),
        label: String(employee?.name || employee?.login_id || 'Employee'),
        department: String(employee?.department || 'General'),
      }))
    return [{ key: 'all', label: 'All Employees', department: '' }, ...list]
  }, [employees, reportsDepartmentFilter])

  function reportDateKey(row) {
    const explicit = String(row?.date || row?.clock_date || '').trim()
    if (explicit) return explicit
    const fallback = row?.check_in_at || row?.check_out_at || row?.created_at
    return fallback ? dateKeyInIST(fallback) : ''
  }

  const reportsFilteredAttendance = useMemo(
    () => (Array.isArray(analyticsData?.tableData) ? analyticsData.tableData : (Array.isArray(analyticsData?.rows) ? analyticsData.rows : [])),
    [analyticsData],
  )

  const reportsKpis = useMemo(() => {
    const present = Number(analyticsData?.summary?.present ?? analyticsData?.present ?? 0)
    const absent = Number(analyticsData?.summary?.absent ?? analyticsData?.absent ?? 0)
    const late = Number(analyticsData?.summary?.late ?? analyticsData?.late ?? 0)
    const totalHours = Number(analyticsData?.summary?.totalHours ?? analyticsData?.totalWorkingHours ?? 0)
    const attendanceRate = Number(analyticsData?.summary?.attendanceRate ?? Math.min(100, Math.round((present / Math.max(1, present + absent)) * 100)))
    const absenteeRate = Math.min(100, Math.round((absent / Math.max(1, present + absent)) * 100))

    return {
      attendanceRate,
      totalHours: Number(totalHours.toFixed(1)),
      lateCount: late,
      absenteeRate,
      trendAttendance: attendanceRate >= 70 ? '+4.2%' : '-1.3%',
      trendHours: totalHours >= 8 ? '+2.1%' : '-0.8%',
      trendLate: late > 0 ? '-3.4%' : '+1.1%',
      trendAbsent: absenteeRate > 0 ? '-2.0%' : '+0.9%',
      total: present + absent,
      present,
      absent,
    }
  }, [analyticsData])

  const reportsAttendanceTrend = useMemo(() => {
    const points = Array.isArray(analyticsData?.trends) ? analyticsData.trends : (Array.isArray(analyticsData?.weeklyData) ? analyticsData.weeklyData : [])
    return points.map((point) => ({
      date: String(point?.date || '').slice(5) || point?.day || '-',
      fullDate: point?.date || '',
      present: Number(point?.present ?? point?.count ?? 0),
      absent: Number(point?.absent ?? 0),
    }))
  }, [analyticsData])

  const reportsDepartmentAttendance = useMemo(() => {
    const rows = Array.isArray(analyticsData?.departmentStats) ? analyticsData.departmentStats : (Array.isArray(analyticsData?.departmentData) ? analyticsData.departmentData : [])
    return rows.map((row) => ({
      department: String(row?.department || 'General'),
      attendancePct: Number(row?.attendancePct || 0),
      count: Number(row?.count || row?.total || 0),
      present: Number(row?.present || 0),
      total: Number(row?.total || 0),
    }))
  }, [analyticsData])

  const reportsPerformanceRows = useMemo(() => {
    const sourceRows = Array.isArray(analyticsData?.performance) ? analyticsData.performance : []
    if (sourceRows.length) {
      return sourceRows
        .map((item) => ({
          name: String(item?.employeeName || 'Employee'),
          presentDays: Number(item?.daysPresent || 0),
          absentDays: Number(item?.daysAbsent || 0),
          lateCount: Number(item?.lateCount || 0),
          totalHours: Number(item?.totalWorkHours || 0),
          performancePct: Number(item?.performancePct || 0),
        }))
        .sort((a, b) => {
          if (b.totalHours !== a.totalHours) return b.totalHours - a.totalHours
          return a.name.localeCompare(b.name)
        })
        .map((row, index) => ({
          ...row,
          rank: index + 1,
        }))
    }

    const grouped = new Map()
    for (const row of (reportsFilteredAttendance || [])) {
      const name = String(row?.employeeName || row?.employee_name || 'Employee').trim() || 'Employee'
      const key = name.toLowerCase()
      const status = String(row?.status || '').toLowerCase()
      const hours = Number(row?.workingHours || 0)
      const bucket = grouped.get(key) || {
        name,
        presentDays: 0,
        absentDays: 0,
        lateCount: 0,
        totalHours: 0,
      }
      if (status === 'absent') bucket.absentDays += 1
      else bucket.presentDays += 1
      if (status === 'late') bucket.lateCount += 1
      bucket.totalHours += Number.isFinite(hours) ? hours : 0
      grouped.set(key, bucket)
    }

    return Array.from(grouped.values())
      .sort((a, b) => {
        if (b.totalHours !== a.totalHours) return b.totalHours - a.totalHours
        return a.name.localeCompare(b.name)
      })
      .map((row, index) => ({
        ...row,
        rank: index + 1,
        performancePct: Math.max(0, Math.min(100, Math.round((row.presentDays / Math.max(1, row.presentDays + row.absentDays)) * 100))),
      }))
  }, [analyticsData, reportsFilteredAttendance])

  const reportsHeatmap = useMemo(() => {
    const rows = Array.isArray(analyticsData?.heatmap) ? analyticsData.heatmap : reportsAttendanceTrend.map((row) => ({ date: row.fullDate, count: row.present }))
    return rows.slice(-35).map((row) => ({
      date: String(row?.date || ''),
      count: Number(row?.count || 0),
    }))
  }, [analyticsData, reportsAttendanceTrend])

  const reportsLatePie = useMemo(() => {
    const late = Number(analyticsData?.lateBreakdown?.late ?? reportsKpis.lateCount ?? 0)
    const absent = Number(analyticsData?.lateBreakdown?.absent ?? reportsKpis.absent ?? 0)
    const onTime = Number(analyticsData?.lateBreakdown?.onTime ?? Math.max(0, reportsKpis.present - reportsKpis.lateCount))
    return [
      { name: 'On Time', value: onTime, color: '#10B981' },
      { name: 'Late', value: late, color: '#F59E0B' },
      { name: 'Absent', value: absent, color: '#EF4444' },
    ]
  }, [analyticsData, reportsKpis])

  const reportsSummaryBarData = useMemo(() => ([
    { metric: 'Present', value: Number(reportsKpis.present || 0) },
    { metric: 'Absent', value: Number(reportsKpis.absent || 0) },
    { metric: 'Late', value: Number(reportsKpis.lateCount || 0) },
  ]), [reportsKpis])

  const reportsPagination = useMemo(() => {
    const meta = analyticsData?.pagination || {}
    const page = Number(meta.page || reportsPage || 1)
    const totalPages = Number(meta.totalPages || 1)
    const total = Number(meta.total || reportsFilteredAttendance.length || 0)
    return {
      page: Math.max(1, page),
      totalPages: Math.max(1, totalPages),
      total: Math.max(0, total),
      limit: Number(meta.limit || 15),
    }
  }, [analyticsData, reportsPage, reportsFilteredAttendance.length])

  const reportsMode = useMemo(() => {
    if (activeSidebarItem === 'reports-monthly') return 'monthly'
    if (activeSidebarItem === 'reports-employee') return 'employee'
    return 'attendance'
  }, [activeSidebarItem])

  const reportsModeMeta = useMemo(() => {
    if (reportsMode === 'monthly') {
      return {
        title: 'Monthly Reports',
        subtitle: 'Month-wise attendance trends, totals, and summaries.',
      }
    }
    if (reportsMode === 'employee') {
      return {
        title: 'Employee Reports',
        subtitle: 'Employee-level attendance performance and comparison.',
      }
    }
    return {
      title: 'Attendance Reports',
      subtitle: 'Daily attendance reporting with filters, trends and exports.',
    }
  }, [reportsMode])

  const reportsMonthlyTrend = useMemo(() => {
    const grouped = new Map()
    for (const row of (reportsFilteredAttendance || [])) {
      const dateText = String(row?.date || '').trim()
      if (!dateText) continue
      const month = dateText.slice(0, 7)
      const status = String(row?.status || '').toLowerCase()
      const hours = Number(row?.workingHours || 0)
      const bucket = grouped.get(month) || {
        month,
        present: 0,
        absent: 0,
        late: 0,
        totalHours: 0,
      }
      if (status === 'absent') bucket.absent += 1
      else bucket.present += 1
      if (status === 'late') bucket.late += 1
      bucket.totalHours += Number.isFinite(hours) ? hours : 0
      grouped.set(month, bucket)
    }
    return Array.from(grouped.values())
      .sort((a, b) => String(a.month).localeCompare(String(b.month)))
      .map((row) => ({ ...row, totalHours: Number(row.totalHours.toFixed(1)) }))
  }, [reportsFilteredAttendance])

  const reportsEmployeeTopByHours = useMemo(() => {
    return (reportsPerformanceRows || [])
      .slice(0, 8)
      .map((row) => ({
        name: row.name,
        totalHours: Number(row.totalHours || 0),
        performancePct: Number(row.performancePct || 0),
      }))
  }, [reportsPerformanceRows])

  const reportsHasData = useMemo(() => {
    return reportsAttendanceTrend.length > 0 || reportsFilteredAttendance.length > 0 || reportsDepartmentAttendance.length > 0
  }, [reportsAttendanceTrend, reportsFilteredAttendance, reportsDepartmentAttendance])

  useEffect(() => {
    setReportsPage((old) => Math.min(Math.max(1, old), Math.max(1, Number(reportsPagination.totalPages || 1))))
  }, [reportsPagination.totalPages])

  const REQUESTS_PAGE_SIZE = 8

  const requestTypeOptions = useMemo(() => ([
    { key: 'all', label: 'All Types' },
    { key: 'attendance', label: 'Attendance Regularization' },
    { key: 'leave', label: 'Leave' },
    { key: 'wfh', label: 'Work From Home' },
    { key: 'reimbursement', label: 'Reimbursement' },
    { key: 'on_duty', label: 'On Duty' },
  ]), [])

  function requestStatusKey(row) {
    const key = String(row?.status || '').trim().toLowerCase() || 'pending'
    if (key === 'paid') return 'paid'
    return key
  }

  function requestStatusLabel(row) {
    const key = requestStatusKey(row)
    if (key === 'paid') return 'Paid'
    if (key === 'approved') return 'Approved'
    if (key === 'rejected') return 'Rejected'
    if (key === 'conflict') return 'Conflict'
    return 'Pending'
  }

  function isReimbursementRequest(row) {
    const source = String(row?.source || '').trim().toLowerCase()
    const issueType = String(row?.issue_type || '').trim().toLowerCase()
    const reqType = String(row?.request_type || '').trim().toLowerCase()
    return source === 'reimbursement'
      || source === 'payroll_reimbursement'
      || issueType === 'reimbursement'
      || reqType === 'reimbursement'
  }

  function requestTypeKey(row) {
    if (isReimbursementRequest(row)) return 'reimbursement'
    if (row?.leave_code) return 'leave' // v2 leave request
    const raw = String(row?.request_type || row?.work_mode || '').trim().toLowerCase()
    if (!raw) return 'attendance'
    if (raw.includes('leave')) return 'leave'
    if (raw === 'wfh' || raw.includes('work_from_home') || raw.includes('work from home')) return 'wfh'
    if (raw.includes('on_duty') || raw.includes('on duty') || raw === 'outside_office') return 'on_duty'
    if (raw.includes('attendance') || raw.includes('regularization') || raw.includes('manual')) return 'attendance'
    return 'attendance'
  }

  function requestTypeLabel(row) {
    const key = requestTypeKey(row)
    if (key === 'reimbursement') return 'Reimbursement'
    if (key === 'leave') {
      if (row?.leave_code) return `${row.leave_code} Leave`
      return 'Leave'
    }
    if (key === 'wfh') return 'Work From Home'
    if (key === 'on_duty') return 'On Duty'
    return 'Attendance Regularization'
  }

  function requestDateKey(row) {
    if (row?.start_date && row?.end_date) {
      if (row.start_date === row.end_date) return row.start_date
      return `${row.start_date} to ${row.end_date}`
    }
    const explicit = String(row?.date || '').trim()
    if (explicit) return explicit
    const fallback = row?.applied_at || row?.requested_at || row?.created_at
    return fallback ? dateKeyInIST(fallback) : ''
  }

  /** True if request has any calendar day overlapping dashboardRangeBounds (global header). */
  function rowInDashboardRequestRange(row, bounds) {
    if (!bounds?.from || !bounds?.to) return true
    const fromB = String(bounds.from).slice(0, 10)
    const toB = String(bounds.to).slice(0, 10)

    let lo = ''
    let hi = ''
    const dk = requestDateKey(row)
    if (typeof dk === 'string' && dk.includes(' to ')) {
      const parts = dk.split(' to ').map((s) => String(s || '').trim().slice(0, 10)).filter(Boolean)
      lo = parts[0] || ''
      hi = parts[1] || parts[0] || ''
    } else {
      lo = hi = String(dk || '').trim().slice(0, 10)
    }

    if (!lo || lo.length !== 10) {
      const s = String(row?.start_date || '').trim().slice(0, 10)
      const e = String(row?.end_date || '').trim().slice(0, 10) || s
      const single = String(row?.date || '').trim().slice(0, 10)
      const candidates = [s, e, single].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      if (candidates.length) {
        lo = candidates.reduce((a, b) => (a < b ? a : b))
        hi = candidates.reduce((a, b) => (a > b ? a : b))
      }
    }
    if (!lo || lo.length !== 10) {
      const fb = dateKeyInIST(row?.requested_at || row?.applied_at || row?.created_at || row?.updated_at || '')
      if (/^\d{4}-\d{2}-\d{2}$/.test(fb)) {
        lo = hi = fb
      }
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(lo)) return true

    if (!hi || hi.length !== 10) hi = lo
    if (lo > hi) {
      const t = lo
      lo = hi
      hi = t
    }
    return !(hi < fromB || lo > toB)
  }

  function requestPriorityKey(row) {
    const raw = String(row?.priority || row?.severity || row?.request_priority || '').trim().toLowerCase()
    if (raw.includes('urgent') || raw === 'high' || raw === 'p1') return 'urgent'
    if (raw.includes('medium') || raw === 'med' || raw === 'p2') return 'medium'
    if (raw.includes('normal') || raw === 'low' || raw === 'p3') return 'normal'

    const status = requestStatusKey(row)
    const conflictText = requestConflictReason(row)
    const requestedAt = parseBackendDateMs(row?.applied_at || row?.requested_at || row?.created_at || row?.updated_at || '')
    const ageHours = Number.isFinite(requestedAt) ? ((Date.now() - requestedAt) / (1000 * 60 * 60)) : 0

    if (status === 'conflict' || conflictText) return 'urgent'
    if (status === 'pending' && ageHours >= 24) return 'medium'
    return 'normal'
  }

  function requestPriorityLabel(row) {
    const key = requestPriorityKey(row)
    if (key === 'urgent') return 'Urgent'
    if (key === 'medium') return 'Medium'
    return 'Normal'
  }

  function requestConflictReason(row) {
    return String(
      row?.conflict_reason
      || row?.conflictReason
      || row?.validation_message
      || row?.error_message
      || row?.conflict_message
      || '',
    ).trim()
  }

  function requestRejectionNote(row) {
    return String(
      row?.rejection_reason
      || row?.reject_reason
      || row?.admin_comment
      || row?.review_comment
      || row?.comment
      || '',
    ).trim()
  }

  const requestEmployeeLookup = useMemo(() => {
    const byName = new Map()
    const byId = new Map()
    for (const employee of (employees || [])) {
      const nameKey = String(employee?.name || '').trim().toLowerCase()
      const idKey = String(employee?.id || employee?.login_id || '').trim().toLowerCase()
      if (nameKey) byName.set(nameKey, employee)
      if (idKey) byId.set(idKey, employee)
    }
    return { byName, byId }
  }, [employees])

  function requestEmployeeMeta(row) {
    const nameKey = String(row?.employee_name || '').trim().toLowerCase()
    const idKey = String(row?.employee_id || row?.login_id || row?.employee_login_id || '').trim().toLowerCase()
    const employee = requestEmployeeLookup.byName.get(nameKey) || requestEmployeeLookup.byId.get(idKey) || null
    return {
      department: String(row?.department || employee?.department || 'General'),
      role: String(row?.role || employee?.role || 'staff'),
    }
  }

  const requestsDepartmentOptions = useMemo(() => {
    const set = new Set(['all'])
    for (const row of (manualRequests || [])) {
      const dept = requestEmployeeMeta(row).department
      if (dept) set.add(dept)
    }
    return Array.from(set)
  }, [manualRequests, requestEmployeeLookup])

  const requestsScopedForFilters = useMemo(() => {
    const q = requestsSearch.trim().toLowerCase()

    return (manualRequests || [])
      .filter((r) => {
        if (!rowInDashboardRequestRange(r, dashboardRangeBounds)) return false

        const type = requestTypeKey(r)
        if (requestsTypeFilter !== 'all' && type !== requestsTypeFilter) return false

        const dept = requestEmployeeMeta(r).department
        if (requestsDeptFilter !== 'all' && String(dept || '').toLowerCase() !== String(requestsDeptFilter || '').toLowerCase()) return false

        const priority = requestPriorityKey(r)
        if (requestsPriorityFilter !== 'all' && priority !== requestsPriorityFilter) return false

        if (!q) return true
        const d = requestDateKey(r)
        return [
          r.employee_name,
          r.reason,
          requestStatusLabel(r),
          requestTypeLabel(r),
          requestPriorityLabel(r),
          requestConflictReason(r),
          requestRejectionNote(r),
          requestEmployeeMeta(r).department,
          requestEmployeeMeta(r).role,
          d,
        ]
          .some((v) => String(v || '').toLowerCase().includes(q))
      })
      .sort((a, b) => {
        const dateA = requestDateKey(a)
        const dateB = requestDateKey(b)
        if (dateA !== dateB) return String(dateB).localeCompare(String(dateA))
        const createdA = String(a?.created_at || a?.requested_at || '')
        const createdB = String(b?.created_at || b?.requested_at || '')
        return createdB.localeCompare(createdA)
      })
  }, [
    manualRequests,
    requestsSearch,
    requestsTypeFilter,
    requestsDeptFilter,
    requestsPriorityFilter,
    dashboardRangeBounds,
    requestEmployeeLookup,
  ])

  const requestsWorkspaceKpis = useMemo(() => {
    const rows = requestsScopedForFilters
    let all = 0
    let pending = 0
    let approved = 0
    let rejected = 0
    let conflict = 0
    for (const r of rows) {
      all++
      const k = requestStatusKey(r)
      if (k === 'pending') pending++
      else if (k === 'approved' || k === 'paid') approved++
      else if (k === 'rejected') rejected++
      else if (k === 'conflict') conflict++
    }

    const processedRows = rows.filter((row) => {
      const status = requestStatusKey(row)
      return status === 'approved' || status === 'rejected' || status === 'paid'
    })

    const avgApprovalHours = (() => {
      const deltas = processedRows
        .map((row) => {
          const start = parseBackendDateMs(row?.requested_at || row?.created_at || '')
          const end = parseBackendDateMs(row?.approved_at || row?.updated_at || '')
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return NaN
          return (end - start) / (1000 * 60 * 60)
        })
        .filter((v) => Number.isFinite(v))
      if (!deltas.length) return '—'
      return `${(deltas.reduce((s, v) => s + v, 0) / deltas.length).toFixed(1)}h`
    })()

    const rejectedCount = processedRows.filter((row) => requestStatusKey(row) === 'rejected').length
    const rejectionRate = processedRows.length ? `${Math.round((rejectedCount / processedRows.length) * 100)}%` : '0%'

    return { all, pending, approved, rejected, conflict, avgApprovalHours, rejectionRate }
  }, [requestsScopedForFilters])

  const filteredManualRequests = useMemo(() => {
    if (!manualStatusFilter) return requestsScopedForFilters
    return requestsScopedForFilters.filter((r) => {
      const status = requestStatusKey(r)
      if (manualStatusFilter === 'approved') return status === 'approved' || status === 'paid'
      return status === manualStatusFilter
    })
  }, [requestsScopedForFilters, manualStatusFilter])

  const requestsTotalPages = useMemo(
    () => Math.max(1, Math.ceil(filteredManualRequests.length / REQUESTS_PAGE_SIZE)),
    [filteredManualRequests.length],
  )

  useEffect(() => {
    setRequestsPage(1)
  }, [requestsSearch, requestsTypeFilter, manualStatusFilter, requestsDeptFilter, requestsPriorityFilter, dashboardRangeBounds])

  useEffect(() => {
    setRequestsPage((old) => Math.min(Math.max(1, old), requestsTotalPages))
  }, [requestsTotalPages])

  const paginatedManualRequests = useMemo(() => {
    const start = (requestsPage - 1) * REQUESTS_PAGE_SIZE
    return filteredManualRequests.slice(start, start + REQUESTS_PAGE_SIZE)
  }, [filteredManualRequests, requestsPage])

  const filteredRequestIds = useMemo(() => filteredManualRequests.map((r) => r.id), [filteredManualRequests])
  const visibleRequestIds = useMemo(() => paginatedManualRequests.map((r) => r.id), [paginatedManualRequests])
  const selectedVisibleRequestsCount = useMemo(
    () => visibleRequestIds.filter((id) => selectedRequestIds.includes(id)).length,
    [visibleRequestIds, selectedRequestIds],
  )
  const showRequestSelection = manualStatusFilter === 'pending' || manualStatusFilter === 'conflict'
  const allVisibleRequestsSelected = visibleRequestIds.length > 0 && selectedVisibleRequestsCount === visibleRequestIds.length

  useEffect(() => {
    const visibleSet = new Set(filteredRequestIds)
    setSelectedRequestIds((old) => old.filter((id) => visibleSet.has(id)))
  }, [filteredRequestIds])

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

  const requestsApprovalKpis = useMemo(() => {
    const rows = Array.isArray(manualRequests) ? manualRequests : []
    const todayKey = formatDateInput()
    const pendingToday = rows.filter((row) => requestStatusKey(row) === 'pending' && requestDateKey(row) === todayKey).length

    const processedRows = rows.filter((row) => {
      const status = requestStatusKey(row)
      return status === 'approved' || status === 'rejected'
    })

    const avgApprovalHours = (() => {
      const deltas = processedRows
        .map((row) => {
          const start = parseBackendDateMs(row?.requested_at || row?.created_at || '')
          const end = parseBackendDateMs(row?.approved_at || row?.updated_at || '')
          if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return NaN
          return (end - start) / (1000 * 60 * 60)
        })
        .filter((v) => Number.isFinite(v))
      if (!deltas.length) return '-'
      return `${(deltas.reduce((s, v) => s + v, 0) / deltas.length).toFixed(1)}h`
    })()

    const rejectedCount = processedRows.filter((row) => requestStatusKey(row) === 'rejected').length
    const rejectionRate = processedRows.length ? `${Math.round((rejectedCount / processedRows.length) * 100)}%` : '0%'

    return { pendingToday, avgApprovalHours, rejectionRate }
  }, [manualRequests])

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

  /** Map GET /api/companies/:id response to legacy geofence form state (office_lat, etc.). */
  function companyPayloadToGeofenceShape(payload) {
    const c = payload?.company
    const att = c?.attendanceSettings || {}
    return {
      enabled: !!att.geofenceEnabled,
      office_lat: att.officeLat ?? '',
      office_lng: att.officeLng ?? '',
      office_radius_meters: Number(att.officeRadiusMeters ?? 500),
    }
  }

  const geofenceErrors = useMemo(() => {
    if (!geofence?.enabled) {
      return { office_lat: '', office_lng: '', office_radius_meters: '' }
    }
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

  const attendancePolicyErrors = useMemo(() => {
    const lateGrace = Number(attendancePolicy?.lateGraceMinutes)
    const halfDay = Number(attendancePolicy?.halfDayMinutes)
    const fullDay = Number(attendancePolicy?.fullDayMinutes)
    const cutoffHour = Number(attendancePolicy?.autoAbsentCutoffHour)

    return {
      lateGraceMinutes: !Number.isFinite(lateGrace) || lateGrace < 0 || lateGrace > 180
        ? 'Grace minutes must be between 0 and 180'
        : '',
      halfDayMinutes: !Number.isFinite(halfDay) || halfDay < 60 || halfDay > 720
        ? 'Half-day threshold must be between 1 and 12 hours'
        : '',
      fullDayMinutes: !Number.isFinite(fullDay) || fullDay < 120 || fullDay > 900
        ? 'Full-day threshold must be between 2 and 15 hours'
        : (fullDay <= halfDay ? 'Full-day threshold must be greater than half-day threshold' : ''),
      autoAbsentCutoffHour: !Number.isFinite(cutoffHour) || cutoffHour < 0 || cutoffHour > 23
        ? 'Cutoff hour must be between 0 and 23'
        : '',
    }
  }, [attendancePolicy])

  const attendancePolicyHasChanges = useMemo(() => (
    JSON.stringify(normalizeAttendancePolicyConfig(attendancePolicy)) !== JSON.stringify(normalizeAttendancePolicyConfig(attendancePolicyInitial))
  ), [attendancePolicy, attendancePolicyInitial])

  const canSaveAttendancePolicy = attendancePolicyHasChanges && !Object.values(attendancePolicyErrors).some(Boolean)

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

  function attendanceStatusKey(row, dateOverride = '') {
    const dateKey = String(dateOverride || row?.date || date || '').trim()
    if (isWeekendDateKey(dateKey)) return 'holiday'
    const rawStatus = String(row?.status || '').trim().toLowerCase()
    if (rawStatus === 'checked_in' || rawStatus === 'checked_out' || rawStatus === 'absent') return rawStatus
    if (rawStatus === 'leave_marked' || rawStatus === 'leave' || rawStatus === 'on_leave') return 'leave_marked'
    return rawStatus || 'unknown'
  }

  function attendanceStatusLabel(row, dateOverride = '') {
    const statusKey = attendanceStatusKey(row, dateOverride)
    if (statusKey === 'holiday') return 'HOLIDAY'
    if (statusKey === 'leave_marked') return 'LEAVE'
    if (!statusKey || statusKey === 'unknown') return '-'
    return statusKey.replace(/_/g, ' ').toUpperCase()
  }

  function normalizeDateRangeInput(fromDateValue = '', toDateValue = '') {
    const fromDate = String(fromDateValue || '').trim()
    const toDate = String(toDateValue || '').trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate) || !/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
      throw new Error('Select valid From and To dates')
    }
    if (fromDate > toDate) {
      throw new Error('From date cannot be after To date')
    }
    return { fromDate, toDate }
  }

  async function buildAttendanceRowsForDateRange(fromDateValue, toDateValue, nextToken = token) {
    const { fromDate, toDate } = normalizeDateRangeInput(fromDateValue, toDateValue)
    if (!nextToken) throw new Error('Session expired. Please login again.')

    const dateKeys = listDateKeysInRange(fromDate, toDate)
    if (!dateKeys.length) return { fromDate, toDate, rows: [] }

    const employeeDirectory = Array.isArray(employees) ? employees : []
    const byDate = await Promise.all(dateKeys.map(async (dayKey) => {
      const rawRows = selectedCompanyId
        ? await apiFetch(`/api/companies/${encodeURIComponent(selectedCompanyId)}/attendance?date=${encodeURIComponent(dayKey)}`, {}, nextToken).catch(() =>
            apiFetch(`/attendance?date=${encodeURIComponent(dayKey)}`, {}, nextToken),
          )
        : await apiFetch(`/attendance?date=${encodeURIComponent(dayKey)}`, {}, nextToken)
      const normalizedRows = Array.isArray(rawRows) ? rawRows.map((row) => normalizeAttendanceRow(row)) : []
      return {
        date: dayKey,
        weekday: formatWeekdayFromDateKey(dayKey),
        holiday: isWeekendDateKey(dayKey),
        rows: normalizedRows,
      }
    }))

    const flattened = []
    byDate.forEach((dayPack) => {
      const rows = Array.isArray(dayPack.rows) ? dayPack.rows : []
      const byEmployeeName = new Map(rows.map((row) => [String(row?.employee_name || '').trim().toLowerCase(), row]))
      if (dayPack.holiday && employeeDirectory.length) {
        employeeDirectory.forEach((employee) => {
          const employeeName = String(employee?.name || employee?.login_id || '').trim()
          if (!employeeName) return
          const existing = byEmployeeName.get(employeeName.toLowerCase())
          flattened.push({
            ...(existing || {}),
            employee_name: employeeName,
            date: dayPack.date,
            weekday: dayPack.weekday,
            is_holiday: true,
          })
        })
        return
      }

      rows.forEach((row) => {
        flattened.push({
          ...row,
          date: dayPack.date,
          weekday: dayPack.weekday,
          is_holiday: dayPack.holiday,
        })
      })
    })

    return {
      fromDate,
      toDate,
      rows: flattened,
    }
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

  function clearAdminNotifications() {
    setAdminNotificationsClearedAt(new Date().toISOString())
    setAdminNotifications([])
    setAdminNotificationReadMap({})
    setAdminAlertsTotal(0)
    setAdminNotificationOpen(false)
    setAdminNotificationDrawerOpen(false)
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
    let ok = false
    setError('')
    setLoading(true)
    setEmployeesLoading(true)
    setEmployeesError('')
    try {
      const companyQS = selectedCompanyId ? `?company_id=${encodeURIComponent(selectedCompanyId)}` : ''
      const companyAmp = selectedCompanyId ? `&company_id=${encodeURIComponent(selectedCompanyId)}` : ''
      const [e, a, req, companyOrLegacyGeo, cam, allTasks, alertPayload, warningCountsPayload, leaveV2, analyticsPayload] = await Promise.all([
        selectedCompanyId
          ? apiFetch(`/api/companies/${encodeURIComponent(selectedCompanyId)}/employees`, {}, token).catch(() =>
              apiFetch(`/api/employees?page=1&per_page=100&company_id=${encodeURIComponent(selectedCompanyId)}`, {}, token),
            )
          : apiFetch('/api/employees?page=1&per_page=100', {}, token).catch(() => apiFetch('/employees', {}, token)),
        selectedCompanyId
          ? apiFetch(`/api/companies/${encodeURIComponent(selectedCompanyId)}/attendance?date=${encodeURIComponent(date)}`, {}, token).catch(() => apiFetch(`/attendance?date=${encodeURIComponent(date)}`, {}, token))
          : apiFetch(`/attendance?date=${encodeURIComponent(date)}`, {}, token),
        apiFetch(`/manual_requests${companyQS}`, {}, token),
        selectedCompanyId
          ? apiFetch(`/api/companies/${encodeURIComponent(selectedCompanyId)}`, {}, token).catch(() => null)
          : apiFetch('/geofence_settings', {}, token),
        apiFetch('/camera_status', {}, token).catch(() => ({ disabled: true, running: false, last_event: null })),
        apiFetch(`/tasks${companyQS}`, {}, token),
        apiFetch(`/api/alerts?date=${encodeURIComponent(date)}&limit=20${companyAmp}`, {}, token).catch(() => ({ items: [], total: 0 })),
        apiFetch(`/api/warn-employee/counts${companyQS}`, {}, token).catch(() => ({ items: [] })),
        apiFetch(`/api/leave_requests${companyQS}`, {}, token).catch(() => ([])),
        apiFetch(`/api/leave-analytics${companyQS}`, {}, token).catch(() => null),
      ])
      const employeeRows = Array.isArray(e?.employees)
        ? e.employees
        : (Array.isArray(e) ? e : (Array.isArray(e?.items) ? e.items : []))
      setEmployees(employeeRows)

      // Company catalog: CompanyContext.fetchCompanies (token effect + mount) — not here, avoids duplicate /api/companies on every loadAll/refresh
      setAttendance(Array.isArray(a) ? a.map((row) => normalizeAttendanceRow(row)) : [])
      
      const combinedRequests = [
        ...(Array.isArray(req) ? req : []),
        ...(Array.isArray(leaveV2) ? leaveV2 : [])
      ].sort((a, b) => {
        const t1 = parseBackendDateMs(b.applied_at || b.created_at || '')
        const t2 = parseBackendDateMs(a.applied_at || a.created_at || '')
        return t1 - t2
      })
      setManualRequests(combinedRequests)
      setLeaveAnalytics(analyticsPayload)
      
      const nextTasks = Array.isArray(allTasks) ? allTasks : []
      setTasks(nextTasks)
      syncAdminTaskNotifications(nextTasks)
      const nextAlerts = Array.isArray(alertPayload?.items) ? alertPayload.items : []
      setAdminNotifications(nextAlerts)
      setAdminAlertsTotal(Number(alertPayload?.total || nextAlerts.length || 0))
      setAdminNotificationsBusy(false)
      setWarningCountsByEmployee(mapWarningCounts(warningCountsPayload))
      const geoState = selectedCompanyId
        ? companyPayloadToGeofenceShape(companyOrLegacyGeo) || {
          enabled: false,
          office_lat: '',
          office_lng: '',
          office_radius_meters: 500,
        }
        : companyOrLegacyGeo
      setGeofence(geoState)
      setGeofenceInitial(geoState)
      setCameraStatus(cam)
      setSettingsLastUpdated(new Date())
      clearRetryAction()
      ok = true
    } catch (err) {
      setError(err.message)
      setEmployeesError(err.message || 'Unable to load employees')
      if (isRetryableError(err)) {
        setRetryLabel('Retry loading dashboard')
        setRetryAction(() => () => loadAll())
      }
      if (String(err.message).toLowerCase().includes('invalid token')) {
        logout()
      }
    } finally {
      setLoading(false)
      setEmployeesLoading(false)
    }
    return ok
  }

  async function handleManualRefresh() {
    const ok = await loadAll()
    if (ok && token) fetchCompanies(token)
    if (ok) {
      flash('Dashboard refreshed successfully')
    } else {
      setError((old) => old || 'Refresh failed')
    }
  }

  async function fetchReportsAnalytics(nextToken = token) {
    if (!nextToken) return

    const params = new URLSearchParams()
    if (reportsFromDate) params.set('from', reportsFromDate)
    if (reportsToDate) params.set('to', reportsToDate)
    if (reportsDepartmentFilter && reportsDepartmentFilter !== 'all') params.set('department', reportsDepartmentFilter)
    if (reportsEmployeeFilter && reportsEmployeeFilter !== 'all') params.set('employeeId', reportsEmployeeFilter)
    if (reportsStatusFilter && reportsStatusFilter !== 'all') params.set('status', reportsStatusFilter)
    if (String(reportsSearch || '').trim()) params.set('search', String(reportsSearch || '').trim())
    if (selectedCompanyId) params.set('company_id', selectedCompanyId)
    params.set('page', String(reportsPage))
    params.set('limit', '15')
    params.set('sortBy', String(reportsSort?.key || 'date'))
    params.set('sortDir', String(reportsSort?.direction || 'desc'))

    const query = params.toString()
    const endpoint = `/api/reports/attendance${query ? `?${query}` : ''}`
    const cacheKey = endpoint
    const cached = analyticsCacheRef.current.get(cacheKey)
    const nowTs = Date.now()

    if (cached && (nowTs - cached.at) < 30_000) {
      setAnalyticsData(cached.data)
      setAnalyticsError('')
      return
    }

    setAnalyticsLoading(true)
    setAnalyticsError('')
    try {
      const payload = await apiFetch(endpoint, {}, nextToken)
      analyticsCacheRef.current.set(cacheKey, { at: nowTs, data: payload })
      setAnalyticsData(payload)
      setAnalyticsError('')
    } catch (err) {
      setAnalyticsError(err.message || 'Failed to load analytics data')
    } finally {
      setAnalyticsLoading(false)
    }
  }

  async function refreshAttendanceLogsOnly(nextToken = token) {
    if (!nextToken) return
    try {
      const shouldUseRange = logsRangeFilter === 'week'
        || logsRangeFilter === 'month'
        || (logsRangeFilter === 'custom' && logsFromDate && logsToDate && logsFromDate !== logsToDate)

      if (shouldUseRange) {
        const rangePayload = await buildAttendanceRowsForDateRange(logsFromDate, logsToDate, nextToken)
        const rows = Array.isArray(rangePayload?.rows) ? rangePayload.rows : []
        setAttendance(rows)
        return
      }

      const customDay = logsRangeFilter === 'custom'
        ? (String(logsToDate || logsFromDate || '').trim())
        : ''
      const targetDate = String(customDay || date || logsToDate || formatDateInput()).trim() || formatDateInput()
      const rows = selectedCompanyId
        ? await apiFetch(`/api/companies/${encodeURIComponent(selectedCompanyId)}/attendance?date=${encodeURIComponent(targetDate)}`, {}, nextToken).catch(() =>
            apiFetch(`/attendance?date=${encodeURIComponent(targetDate)}`, {}, nextToken),
          )
        : await apiFetch(`/attendance?date=${encodeURIComponent(targetDate)}`, {}, nextToken)
      setAttendance(Array.isArray(rows) ? rows.map((row) => normalizeAttendanceRow(row)) : [])
    } catch {
      // UI polling should fail silently
    }
  }

  async function refreshTasksOnly(nextToken = token) {
    if (!nextToken) return
    try {
      const rows = await apiFetch(`/tasks${selectedCompanyId ? `?company_id=${encodeURIComponent(selectedCompanyId)}` : ''}`, {}, nextToken)
      const nextTasks = Array.isArray(rows) ? rows : []
      setTasks(nextTasks)
      syncAdminTaskNotifications(nextTasks)
    } catch {
      // task polling should fail silently
    }
  }

  async function loadAdminAlerts(nextToken = token, { silent = true } = {}) {
    if (!nextToken) return
    if (!silent) setAdminNotificationsLoading(true)
    try {
      const payload = await apiFetch(`/api/alerts?date=${encodeURIComponent(date)}&limit=20${selectedCompanyId ? `&company_id=${encodeURIComponent(selectedCompanyId)}` : ''}`, {}, nextToken)
      const rows = Array.isArray(payload?.items) ? payload.items : []
      setAdminNotifications(rows)
      setAdminAlertsTotal(Number(payload?.total || rows.length || 0))
      setAdminNotificationsBusy(false)
    } catch {
      if (!silent) setAdminNotificationsBusy(true)
    } finally {
      if (!silent) setAdminNotificationsLoading(false)
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => {
      loadAll()
    }, 150)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, date, selectedCompanyId])

  // Same-tab login: CompanyProvider only runs its mount effect once, so refresh catalog when admin token appears
  useEffect(() => {
    if (!token) return
    fetchCompanies(token)
  }, [token, fetchCompanies])

  // Companies list: CompanyProvider fetches on mount + loadAll refreshes via setGlobalCompanyList

  // Sync payroll company selector with global switcher
  useEffect(() => {
    if (selectedCompanyId) setEmployeePayrollCompany(selectedCompanyId)
  }, [selectedCompanyId])

  useEffect(() => {
    if (!globalCompanies.length) return
    setCompanies([...globalCompanies])
  }, [globalCompanies])

  // Close company switcher on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (companySwitcherRef.current && !companySwitcherRef.current.contains(e.target)) {
        setCompanySwitcherOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  useEffect(() => {
    const id = setInterval(() => setClockTick(Date.now()), 15000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!token || !autoRefreshEnabled) return undefined
    const refreshMs = Math.max(15, Math.min(DASHBOARD_AUTO_REFRESH_SECONDS, 120)) * 1000
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadAll()
      }
    }, refreshMs)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, autoRefreshEnabled, date])

  useEffect(() => {
    if (!token) return
    loadCatalogs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  useEffect(() => {
    if (!token || view !== 'reports') return
    fetchReportsAnalytics(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view, reportsRange, reportsFromDate, reportsToDate, reportsDepartmentFilter, reportsEmployeeFilter, reportsStatusFilter, reportsSearch, reportsPage, reportsSort, selectedCompanyId])

  useEffect(() => {
    const id = setTimeout(() => {
      setReportsSearch(String(reportsSearchInput || '').trim())
      setReportsPage(1)
    }, 300)
    return () => clearTimeout(id)
  }, [reportsSearchInput])

  useEffect(() => {
    setReportsPage(1)
  }, [reportsFromDate, reportsToDate, reportsDepartmentFilter, reportsEmployeeFilter, reportsStatusFilter, selectedCompanyId])

  useEffect(() => {
    if (view !== 'reports' || reportsUrlInitializedRef.current) return
    reportsUrlInitializedRef.current = true
    const fromParam = String(searchParams.get('from') || '').trim()
    const toParam = String(searchParams.get('to') || '').trim()
    const departmentParam = String(searchParams.get('department') || '').trim()
    const employeeParam = String(searchParams.get('employeeId') || '').trim()
    const statusParam = String(searchParams.get('status') || '').trim().toLowerCase()
    const searchParam = String(searchParams.get('search') || '').trim()
    const pageParam = Number(searchParams.get('page') || 1)
    const sortByParam = String(searchParams.get('sortBy') || '').trim()
    const sortDirParam = String(searchParams.get('sortDir') || '').trim().toLowerCase()

    if (/^\d{4}-\d{2}-\d{2}$/.test(fromParam)) {
      setReportsFromDate(fromParam)
      setReportsRange('custom')
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
      setReportsToDate(toParam)
      setReportsRange('custom')
    }
    if (departmentParam) setReportsDepartmentFilter(departmentParam)
    if (employeeParam) setReportsEmployeeFilter(employeeParam)
    if (statusParam) setReportsStatusFilter(statusParam)
    if (searchParam) {
      setReportsSearchInput(searchParam)
      setReportsSearch(searchParam)
    }
    if (Number.isFinite(pageParam) && pageParam > 0) setReportsPage(Math.floor(pageParam))
    if (sortByParam) {
      setReportsSort((old) => ({
        key: sortByParam,
        direction: sortDirParam === 'asc' ? 'asc' : (old?.direction || 'desc'),
      }))
    }
  }, [view, searchParams])

  useEffect(() => {
    if (view !== 'reports' || !reportsUrlInitializedRef.current) return
    const next = new URLSearchParams()
    if (reportsFromDate) next.set('from', reportsFromDate)
    if (reportsToDate) next.set('to', reportsToDate)
    if (reportsDepartmentFilter !== 'all') next.set('department', reportsDepartmentFilter)
    if (reportsEmployeeFilter !== 'all') next.set('employeeId', reportsEmployeeFilter)
    if (reportsStatusFilter !== 'all') next.set('status', reportsStatusFilter)
    if (String(reportsSearch || '').trim()) next.set('search', String(reportsSearch || '').trim())
    if (reportsPage > 1) next.set('page', String(reportsPage))
    next.set('sortBy', String(reportsSort?.key || 'date'))
    next.set('sortDir', String(reportsSort?.direction || 'desc'))
    setSearchParams(next, { replace: true })
  }, [
    view,
    reportsFromDate,
    reportsToDate,
    reportsDepartmentFilter,
    reportsEmployeeFilter,
    reportsStatusFilter,
    reportsSearch,
    reportsPage,
    reportsSort,
    setSearchParams,
  ])

  useEffect(() => {
    applyThemePreference(darkMode)
    try {
      localStorage.setItem(UI_THEME_KEY, darkMode ? 'dark' : 'light')
    } catch {
      // no-op
    }
  }, [darkMode])

  useEffect(() => {
    if (!token || view !== 'logs') return
    refreshAttendanceLogsOnly(token)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view, date, logsRangeFilter, logsFromDate, logsToDate])

  // Keep attendance log fetch window aligned with dashboard header when Custom range inputs change
  // (applyOverviewRange only runs when a range button is clicked, not on every date input change).
  useEffect(() => {
    if (overviewRange !== 'custom') return
    const { from, to } = dashboardRangeBounds
    if (!from || !to) return
    setLogsFromDate(from)
    setLogsToDate(to)
    setDate(to)
    setLogsRangeFilter('custom')
  }, [overviewRange, dashboardRangeBounds])

  useEffect(() => {
    if (view !== 'logs') return
    const next = String(overviewRange || 'today')
    setLogsRangeFilter(next === 'custom' ? 'custom' : next === 'month' ? 'month' : next === 'week' ? 'week' : 'today')
  }, [view, overviewRange])

  useEffect(() => {
    if (!token || view !== 'logs' || !liveTrackingOn) return undefined
    if (logsRangeFilter !== 'today') return undefined
    const id = setInterval(() => {
      refreshAttendanceLogsOnly(token)
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view, date, liveTrackingOn, logsRangeFilter])

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
    if (!DASHBOARD_V2_ENABLED || !token) return undefined
    const id = setInterval(() => {
      loadAdminAlerts(token, { silent: true })
    }, 7000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, date])

  useEffect(() => {
    if (!adminNotificationOpen) return undefined
    const onDocClick = (event) => {
      const root = adminNotificationWrapRef.current
      if (root && !root.contains(event.target)) {
        setAdminNotificationOpen(false)
      }
    }
    window.addEventListener('click', onDocClick)
    return () => window.removeEventListener('click', onDocClick)
  }, [adminNotificationOpen])

  useEffect(() => {
    const mappings = {
      overview: { section: 'attendance', item: 'attendance-dashboard' },
      logs: { section: 'attendance', item: 'attendance-all-records' },
      directory: { section: 'employees', item: 'employees-all' },
      add: { section: 'employees', item: 'employees-add' },
      assets: { section: 'employees', item: 'employees-all' },
      requests: { section: 'attendance', item: 'attendance-requests' },
      tasks: { section: 'attendance', item: 'attendance-all-records' },
      employeePayroll: { section: 'payroll', item: 'employee-payroll' },
      settings: { section: 'settings', item: 'settings-general' },
      accountProfile: { section: 'account', item: 'account-profile' },
      accountChangePassword: { section: 'account', item: 'account-change-password' },
      accountSecurity: { section: 'account', item: 'account-security' },
    }
    const next = mappings[view]
    if (next) {
      const currentItem = sidebarSections
        .flatMap((section) => section.items.map((item) => ({ ...item, sectionId: section.id })))
        .find((item) => item.id === activeSidebarItem)

      if (currentItem?.view === view) {
        setExpandedSidebarSection(currentItem.sectionId || next.section)
      } else {
        setExpandedSidebarSection(next.section)
        setActiveSidebarItem(next.item)
      }
    }
  }, [view, activeSidebarItem])

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

  useEffect(() => {
    if (!directoryActionMenuId) return undefined
    const onWindowClick = () => setDirectoryActionMenuId('')
    window.addEventListener('click', onWindowClick)
    return () => window.removeEventListener('click', onWindowClick)
  }, [directoryActionMenuId])

  useEffect(() => {
    if (!exceptionActionMenuId) return undefined
    const onWindowClick = () => setExceptionActionMenuId('')
    window.addEventListener('click', onWindowClick)
    return () => window.removeEventListener('click', onWindowClick)
  }, [exceptionActionMenuId])

  useEffect(() => {
    if (!token) return undefined
    const onKeyDown = (event) => {
      const targetTag = String(event?.target?.tagName || '').toLowerCase()
      const editable = targetTag === 'input' || targetTag === 'textarea' || event?.target?.isContentEditable

      if ((event.metaKey || event.ctrlKey) && String(event.key || '').toLowerCase() === 'k') {
        event.preventDefault()
        const input = document.querySelector('.hrms-global-search input')
        if (input) input.focus()
        setGlobalSearchOpen(true)
        return
      }

      if (editable) return

      const key = String(event.key || '').toLowerCase()
      if (key === 'r') {
        event.preventDefault()
        handleManualRefresh()
      } else if (key === 't') {
        event.preventDefault()
        applyOverviewRange('today')
      } else if (key === 'w') {
        event.preventDefault()
        applyOverviewRange('week')
      } else if (key === 'm') {
        event.preventDefault()
        applyOverviewRange('month')
      } else if (key === '/') {
        event.preventDefault()
        const input = document.querySelector('.hrms-global-search input')
        if (input) input.focus()
      } else if (key === '?') {
        event.preventDefault()
        setShortcutsModalOpen(true)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, loading])

  useEffect(() => {
    const id = setTimeout(() => {
      setGlobalSearchQuery(globalSearchInput)
    }, 300)
    return () => clearTimeout(id)
  }, [globalSearchInput])

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
      return
    }
    const preferredName = String(
      claims?.name || claims?.full_name || claims?.first_name || claims?.username || claims?.login_id || username || 'admin',
    ).trim()
    if (preferredName) setUsername(preferredName)
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

  useEffect(() => {
    const text = String(message || '').trim()
    if (!text) return
    if (successToastMsgRef.current === text) return
    successToastMsgRef.current = text
    showAdminBellToast('Success', text, 'success')
  }, [message])

  useEffect(() => {
    const text = String(error || '').trim()
    if (!text) return
    if (errorToastMsgRef.current === text) return
    errorToastMsgRef.current = text
    showAdminBellToast('Something went wrong', text, 'error')
  }, [error])

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

  async function handleAddCompany(name) {
    const trimmed = String(name || '').trim()
    if (!trimmed) return
    setAddCompanyBusy(true)
    setAddCompanyError('')
    try {
      const res = await apiFetch('/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      }, token)
      // Refresh full companies list from server to stay in sync
      const fresh = await apiFetch('/api/companies', {}, token).catch(() => null)
      if (fresh?.companies) {
        const normalized = normalizeCompanyCatalog(fresh.companies)
        setCompanies(normalized)
        setGlobalCompanyList(normalized)
      }
      // Auto-select the newly added company
      const added = res?.company || (fresh?.companies || []).find(c => c.name === trimmed)
      if (added) setNewEmp(o => ({ ...o, company_name: added.name }))
      setAddCompanyMode(false)
      setNewCompanyName('')
    } catch (err) {
      const code = Number(err?.status || 0)
      if (code === 409) {
        // Already exists — just refresh list and select it
        const fresh = await apiFetch('/api/companies', {}, token).catch(() => null)
        if (fresh?.companies) {
          const normalized = normalizeCompanyCatalog(fresh.companies)
          setCompanies(normalized)
          setGlobalCompanyList(normalized)
          const existing = normalized.find(c => c.name === trimmed || c.id === trimmed.toUpperCase().replace(/ /g,'_'))
          if (existing) setNewEmp(o => ({ ...o, company_name: existing.name }))
        }
        setAddCompanyMode(false)
        setNewCompanyName('')
      } else {
        setAddCompanyError(err?.message || 'Failed to add company — is the server running?')
      }
    } finally {
      setAddCompanyBusy(false)
    }
  }

  async function createEmployee(e) {
    e.preventDefault()
    if (createEmployeeSubmitting) return
    setError('')
    setAddEmployeeFeedback({ type: '', text: '' })
    setAddEmployeeFieldErrors({ name: '', email: '', login_id: '', password: '' })
    const name = String(newEmp.name || '').trim()
    const email = String(employeeFormEmail || '').trim().toLowerCase()
    const loginId = String(newEmp.login_id || '').trim().toLowerCase()
    const department = String(newEmp.department || 'General').trim() || 'General'
    const role = String(employeeFormRole || 'staff').trim().toLowerCase() || 'staff'
    const status = String(employeeFormStatus || 'active').trim().toLowerCase() === 'inactive' ? 'inactive' : 'active'

    if (!name) {
      const text = 'Name is required'
      setError(text)
      setAddEmployeeFeedback({ type: 'error', text })
      setAddEmployeeFieldErrors((old) => ({ ...old, name: text }))
      return
    }
    if (!email) {
      const text = 'Email is required'
      setError(text)
      setAddEmployeeFeedback({ type: 'error', text })
      setAddEmployeeFieldErrors((old) => ({ ...old, email: text }))
      return
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      const text = 'Invalid input'
      setError(text)
      setAddEmployeeFeedback({ type: 'error', text })
      setAddEmployeeFieldErrors((old) => ({ ...old, email: text }))
      return
    }

    const passwordIssue = newEmp.password ? validatePasswordInput(newEmp.password) : ''
    if (passwordIssue) {
      setError(passwordIssue)
      setAddEmployeeFeedback({ type: 'error', text: passwordIssue })
      setAddEmployeeFieldErrors((old) => ({ ...old, password: passwordIssue }))
      return
    }

    try {
      setCreateEmployeeSubmitting(true)
      const payload = {
        name, email, login_id: loginId, department, role, status,
        password: newEmp.password,
        monthly_salary: parseFloat(newEmp.monthly_salary || 0) || 0,
        salary_type: newEmp.salary_type || 'CTC_BASED',
        net_target_monthly: parseFloat(newEmp.net_target_monthly || 0) || 0,
        compensation: {
          monthlyGrossSalary: parseFloat(newEmp.monthly_salary || 0) || 0,
          salaryType: newEmp.salary_type || 'CTC_BASED',
          netTargetMonthly: parseFloat(newEmp.net_target_monthly || 0) || 0,
          payrollBasis: 'MONTHLY_GROSS',
          currency: 'INR',
        },
        portal_access: newEmp.portal_access !== false,
        send_invite_email: !!newEmp.send_invite_email,
        work_policy: newEmp.work_policy || {},
        // Extended fields
        emp_id: newEmp.emp_id || '',
        designation: newEmp.designation || '',
        company_name: newEmp.company_name || '',
        employment_type: newEmp.employment_type || 'Full-time',
        date_of_joining: newEmp.date_of_joining || '',
        reporting_manager: newEmp.reporting_manager || '',
        mobile: newEmp.mobile || '',
        father_name: newEmp.father_name || '',
        dob: newEmp.dob || '',
        gender: newEmp.gender || '',
        blood_group: newEmp.blood_group || '',
        marital_status: newEmp.marital_status || '',
        emergency_contact_name: newEmp.emergency_contact_name || '',
        emergency_contact_phone: newEmp.emergency_contact_phone || '',
        permanent_address: newEmp.permanent_address || '',
        aadhaar_number: newEmp.aadhaar_number || '',
        pan_number: newEmp.pan_number || '',
        bank_account_no: newEmp.bank_account_no || '',
        bank_ifsc: newEmp.bank_ifsc || '',
        bank_name: newEmp.bank_name || '',
        photo_url: newEmp.photo_url || '',
      }
      try {
        await apiFetch('/api/employees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, token)
      } catch (apiErr) {
        const code = Number(apiErr?.status || 0)
        if (code !== 404 && code !== 405) throw apiErr
        await apiFetch('/register_employee', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            login_id: loginId,
            department,
            password: newEmp.password,
            require_face_images: false,
          }),
        }, token)
      }
      setNewEmp(EMPTY_NEW_EMP)
      setEmployeeFormEmail('')
      setEmployeeFormRole('staff')
      setEmployeeFormStatus('active')
      setAddEmployeeShowPassword(false)
      setAddEmployeeFieldErrors({ name: '', email: '', login_id: '', password: '' })
      setAddEmployeeFeedback({ type: 'success', text: 'Employee created successfully' })
      flash('Employee created successfully')
      await loadAll()
      // Stay on employee list with success feedback visible; user can navigate to payroll manually
      setView('directory')
    } catch (err) {
      setError(err.message)
      setAddEmployeeFeedback({ type: 'error', text: err.message || 'Employee creation failed' })
    } finally {
      setCreateEmployeeSubmitting(false)
    }
  }

  async function loadCatalogs() {
    if (!token) return
    try {
      const [depsRes, rolesRes] = await Promise.all([
        apiFetch('/api/departments', {}, token),
        apiFetch('/api/roles', {}, token),
      ])
      setDepartments(Array.isArray(depsRes?.items) ? depsRes.items : [])
      setRoles(Array.isArray(rolesRes?.items) ? rolesRes.items : [])
    } catch {
      // keep existing fallback options from employees data
    }
  }

  async function addDepartment() {
    const name = String(newDepartmentName || '').trim()
    if (!name || catalogBusy) return
    try {
      setCatalogBusy(true)
      await apiFetch('/api/departments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }, token)
      setNewDepartmentName('')
      await loadCatalogs()
      flash('Department added')
    } catch (err) {
      setError(err.message || 'Unable to add department')
    } finally {
      setCatalogBusy(false)
    }
  }

  async function editDepartment(item) {
    const nextName = window.prompt('Edit department name', String(item?.name || ''))
    if (nextName == null) return
    const name = String(nextName || '').trim()
    if (!name || catalogBusy) return
    try {
      setCatalogBusy(true)
      await apiFetch(`/api/departments/${encodeURIComponent(String(item?.id || ''))}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }, token)
      await loadCatalogs()
      flash('Department updated')
    } catch (err) {
      setError(err.message || 'Unable to update department')
    } finally {
      setCatalogBusy(false)
    }
  }

  async function deleteDepartment(item) {
    if (catalogBusy) return
    const ok = window.confirm(`Delete department "${String(item?.name || '')}"?`)
    if (!ok) return
    try {
      setCatalogBusy(true)
      await apiFetch(`/api/departments/${encodeURIComponent(String(item?.id || ''))}`, { method: 'DELETE' }, token)
      await loadCatalogs()
      flash('Department deleted')
    } catch (err) {
      setError(err.message || 'Unable to delete department')
    } finally {
      setCatalogBusy(false)
    }
  }

  async function addRole() {
    const name = String(newRoleName || '').trim().toLowerCase()
    if (!name || catalogBusy) return
    try {
      setCatalogBusy(true)
      await apiFetch('/api/roles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }, token)
      setNewRoleName('')
      await loadCatalogs()
      flash('Role added')
    } catch (err) {
      setError(err.message || 'Unable to add role')
    } finally {
      setCatalogBusy(false)
    }
  }

  async function editRole(item) {
    const nextName = window.prompt('Edit role name', String(item?.name || ''))
    if (nextName == null) return
    const name = String(nextName || '').trim().toLowerCase()
    if (!name || catalogBusy) return
    try {
      setCatalogBusy(true)
      await apiFetch(`/api/roles/${encodeURIComponent(String(item?.id || ''))}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      }, token)
      await loadCatalogs()
      flash('Role updated')
    } catch (err) {
      setError(err.message || 'Unable to update role')
    } finally {
      setCatalogBusy(false)
    }
  }

  async function deleteRole(item) {
    if (catalogBusy) return
    const ok = window.confirm(`Delete role "${String(item?.name || '')}"?`)
    if (!ok) return
    try {
      setCatalogBusy(true)
      await apiFetch(`/api/roles/${encodeURIComponent(String(item?.id || ''))}`, { method: 'DELETE' }, token)
      await loadCatalogs()
      flash('Role deleted')
    } catch (err) {
      setError(err.message || 'Unable to delete role')
    } finally {
      setCatalogBusy(false)
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

  async function approve(id, comment = 'Approved by admin') {
    setError('')
    try {
      const req = manualRequests.find((r) => r.id === id)
      const endpoint = req?.leave_code ? `/api/leave_requests/${id}/approve` : `/manual_requests/${id}/approve`
      await apiFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ comment: String(comment || '').trim() || 'Approved by admin' }),
      }, token)
      flash('Request approved')
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  async function submitApproveReason() {
    const ids = Array.isArray(approveReasonModal.requestIds) ? approveReasonModal.requestIds.filter(Boolean) : []
    const comment = String(approveReasonModal.reason || '').trim() || 'Approved by admin'
    if (!ids.length) return
    setError('')
    try {
      setApproveReasonModal((old) => ({ ...old, saving: true }))
      await Promise.all(ids.map((id) => {
        const req = manualRequests.find((r) => r.id === id)
        const endpoint = req?.leave_code ? `/api/leave_requests/${id}/approve` : `/manual_requests/${id}/approve`
        return apiFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ comment }),
        }, token)
      }))
      if (ids.length > 1) setSelectedRequestIds([])
      setApproveReasonModal({ open: false, requestIds: [], reason: 'Approved by admin', saving: false })
      flash(ids.length > 1 ? `${ids.length} request(s) approved` : 'Request approved')
      await loadAll()
    } catch (err) {
      setError(err.message)
      setApproveReasonModal((old) => ({ ...old, saving: false }))
    }
  }

  async function reject(id) {
    if (!id) return
    setRejectReasonModal({
      open: true,
      requestIds: [id],
      reason: 'Rejected by admin',
      saving: false,
    })
  }

  async function submitRejectReason() {
    const ids = Array.isArray(rejectReasonModal.requestIds) ? rejectReasonModal.requestIds.filter(Boolean) : []
    const reason = String(rejectReasonModal.reason || '').trim() || 'Rejected by admin'
    if (!ids.length) return
    setError('')
    try {
      setRejectReasonModal((old) => ({ ...old, saving: true }))
      await Promise.all(ids.map((id) => {
        const req = manualRequests.find((r) => r.id === id)
        const endpoint = req?.leave_code ? `/api/leave_requests/${id}/reject` : `/manual_requests/${id}/reject`
        return apiFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason }),
        }, token)
      }))
      if (ids.length > 1) setSelectedRequestIds([])
      setRejectReasonModal({ open: false, requestIds: [], reason: 'Rejected by admin', saving: false })
      flash(ids.length > 1 ? `${ids.length} request(s) rejected` : 'Request rejected')
      await loadAll()
    } catch (err) {
      setError(err.message)
      setRejectReasonModal((old) => ({ ...old, saving: false }))
    }
  }

  async function markRequestPaid(id) {
    const requestId = String(id || '').trim()
    if (!requestId) return
    setError('')
    try {
      await apiFetch(`/manual_requests/${requestId}/mark_paid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payment_date: formatDateInput(),
          remark: 'Payment released by admin',
        }),
      }, token)
      flash('Reimbursement marked as paid')
      await loadAll()
    } catch (err) {
      setError(err.message)
    }
  }

  function confirmManualRequestAction(action, id) {
    const normalized = String(action || '').toLowerCase()
    if (!id || (normalized !== 'approve' && normalized !== 'reject')) return

    if (normalized === 'approve') {
      setApproveReasonModal({
        open: true,
        requestIds: [id],
        reason: 'Approved by admin',
        saving: false,
      })
      return
    }

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
    setApproveReasonModal({
      open: true,
      requestIds: ids,
      reason: 'Approved by admin',
      saving: false,
    })
  }

  function rejectSelectedRequests() {
    const ids = [...selectedRequestIds]
    if (!ids.length) return
    setRejectReasonModal({
      open: true,
      requestIds: ids,
      reason: 'Rejected by admin',
      saving: false,
    })
  }

  function exportRequestsCsv() {
    const rows = Array.isArray(filteredManualRequests) ? filteredManualRequests : []
    if (!rows.length) {
      setError('No requests available to export for the current filters')
      return
    }

    const headers = ['Employee Name', 'Department', 'Role', 'Request Type', 'Priority', 'Date', 'Reason', 'Status', 'Conflict Reason', 'Rejection Note', 'Requested At', 'Approved At']
    const escapeCsv = (value) => {
      const text = String(value ?? '')
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
      return text
    }

    const lines = [
      headers.join(','),
      ...rows.map((r) => [
        r.employee_name || '',
        requestEmployeeMeta(r).department,
        requestEmployeeMeta(r).role,
        requestTypeLabel(r),
        requestPriorityLabel(r),
        requestDateKey(r),
        r.reason || '',
        requestStatusLabel(r),
        requestConflictReason(r),
        requestRejectionNote(r),
        r.requested_at || r.created_at || '',
        r.approved_at || '',
      ].map(escapeCsv).join(',')),
    ]

    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `requests_${formatDateInput()}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    flash('Requests CSV exported')
  }

  function exportReportsAnalyticsCsv() {
    exportReportsTableCsv()
  }

  function toggleReportsSort(key) {
    const safe = String(key || '')
    if (!safe) return
    setReportsPage(1)
    setReportsSort((old) => {
      if (old?.key === safe) {
        return { key: safe, direction: old.direction === 'asc' ? 'desc' : 'asc' }
      }
      return { key: safe, direction: safe === 'date' ? 'desc' : 'asc' }
    })
  }

  async function fetchReportsExportRows(nextToken = token) {
    if (!nextToken) throw new Error('Session expired. Please login again.')
    const params = new URLSearchParams()
    if (reportsFromDate) params.set('from', reportsFromDate)
    if (reportsToDate) params.set('to', reportsToDate)
    if (reportsDepartmentFilter !== 'all') params.set('department', reportsDepartmentFilter)
    if (reportsEmployeeFilter !== 'all') params.set('employeeId', reportsEmployeeFilter)
    if (reportsStatusFilter !== 'all') params.set('status', reportsStatusFilter)
    if (String(reportsSearch || '').trim()) params.set('search', String(reportsSearch || '').trim())
    params.set('page', '1')
    params.set('limit', '1000')
    params.set('sortBy', String(reportsSort?.key || 'date'))
    params.set('sortDir', String(reportsSort?.direction || 'desc'))
    if (selectedCompanyId) params.set('company_id', selectedCompanyId)
    const payload = await apiFetch(`/api/reports/attendance?${params.toString()}`, {}, nextToken)
    return Array.isArray(payload?.tableData) ? payload.tableData : []
  }

  function exportReportsTableCsv(rowsInput = null) {
    const rows = Array.isArray(rowsInput) ? rowsInput : (Array.isArray(reportsFilteredAttendance) ? reportsFilteredAttendance : [])
    if (!rows.length) {
      setError('No report rows available for selected filters')
      return
    }
    const escapeCsv = (value) => {
      const text = String(value ?? '')
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
      return text
    }
    const headers = ['Date', 'Employee', 'Department', 'Check In', 'Check Out', 'Status', 'Working Hours']
    const lines = [
      headers.join(','),
      ...rows.map((row) => [
        String(row?.date || ''),
        String(row?.employeeName || row?.employee_name || ''),
        String(row?.department || 'General'),
        String(row?.checkIn || row?.check_in || ''),
        String(row?.checkOut || row?.check_out || ''),
        String(row?.status || ''),
        Number(row?.workingHours || 0).toFixed(2),
      ].map(escapeCsv).join(',')),
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `attendance_report_${formatDateInput()}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    flash('Attendance report CSV exported')
  }

  async function exportReportsAttendanceExcel() {
    try {
      const rows = await fetchReportsExportRows(token)
      if (!rows.length) {
        setError('No report rows available for selected filters')
        return
      }
      const XLSX = await import('xlsx')
      const sheetRows = rows.map((row) => ({
        Date: String(row?.date || ''),
        Employee: String(row?.employeeName || row?.employee_name || ''),
        Department: String(row?.department || 'General'),
        'Check In': String(row?.checkIn || row?.check_in || ''),
        'Check Out': String(row?.checkOut || row?.check_out || ''),
        Status: String(row?.status || ''),
        'Working Hours': Number(row?.workingHours || 0),
      }))
      const wb = XLSX.utils.book_new()
      const ws = XLSX.utils.json_to_sheet(sheetRows)
      XLSX.utils.book_append_sheet(wb, ws, 'Attendance Report')
      XLSX.writeFile(wb, `attendance_report_${formatDateInput()}.xlsx`)
      flash('Attendance report Excel exported')
    } catch (err) {
      setError(err.message || 'Unable to export attendance report')
    }
  }

  async function exportReportsAttendancePdf() {
    try {
      const rows = await fetchReportsExportRows(token)
      if (!rows.length) {
        setError('No report rows available for selected filters')
        return
      }
      const generatedAt = new Intl.DateTimeFormat('en-IN', {
        timeZone: APP_TIME_ZONE,
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date())
      const tableRowsHtml = rows.map((row) => `
        <tr>
          <td>${escapeHtml(String(row?.date || ''))}</td>
          <td>${escapeHtml(String(row?.employeeName || row?.employee_name || ''))}</td>
          <td>${escapeHtml(String(row?.department || 'General'))}</td>
          <td>${escapeHtml(String(row?.checkIn || row?.check_in || '-'))}</td>
          <td>${escapeHtml(String(row?.checkOut || row?.check_out || '-'))}</td>
          <td>${escapeHtml(String(row?.status || ''))}</td>
          <td>${escapeHtml(Number(row?.workingHours || 0).toFixed(2))}</td>
        </tr>
      `).join('')
      const html = `<!doctype html><html><head><meta charset="utf-8" /><title>Attendance Report</title><style>body{font-family:Inter,Arial,sans-serif;margin:18px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #e2e8f0;padding:7px;font-size:12px;text-align:left}th{background:#f8fafc}.actions{display:flex;justify-content:flex-end;margin-bottom:10px}button{padding:8px 12px;border:none;border-radius:8px;background:#2563eb;color:#fff;font-weight:600;cursor:pointer}@media print{.actions{display:none}}</style></head><body><div class="actions"><button onclick="window.print()">Print</button></div><h2>Attendance Report</h2><p style="color:#64748b;font-size:12px;margin:4px 0 12px;">Generated on ${escapeHtml(generatedAt)}</p><table><thead><tr><th>Date</th><th>Employee</th><th>Department</th><th>Check In</th><th>Check Out</th><th>Status</th><th>Working Hours</th></tr></thead><tbody>${tableRowsHtml}</tbody></table></body></html>`
      const win = window.open('about:blank', '_blank', 'width=1200,height=900')
      if (!win) {
        setError('Unable to open print preview. Please allow pop-ups for this site.')
        return
      }
      win.document.open()
      win.document.write(html)
      win.document.close()
      win.focus()
    } catch (err) {
      setError(err.message || 'Unable to export PDF')
    }
  }

  async function exportReportsAttendanceCsv() {
    try {
      const rows = await fetchReportsExportRows(token)
      if (!rows.length) {
        setError('No report rows available for selected filters')
        return
      }
      const headers = ['Date', 'Employee', 'Department', 'Check In', 'Check Out', 'Status', 'Working Hours']
      const csvRows = rows.map(row => [
        row?.date || '',
        row?.employeeName || row?.employee_name || '',
        row?.department || 'General',
        row?.checkIn || row?.check_in || '-',
        row?.checkOut || row?.check_out || '-',
        row?.status || '',
        Number(row?.workingHours || 0).toFixed(2)
      ])
      exportWidgetCsv(`attendance_report_${formatDateInput()}.csv`, headers, csvRows)
      flash('Attendance report CSV exported')
    } catch (err) {
      setError(err.message || 'Unable to export CSV')
    }
  }

  function exportEmployeeSummaryCsv() {
    const rows = Array.isArray(reportsPerformanceRows) ? reportsPerformanceRows : []
    if (!rows.length) {
      setError('No employee summary data available for selected filters')
      return
    }
    const lines = [
      ['Employee', 'Days Present', 'Days Absent', 'Late Count', 'Total Work Hours', 'Performance %'].join(','),
      ...rows.map((row) => [
        row.name,
        row.presentDays,
        row.absentDays,
        row.lateCount,
        row.totalHours,
        row.performancePct,
      ].join(',')),
    ]
    const csv = lines.join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `employee_summary_${formatDateInput()}.csv`
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
    flash('Employee summary exported')
  }

  async function exportDashboardWidgetExcel(filename, rows) {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.json_to_sheet(rows)
    XLSX.utils.book_append_sheet(wb, ws, 'Report')
    XLSX.writeFile(wb, filename)
  }

  async function exportDashboardWidgetPdf(title, rows) {
    const { jsPDF } = await import('jspdf')
    const doc = new jsPDF()
    doc.setFontSize(14)
    doc.text(title, 14, 16)
    doc.setFontSize(10)
    let y = 26
    for (const row of rows.slice(0, 40)) {
      const line = Object.values(row).join(' | ')
      doc.text(String(line), 14, y)
      y += 6
      if (y > 280) {
        doc.addPage()
        y = 20
      }
    }
    doc.save(`${title.toLowerCase().replace(/\s+/g, '_')}_${formatDateInput()}.pdf`)
  }

  function exportWidgetCsv(filename, headers, rows) {
    const escapeCsv = (value) => {
      const text = String(value ?? '')
      if (/[",\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`
      return text
    }
    const lines = [headers.join(','), ...rows.map((row) => row.map(escapeCsv).join(','))]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
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

  async function handleSettingsFormSave(e) {
    if (e) e.preventDefault()
    if (!hasSettingsChanges || isSettingsSaving) return
    setIsSettingsSaving(true)
    try {
      // Simulate API Call for Settings Save
      await new Promise((res) => setTimeout(res, 800))
      setSettingsFormDataInitial(settingsFormData)
      flash('Settings saved successfully')
    } catch (err) {
      setError(err.message || 'Unable to save settings')
    } finally {
      setIsSettingsSaving(false)
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
      let data
      if (selectedCompanyId) {
        const existing = await apiFetch(`/api/companies/${encodeURIComponent(selectedCompanyId)}`, {}, token).catch(() => null)
        const prevAtt = existing?.company?.attendanceSettings || {}
        const patch = {
          ...prevAtt,
          geofenceEnabled: !!geofence.enabled,
          officeLat: geofence.office_lat === '' || geofence.office_lat == null ? null : Number(geofence.office_lat),
          officeLng: geofence.office_lng === '' || geofence.office_lng == null ? null : Number(geofence.office_lng),
          officeRadiusMeters: Number(geofence.office_radius_meters),
        }
        data = await apiFetch(`/api/companies/${encodeURIComponent(selectedCompanyId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ attendanceSettings: patch }),
        }, token)
      } else {
        data = await apiFetch('/geofence_settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            enabled: !!geofence.enabled,
            office_lat: geofence.office_lat === '' || geofence.office_lat == null ? null : Number(geofence.office_lat),
            office_lng: geofence.office_lng === '' || geofence.office_lng == null ? null : Number(geofence.office_lng),
            office_radius_meters: Number(geofence.office_radius_meters),
          }),
        }, token)
      }
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

  async function saveAttendancePolicySettings(e) {
    e.preventDefault()
    if (attendancePolicySaving) return
    if (Object.values(attendancePolicyErrors).some(Boolean)) {
      setSettingsFeedback({ type: 'error', text: 'Please fix attendance policy errors before saving.' })
      return
    }
    setAttendancePolicySaving(true)
    setSettingsFeedback({ type: '', text: '' })
    try {
      const normalized = normalizeAttendancePolicyConfig(attendancePolicy)
      localStorage.setItem(ATTENDANCE_POLICY_STORAGE_KEY, JSON.stringify(normalized))
      setAttendancePolicy(normalized)
      setAttendancePolicyInitial(normalized)
      setSettingsLastUpdated(new Date())
      setSettingsFeedback({ type: 'success', text: 'Attendance policies saved successfully.' })
      flash('Attendance policies updated')
    } catch {
      setSettingsFeedback({ type: 'error', text: 'Failed to save attendance policies.' })
    } finally {
      setAttendancePolicySaving(false)
    }
  }

  function resetAttendancePolicyDefaults() {
    const defaults = normalizeAttendancePolicyConfig()
    setAttendancePolicy(defaults)
    setSettingsFeedback({ type: '', text: '' })
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
    const defaultPolicy = { saturdayPolicy: 'OFF', shiftStart: '09:00', shiftEnd: '18:00', graceMinutes: 15, overtimeEligible: true, paidLeavesPerMonth: 2 }
    const storedPolicy = (row?.work_policy && typeof row.work_policy === 'object') ? row.work_policy : {}
    setEditEmployeeModal({
      open: true,
      row,
      name: row?.name || '',
      email: row?.email || '',
      loginId: row?.login_id || '',
      department: row?.department || 'General',
      role: String(row?.role || 'staff'),
      status: String(row?.status || 'active'),
      monthly_salary: String(row?.monthly_salary || ''),
      salary_type: String(row?.salary_type || 'CTC_BASED'),
      net_target_monthly: String(row?.net_target_monthly || ''),
      work_policy: { ...defaultPolicy, ...storedPolicy },
      saving: false,
      // Extended fields
      emp_id: row?.emp_id || '',
      designation: row?.designation || '',
      company_name: row?.company_name || '',
      employment_type: row?.employment_type || 'Full-time',
      date_of_joining: row?.date_of_joining || '',
      reporting_manager: row?.reporting_manager || '',
      mobile: row?.mobile || '',
      father_name: row?.father_name || '',
      dob: row?.dob || '',
      gender: row?.gender || '',
      blood_group: row?.blood_group || '',
      marital_status: row?.marital_status || '',
      emergency_contact_name: row?.emergency_contact_name || '',
      emergency_contact_phone: row?.emergency_contact_phone || '',
      permanent_address: row?.permanent_address || '',
      aadhaar_number: row?.aadhaar_number || '',
      pan_number: row?.pan_number || '',
      bank_account_no: row?.bank_account_no || '',
      bank_ifsc: row?.bank_ifsc || '',
      bank_name: row?.bank_name || '',
      photo_url: row?.photo_url || '',
    })
  }

  async function submitEditEmployee() {
    if (!editEmployeeModal.row?.id) return
    const name = String(editEmployeeModal.name || '').trim()
    const email = String(editEmployeeModal.email || '').trim().toLowerCase()
    const loginId = String(editEmployeeModal.loginId || '').trim().toLowerCase()
    const dept = String(editEmployeeModal.department || 'General').trim() || 'General'
    const role = String(editEmployeeModal.role || 'staff').trim().toLowerCase() || 'staff'
    const status = String(editEmployeeModal.status || 'active').trim().toLowerCase() === 'inactive' ? 'inactive' : 'active'

    if (!name) {
      setError('Employee name is required')
      return
    }
    if (!email) {
      setError('Email is required')
      return
    }
    if (!loginId) {
      setError('Login ID is required')
      return
    }

    try {
      setEditEmployeeModal((old) => ({ ...old, saving: true }))
      try {
        await apiFetch(`/api/employees/${editEmployeeModal.row.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            login_id: loginId.toLowerCase(),
            department: dept,
            role,
            status,
            monthly_salary: parseFloat(editEmployeeModal.monthly_salary || 0) || 0,
            salary_type: editEmployeeModal.salary_type || 'CTC_BASED',
            net_target_monthly: parseFloat(editEmployeeModal.net_target_monthly || 0) || 0,
            work_policy: editEmployeeModal.work_policy || {},
            // Extended
            emp_id: editEmployeeModal.emp_id || '',
            designation: editEmployeeModal.designation || '',
            company_name: editEmployeeModal.company_name || '',
            employment_type: editEmployeeModal.employment_type || 'Full-time',
            date_of_joining: editEmployeeModal.date_of_joining || '',
            reporting_manager: editEmployeeModal.reporting_manager || '',
            mobile: editEmployeeModal.mobile || '',
            father_name: editEmployeeModal.father_name || '',
            dob: editEmployeeModal.dob || '',
            gender: editEmployeeModal.gender || '',
            blood_group: editEmployeeModal.blood_group || '',
            marital_status: editEmployeeModal.marital_status || '',
            emergency_contact_name: editEmployeeModal.emergency_contact_name || '',
            emergency_contact_phone: editEmployeeModal.emergency_contact_phone || '',
            permanent_address: editEmployeeModal.permanent_address || '',
            aadhaar_number: editEmployeeModal.aadhaar_number || '',
            pan_number: editEmployeeModal.pan_number || '',
            bank_account_no: editEmployeeModal.bank_account_no || '',
            bank_ifsc: editEmployeeModal.bank_ifsc || '',
            bank_name: editEmployeeModal.bank_name || '',
            photo_url: editEmployeeModal.photo_url || '',
          }),
        }, token)
      } catch (apiErr) {
        const code = Number(apiErr?.status || 0)
        if (code !== 404 && code !== 405) throw apiErr
        await apiFetch(`/employees/${editEmployeeModal.row.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            login_id: loginId.toLowerCase(),
            department: dept,
          }),
        }, token)
      }
      setEditEmployeeModal(EMPTY_EDIT_EMP)
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
          try {
            await apiFetch(`/api/employees/${row.id}`, { method: 'DELETE' }, token)
          } catch (apiErr) {
            const code = Number(apiErr?.status || 0)
            if (code !== 404 && code !== 405) throw apiErr
            await apiFetch(`/employees/${row.id}`, { method: 'DELETE' }, token)
          }
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

  const attendanceRequestBadge = Number(requestsSummary?.pending || 0)
  const lastRefreshLabel = useMemo(() => {
    if (!settingsLastUpdated) return 'pending'
    return formatTimeAgo(settingsLastUpdated)
  }, [settingsLastUpdated, clockTick])

  const isAccountSettingsView =
    view === 'accountProfile' ||
    view === 'accountChangePassword' ||
    view === 'accountSecurity'

  if (!token) {
    return (
      <main className="page center">
        <LoginCard
          title={`${BRAND_NAME} Admin Login`}
          message={error || `Use ${BRAND_NAME} admin credentials to open workspace.`}
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
    <main className="page hrms-shell">
      {mobileSidebarOpen && <div className="hrms-sidebar-backdrop" onClick={() => setMobileSidebarOpen(false)} aria-hidden="true" />}
      <div className={`layout hrms-layout ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
        <aside className={`card sidebar hrms-sidebar ${mobileSidebarOpen ? 'mobile-open' : ''}`}>
          <div className="hrms-sidebar-brand">
            <div className="hrms-logo-dot" aria-hidden="true">
              <img src={BRAND_LOGO_SRC} alt={`${BRAND_NAME} logo`} className="hrms-logo-image" />
            </div>
            {!sidebarCollapsed && (
              <div>
                <h3 className="hrms-brand-title">{BRAND_NAME}</h3>
              </div>
            )}
            <SidebarToggle collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed((old) => !old)} />
          </div>

          <div className="hrms-sidebar-scroll">
            {sidebarSections.map((section) => {
              const isExpanded = expandedSidebarSection === section.id
              const isActiveSection = section.items.some((item) => item.id === activeSidebarItem)
              return (
                <SidebarSection
                  key={section.id}
                  sectionId={section.id}
                  icon={section.icon}
                  label={section.label}
                  expanded={isExpanded}
                  active={isActiveSection}
                  collapsed={sidebarCollapsed}
                  onToggle={toggleSidebarSection}
                >
                  {section.items.map((item) => {
                    const itemBadge = item.id === 'attendance-requests' ? attendanceRequestBadge : 0
                    const itemLabel = item.id === 'attendance-requests' && itemBadge > 0
                      ? `${item.label} (${itemBadge})`
                      : item.label
                    return (
                      <SidebarItem
                        key={item.id}
                        label={itemLabel}
                        child
                        collapsed={sidebarCollapsed}
                        active={activeSidebarItem === item.id}
                        badge={itemBadge}
                        onClick={() => handleSidebarItemClick(item, section.id)}
                      />
                    )
                  })}
                </SidebarSection>
              )
            })}

            <div className="hrms-sidebar-footer-actions">
              <button className="sidebar-secondary-btn theme-toggle-btn" onClick={() => setDarkMode((v) => !v)}>
                {darkMode ? <Moon size={16} /> : <Sun size={16} />}
                {!sidebarCollapsed && <span>{darkMode ? 'Dark Mode' : 'Light Mode'}</span>}
              </button>
              {!sidebarCollapsed && (
                <div className="hrms-user-mini-card">
                  <span className="hrms-avatar">{initialsOf(username)}</span>
                  <div>
                    <p>{username}</p>
                    <small>HR Admin</small>
                  </div>
                </div>
              )}
            </div>
          </div>
        </aside>

        <section className="content hrms-content">
          <header className={`card topbar hrms-topbar hrms-admin-dashboard-hero${isAccountSettingsView ? ' hrms-topbar--account' : ''}`}>
            <div className="hrms-hero-left admin-header-left">
              <button type="button" className="hrms-mobile-menu-btn" onClick={() => setMobileSidebarOpen(true)}>
                <Menu size={18} />
              </button>
              <h1 className="hrms-welcome-title">{view === 'overview' ? `Welcome back, ${adminFirstName}` : (viewMeta[view]?.label || 'Dashboard')}</h1>
              <p className="hrms-hero-company muted">
                {!isAccountSettingsView && selectedCompany?.name ? (
                  <><span className="hrms-hero-brand">{selectedCompany.name}</span>{' · '}</>
                ) : null}
                {viewMeta[view]?.subtitle || (isAccountSettingsView ? 'Account settings' : 'Manage workforce operations with live visibility')}
              </p>
              {!isAccountSettingsView && (
                <div className="hrms-live-pill-row" aria-live="polite">
                  <span className="hrms-live-dot-pill"><span className="hrms-pulse-dot" aria-hidden="true" /> Live</span>
                  <span className="hrms-live-meta">Updated · {lastRefreshLabel}</span>
                  {DASHBOARD_V2_ENABLED && (
                    <span className="hrms-live-meta-subtle">{autoRefreshEnabled ? `Every ${Math.max(15, DASHBOARD_AUTO_REFRESH_SECONDS)}s` : 'Auto-refresh paused'}</span>
                  )}
                  {DASHBOARD_V2_ENABLED && (
                    <button
                      type="button"
                      className={`hrms-live-toggle ${autoRefreshEnabled ? '' : 'is-off'}`}
                      onClick={() => setAutoRefreshEnabled((old) => !old)}
                      aria-label="Toggle dashboard auto refresh"
                    >
                      {autoRefreshEnabled ? 'Auto on' : 'Auto off'}
                    </button>
                  )}
                </div>
              )}
              {!!sessionExpiringSoon && <p className="error">{sessionExpiringSoon}</p>}
            </div>

            {!isAccountSettingsView && (
              <div className="hrms-hero-center admin-header-range">
                <div className="hrms-range-switch hrms-range-switch-hero" role="tablist" aria-label="Overview range">
                  <button type="button" className={overviewRange === 'today' ? 'active' : 'ghost'} onClick={() => applyOverviewRange('today')}>Today</button>
                  <button type="button" className={overviewRange === 'week' ? 'active' : 'ghost'} onClick={() => applyOverviewRange('week')}>Week</button>
                  <button type="button" className={overviewRange === 'month' ? 'active' : 'ghost'} onClick={() => applyOverviewRange('month')}>Month</button>
                  {DASHBOARD_V2_ENABLED && <button type="button" className={overviewRange === 'custom' ? 'active' : 'ghost'} onClick={() => applyOverviewRange('custom')}>Custom</button>}
                </div>
                {DASHBOARD_V2_ENABLED && overviewRange === 'custom' && (
                  <div className="row compact hrms-custom-range-wrap hrms-custom-range-hero">
                    <input
                      type="date"
                      value={overviewCustomFrom}
                      onChange={(e) => {
                        setOverviewCustomFrom(e.target.value)
                        setOverviewRange('custom')
                      }}
                      aria-label="Custom range from"
                    />
                    <input
                      type="date"
                      value={overviewCustomTo}
                      onChange={(e) => {
                        setOverviewCustomTo(e.target.value)
                        setOverviewRange('custom')
                      }}
                      aria-label="Custom range to"
                    />
                  </div>
                )}
              </div>
            )}

            <div className="row admin-header-actions hrms-header-actions hrms-hero-right">
              {!isAccountSettingsView && DASHBOARD_V2_ENABLED && <div className="hrms-global-search">
                <Search size={14} />
                <input
                  type="search"
                  value={globalSearchInput}
                  onChange={(e) => setGlobalSearchInput(e.target.value)}
                  onFocus={() => setGlobalSearchOpen(true)}
                  onBlur={() => setTimeout(() => setGlobalSearchOpen(false), 120)}
                  placeholder="Search employees, payrolls, leave..."
                  aria-label="Global search"
                />
                <span className="hrms-search-shortcut">⌘K</span>
                {globalSearchOpen && (
                  <div className="hrms-global-search-results">
                    {!globalSearchQuery.trim() ? (
                      <div className="hrms-recent-searches">
                        <p className="muted small">Recent Searches</p>
                        <button type="button" className="ghost hrms-global-search-item" onMouseDown={(e) => e.preventDefault()}>
                          <Clock3 size={14} /> <span>Marketing Department</span>
                        </button>
                        <button type="button" className="ghost hrms-global-search-item" onMouseDown={(e) => e.preventDefault()}>
                          <Clock3 size={14} /> <span>Payroll November</span>
                        </button>
                      </div>
                    ) : globalSearchResults.length > 0 ? (
                      globalSearchResults.map((row) => (
                        <button
                          key={row.id}
                          type="button"
                          className="hrms-global-search-item"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => {
                            setGlobalSearchOpen(false)
                            if (row.type === 'Employee') openKpiView('attendance', 'all')
                            if (row.type === 'Request') goToView('requests', 'attendance', 'attendance-requests')
                          }}
                        >
                          <strong>{row.title}</strong>
                          <span className="muted small">{row.type} · {row.subtitle}</span>
                        </button>
                      ))
                    ) : (
                      <EmptyState icon={Search} message="No matching results" detail="Try a different employee name or keyword." />
                    )}
                  </div>
                )}
              </div>}

              {/* ── Global Company Switcher ── */}
              {!isAccountSettingsView && (
              <div className="hrms-company-switcher" ref={companySwitcherRef}>
                <button
                  type="button"
                  className="hrms-company-switcher-btn"
                  onClick={() => setCompanySwitcherOpen(o => !o)}
                  aria-label="Switch company"
                  title="Switch company"
                >
                  {selectedCompany?.color && (
                    <span className="hrms-company-dot" style={{ background: selectedCompany.color }} />
                  )}
                  <span className="hrms-company-switcher-name">{selectedCompany?.name || selectedCompanyId || 'Select Company'}</span>
                  <ChevronDown size={14} className={companySwitcherOpen ? 'hrms-rotate-180' : ''} />
                </button>
                {companySwitcherOpen && (
                  <div className="hrms-company-switcher-dropdown">
                    <div className="hrms-company-switcher-header">
                      <span>Switch Company</span>
                      <span className="muted small">{globalCompanies.length} companies</span>
                    </div>
                    {globalCompanies.map(c => (
                      <button
                        key={c.id}
                        type="button"
                        className={`hrms-company-switcher-item ${c.id === selectedCompanyId ? 'active' : ''}`}
                        onClick={() => { selectCompany(c.id); setCompanySwitcherOpen(false) }}
                      >
                        <span className="hrms-company-dot" style={{ background: c.color || '#6b7280' }} />
                        <span className="hrms-company-switcher-item-name">{c.name}</span>
                        {c.tagline && <span className="hrms-company-switcher-item-tag">{c.tagline}</span>}
                        {c.id === selectedCompanyId && <Check size={14} className="hrms-company-check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              )}

              <div className="admin-alert-wrap" ref={adminNotificationWrapRef} onClick={(e) => e.stopPropagation()}>
                <button
                  className="ghost hrms-icon-btn"
                  onClick={() => {
                    if (!adminNotificationOpen) loadAdminAlerts(token, { silent: false })
                    setAdminNotificationOpen((old) => !old)
                  }}
                  aria-label="Alerts"
                  title="Alerts & warnings"
                >
                  <Bell size={18} />
                  {adminAlertBadgeCount > 0 && (
                    <span className="hrms-dot-badge hrms-alert-badge">{adminAlertBadgeCount > 99 ? '99+' : adminAlertBadgeCount}</span>
                  )}
                </button>
                {adminNotificationOpen && (
                  <div className="admin-alert-panel">
                    <div className="row between admin-alert-panel-head">
                      <strong>Alerts &amp; Warnings</strong>
                      <div className="row compact">
                        <button type="button" className="ghost" onClick={clearAdminNotifications}>Clear All</button>
                        <button type="button" className="ghost" onClick={() => setAdminNotificationDrawerOpen(true)}>Open Center</button>
                        <button type="button" className="ghost" onClick={() => loadAdminAlerts(token, { silent: false })}>Refresh</button>
                      </div>
                    </div>
                    {adminNotificationsLoading && <p className="muted small">Loading alerts...</p>}
                    {!adminNotificationsLoading && adminNotificationsBusy && <p className="muted small">Unable to refresh alerts right now.</p>}
                    {!adminNotificationsLoading && !adminAlertItems.length && (
                      <p className="muted small">No critical alerts right now.</p>
                    )}
                    <div className="admin-alert-list">
                      {adminAlertItems.map((item) => {
                        const level = String(item?.level || '').toLowerCase()
                        const itemId = String(item?.id || `${item?.issue || 'alert'}-${item?.employeeName || 'employee'}-${item?.createdAt || ''}`)
                        return (
                          <button
                            key={itemId}
                            type="button"
                            className={`admin-alert-item ${level || 'warning'}`}
                            title={String(item?.message || '')}
                            onClick={() => {
                              setAdminNotificationReadMap((old) => ({ ...old, [itemId]: true }))
                              showAdminBellToast(item?.issue || 'Alert', item?.message || 'Attendance issue detected', level === 'missing' ? 'error' : 'info')
                            }}
                          >
                            <p className="admin-alert-title">{item?.employeeName || 'Employee'} · {item?.issue || 'Issue'}</p>
                            <p className="admin-alert-message">{item?.message || '-'}</p>
                            <span className="admin-alert-time">{item?.createdAt ? formatTimeAgo(item.createdAt) : '-'}</span>
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>
              {!isAccountSettingsView && (
                <button type="button" className="ghost hrms-topbar-action-btn" onClick={handleManualRefresh} disabled={loading} aria-label="Refresh dashboard data">
                  {loading ? (
                    <>
                      <Loader2 size={15} className="hrms-spin" />
                      <span>Refreshing...</span>
                    </>
                  ) : 'Refresh'}
                </button>
              )}
              <div className="hrms-profile-wrap">
                <button type="button" className="ghost hrms-profile-btn" onClick={() => setProfileMenuOpen((old) => !old)}>
                  <span className="hrms-avatar">{initialsOf(username)}</span>
                  <span>{username}</span>
                  <ChevronDown size={14} />
                </button>
                {profileMenuOpen && (
                  <div className="hrms-profile-dropdown">
                    <button type="button" className="ghost" onClick={() => goToView('settings', 'settings', 'settings-general')}>
                      <Settings size={15} />
                      <span>Settings</span>
                    </button>
                    <button type="button" className="ghost" onClick={logout}>
                      <LogOut size={15} />
                      <span>Logout</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {!isAccountSettingsView && (
          <CurrentCompanyBanner
            companyName={String(selectedCompany?.name || selectedCompany?.id || selectedCompanyId || '').trim()}
          />
          )}

          {DASHBOARD_V2_ENABLED && adminNotificationDrawerOpen && (
            <div className="hrms-notification-drawer-backdrop" onClick={() => setAdminNotificationDrawerOpen(false)}>
              <aside className="hrms-notification-drawer" onClick={(e) => e.stopPropagation()}>
                <div className="row between">
                  <h3>Notification Center</h3>
                  <button type="button" className="ghost" onClick={() => setAdminNotificationDrawerOpen(false)}>Close</button>
                </div>
                <div className="row between">
                  <p className="muted small">Unread: {unreadNotificationCount}</p>
                  <div className="row compact">
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        const next = {}
                        for (const item of adminAlertItems) {
                          const id = String(item?.id || `${item?.issue || 'alert'}-${item?.employeeName || 'employee'}-${item?.createdAt || ''}`)
                          next[id] = true
                        }
                        setAdminNotificationReadMap(next)
                      }}
                    >
                      Mark all read
                    </button>
                    <button type="button" className="ghost" onClick={clearAdminNotifications}>Clear All</button>
                  </div>
                </div>
                {Object.entries(groupedNotificationDrawerItems).map(([groupKey, rows]) => (
                  <div key={`notif-group-${groupKey}`} className="hrms-notification-group">
                    <p className="hrms-activity-group-title">{groupKey.toUpperCase()}</p>
                    {(rows || []).map((item) => {
                      const id = String(item?.id || `${item?.issue || 'alert'}-${item?.employeeName || 'employee'}-${item?.createdAt || ''}`)
                      const isRead = !!adminNotificationReadMap[id]
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`admin-alert-item ${isRead ? 'read' : 'unread'}`}
                          onClick={() => setAdminNotificationReadMap((old) => ({ ...old, [id]: true }))}
                        >
                          <p className="admin-alert-title">{item?.employeeName || 'Employee'} · {item?.issue || 'Issue'}</p>
                          <p className="admin-alert-message">{item?.message || '-'}</p>
                        </button>
                      )
                    })}
                    {!rows.length && <EmptyState icon={Bell} message={`No ${groupKey} notifications`} />}
                  </div>
                ))}
              </aside>
            </div>
          )}

          {DASHBOARD_V2_ENABLED && shortcutsModalOpen && (
            <div className="modal-overlay" onClick={() => setShortcutsModalOpen(false)}>
              <div className="modal-card" onClick={(e) => e.stopPropagation()}>
                <div className="row between">
                  <h3>Keyboard Shortcuts</h3>
                  <button type="button" className="ghost" onClick={() => setShortcutsModalOpen(false)}>Close</button>
                </div>
                <ul className="muted small" style={{ marginTop: 8 }}>
                  <li><strong>R</strong> Refresh dashboard</li>
                  <li><strong>T</strong> Today range</li>
                  <li><strong>W</strong> Week range</li>
                  <li><strong>M</strong> Month range</li>
                  <li><strong>/</strong> Focus global search</li>
                  <li><strong>Cmd/Ctrl + K</strong> Open global search</li>
                  <li><strong>?</strong> Open shortcuts help</li>
                </ul>
              </div>
            </div>
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
              <div className="hrms-overview-section hrms-metrics-grid hrms-metrics-grid-4">
                <HrmsMetricCard
                  icon={Users}
                  title="Total Employees"
                  value={employees.length}
                  subtitle={selectedCompany ? `${selectedCompany.name} · ${dashboardRangeBounds.label}` : `Scope: ${dashboardRangeBounds.label}`}
                  trend="headcount"
                  tone="neutral"
                  loading={loading}
                  onClick={() => openKpiView('attendance', 'all')}
                  hasBaseline={employees.length > 0}
                />
                <HrmsMetricCard
                  icon={UserCheck}
                  title="Present Today"
                  value={presentCount}
                  subtitle={`${Math.round((presentCount / Math.max(1, employees.length)) * 100)}% coverage`}
                  trend={`${Math.round((presentCount / Math.max(1, employees.length)) * 100)}%`}
                  trendDirection="up"
                  tone="success"
                  loading={loading}
                  onClick={() => openKpiView('attendance', 'present')}
                  hasBaseline={counts.total > 0}
                />
                <HrmsMetricCard
                  icon={CalendarDays}
                  title="On Leave"
                  value={onLeaveTodayCount}
                  subtitle="Approved leave entries"
                  trend={onLeaveTodayCount > 0 ? 'tracked' : 'none'}
                  trendDirection="up"
                  tone="warning"
                  loading={loading}
                  onClick={() => openKpiView('attendance', 'leave')}
                  hasBaseline={counts.total > 0}
                />
                <HrmsMetricCard
                  icon={Clock3}
                  title="Late Arrivals"
                  value={lateCount}
                  subtitle="Late entries today"
                  trend={lateCount > 0 ? 'needs review' : 'on time'}
                  trendDirection={lateCount > 0 ? 'down' : 'up'}
                  tone="warning"
                  loading={loading}
                  onClick={() => openKpiView('attendance', 'all')}
                  hasBaseline={counts.total > 0}
                />
                <HrmsMetricCard
                  icon={CheckCircle2}
                  title="Payroll Processed"
                  valueText={`${Math.round((employees.length ? Math.min(employees.length, 12) / employees.length : 0) * 100)}%`}
                  subtitle="Current cycle completion"
                  trend="on track"
                  trendDirection="up"
                  tone="success"
                  loading={loading}
                  onClick={() => goToView('employeePayroll', 'payroll', 'employee-payroll')}
                  hasBaseline={true}
                />
                <HrmsMetricCard
                  icon={AlertCircle}
                  title="Pending Approvals"
                  value={requestsSummary?.pending ?? 0}
                  subtitle="Leaves & attendance edits"
                  trend={(requestsSummary?.pending || 0) > 0 ? 'action needed' : 'up to date'}
                  trendDirection={(requestsSummary?.pending || 0) > 0 ? 'down' : 'up'}
                  tone="warning"
                  loading={loading}
                  onClick={() => openKpiView('requests')}
                  hasBaseline={true}
                />
                <HrmsMetricCard
                  icon={BarChart3}
                  title="Attendance %"
                  valueText={`${attendancePercent}%`}
                  subtitle="Rolling 30-day average"
                  trend={attendancePercent >= 95 ? 'excellent' : 'good'}
                  trendDirection={attendancePercent >= 85 ? 'up' : 'down'}
                  tone="neutral"
                  loading={loading}
                  onClick={() => openKpiView('attendance', 'all')}
                  hasBaseline={counts.total > 0}
                />
                <HrmsMetricCard
                  icon={Timer}
                  title="Monthly Payroll Cost"
                  valueText={`₹${(employees.length * 28000).toLocaleString('en-IN')}`}
                  subtitle="Est. payout for active staff"
                  trend="+2.4%"
                  trendDirection="up"
                  tone="neutral"
                  cardClassName="hrms-metric-emphasis-money"
                  loading={loading}
                  onClick={() => goToView('employeePayroll', 'payroll', 'employee-payroll')}
                  hasBaseline={true}
                />
              </div>

              <div className="hrms-overview-section hrms-dash-analytics-row">
                <article className="hrms-dash-panel hrms-dash-chart-panel">
                  <div className="hrms-dash-panel-head">
                    <div>
                      <p className="hrms-dash-eyebrow">Operational signal</p>
                      <h3 className="hrms-dash-panel-title">Attendance pulse</h3>
                      <p className="hrms-dash-caption muted">{dashboardRangeBounds.label} · present vs exceptions</p>
                    </div>
                  </div>
                  <div className="hrms-dash-chart-slot">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={attendanceTrendData} margin={{ top: 14, right: 10, left: -18, bottom: 4 }}>
                        <defs>
                          <linearGradient id="dashPresenceFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#10b981" stopOpacity={0.32} />
                            <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                          </linearGradient>
                          <linearGradient id="dashAbsentFill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#f97316" stopOpacity={0.22} />
                            <stop offset="100%" stopColor="#f97316" stopOpacity={0.02} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="4 10" stroke="#e9eef5" vertical={false} strokeOpacity={0.85} />
                        <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 11 }} dy={4} interval="preserveStartEnd" />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} width={36} />
                        <Tooltip
                          formatter={(value, key) => [value, key === 'present' ? 'Present markers' : 'Exceptions / absent']}
                          contentStyle={{
                            borderRadius: 12,
                            border: 'none',
                            boxShadow: '0 16px 32px rgba(15,23,42,0.12)',
                          }}
                          labelStyle={{ color: '#0f172a', fontWeight: 600 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                        <Area type="monotone" name="Present" dataKey="present" stroke="#10b981" strokeWidth={2} fillOpacity={1} fill="url(#dashPresenceFill)" dot={{ r: 2.5 }} activeDot={{ r: 5 }} />
                        <Area type="monotone" name="Absent / missed" dataKey="absent" stroke="#ea580c" strokeWidth={1.6} fillOpacity={1} fill="url(#dashAbsentFill)" dot={{ r: 2 }} activeDot={{ r: 5 }} />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                </article>

                <article className="hrms-dash-panel hrms-dash-chart-panel">
                  <div className="hrms-dash-panel-head">
                    <div>
                      <p className="hrms-dash-eyebrow">Estimated payroll load</p>
                      <h3 className="hrms-dash-panel-title">Payroll throughput</h3>
                      <p className="hrms-dash-caption muted">{selectedCompany?.name ? `${selectedCompany.name} · ` : ''}₹ in thousands · trend baseline</p>
                    </div>
                  </div>
                  <div className="hrms-dash-chart-slot">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={dashboardPayrollBarData} margin={{ top: 14, right: 6, left: -16, bottom: 4 }}>
                        <CartesianGrid strokeDasharray="4 10" stroke="#e9eef5" vertical={false} strokeOpacity={0.85} />
                        <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#64748b', fontSize: 11 }} interval="preserveStartEnd" dy={6} />
                        <YAxis axisLine={false} tickLine={false} tick={{ fill: '#94a3b8', fontSize: 11 }} width={38} />
                        <Tooltip
                          formatter={(value) => [`₹${value}k`, 'Estimated']}
                          contentStyle={{
                            borderRadius: 12,
                            border: 'none',
                            boxShadow: '0 16px 32px rgba(15,23,42,0.12)',
                          }}
                          labelStyle={{ color: '#0f172a', fontWeight: 600 }}
                        />
                        <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                        <Bar name="Est. expense" dataKey="expense" fill="#3b82f6" radius={[6, 6, 0, 0]} maxBarSize={44} opacity={0.92} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </article>

                <article className="hrms-dash-panel hrms-dash-chart-panel">
                  <div className="hrms-dash-panel-head">
                    <div>
                      <p className="hrms-dash-eyebrow">Balances & uptake</p>
                      <h3 className="hrms-dash-panel-title">Leave utilization</h3>
                      <p className="hrms-dash-caption muted">Days tracked in range</p>
                    </div>
                  </div>
                  <div className="hrms-dash-chart-slot hrms-dash-chart-slot-donut">
                    {leavePieChartData.length ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Tooltip
                            formatter={(value, _name, item) => [`${Number(value)} d`, item?.payload?.name || 'leave']}
                            contentStyle={{
                              borderRadius: 12,
                              border: 'none',
                              boxShadow: '0 16px 32px rgba(15,23,42,0.12)',
                            }}
                          />
                          <Legend verticalAlign="bottom" height={32} formatter={(value) => <span style={{ fontSize: 11, color: '#475569', fontWeight: 500 }}>{value}</span>} />
                          <Pie
                            data={leavePieChartData}
                            dataKey="value"
                            nameKey="name"
                            innerRadius="58%"
                            outerRadius="80%"
                            paddingAngle={4}
                          >
                            {leavePieChartData.map((_, index) => (
                              <Cell key={`dash-leave-${index}`} fill={DASH_LEAVE_PIE_COLORS[index % DASH_LEAVE_PIE_COLORS.length]} stroke="rgba(255,255,255,0.7)" strokeWidth={1} />
                            ))}
                          </Pie>
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <p className="hrms-dash-empty muted small">Leave analytics will populate once approvals flow into this workspace.</p>
                    )}
                  </div>
                </article>
              </div>

              <div className="hrms-overview-section hrms-overview-grid hrms-overview-row2">
                <article className="card hrms-overview-card hrms-side-stack-card">
                  <div className="row between">
                    <div>
                      <h3>Quick Actions</h3>
                      <p className="muted small">Fast HR operations</p>
                    </div>
                    <Sparkles size={18} />
                  </div>
                  <div className="hrms-quick-actions hrms-quick-actions-premium">
                    <div className="hrms-quick-actions-primary">
                      <button type="button" className="hrms-qa-btn-primary" onClick={() => goToView('add', 'employees', 'employees-add')}>
                        <UserPlus size={16} />
                        <span>Add Employee</span>
                      </button>
                      <button type="button" className="hrms-qa-btn-primary" onClick={() => goToView('employeePayroll', 'payroll', 'employee-payroll')}>
                        <IndianRupee size={16} />
                        <span>Run Payroll</span>
                      </button>
                    </div>
                    <div className="hrms-quick-actions-secondary">
                      <button type="button" className="hrms-qa-btn-soft" onClick={() => goToView('logs', 'attendance', 'attendance-all-records')}>
                        <ClipboardCheck size={15} />
                        <span>Mark Attendance</span>
                      </button>
                      <button type="button" className="hrms-qa-btn-soft" onClick={() => goToView('requests', 'attendance', 'attendance-requests')}>
                        <CheckCircle2 size={15} />
                        <span>Approve Leave</span>
                      </button>
                      <button type="button" className="hrms-qa-btn-soft hrms-qa-btn-wide" onClick={() => goToView('reports', 'reports', 'reports-attendance')}>
                        <Download size={15} />
                        <span>Download Reports</span>
                      </button>
                    </div>
                  </div>

                  <div className="hrms-filter-date-wrap hrms-date-filter-card hrms-date-filter-card-soft">
                    <label htmlFor="overview-date"><CalendarDays size={14} /> Date Filter</label>
                    <div className="hrms-date-quick-tabs">
                      <button type="button" className={overviewRange === 'today' ? 'active' : 'ghost'} onClick={() => applyOverviewRange('today')}>Today</button>
                      <button type="button" className={overviewRange === 'week' ? 'active' : 'ghost'} onClick={() => applyOverviewRange('week')}>Week</button>
                      <button type="button" className={overviewRange === 'month' ? 'active' : 'ghost'} onClick={() => applyOverviewRange('month')}>Month</button>
                    </div>
                    <input id="overview-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
                  </div>
                </article>
              </div>

              <div className="hrms-overview-section hrms-overview-grid hrms-live-grid">
                <article className="card hrms-overview-card hrms-live-feed-card">
                  <div className="row between hrms-live-feed-head">
                    <div>
                      <h3 className="hrms-panel-title">Live attendance</h3>
                      <p className="muted small hrms-panel-sub">Check-ins across {selectedCompany?.name || dashboardRangeBounds.label}</p>
                    </div>
                    <span className="hrms-live-dot-pill hrms-live-dot-pill-mini"><span className="hrms-pulse-dot" aria-hidden="true" /> Live</span>
                  </div>
                  <div className="hrms-live-list hrms-live-list-premium">
                    {liveAttendanceRows.map((row) => {
                      const checkInPretty = row?.check_in ? formatTime12Hour(row.check_in) : null
                      return (
                      <div className="hrms-live-item hrms-live-item-premium" key={`live-${row.id || row.employee_name}`}>
                        <div className="hrms-live-identity">
                          <span className="hrms-live-avatar">{initialsOf(row.employee_name || 'Employee')}</span>
                          <div>
                            <p className="hrms-live-name">{row.employee_name || '-'}</p>
                            <p className="hrms-live-time">
                              {checkInPretty ? <>Checked in <span className="hrms-live-sep">·</span> {checkInPretty}</> : <>Checked in pending</>}
                            </p>
                            <p className="hrms-live-meta-line muted small">Currently on shift · {dashboardRangeBounds.label}</p>
                          </div>
                        </div>
                        <span className="hrms-live-status-pill">Present</span>
                      </div>
                      )
                    })}
                    {!liveAttendanceRows.length && (
                      <div className="hrms-live-fallback hrms-live-fallback-premium">
                        <p className="muted small hrms-live-fallback-copy">Quiet floor right now · showing the latest stamped movement.</p>
                        {liveFallbackTimeline.map((item) => (
                          <div key={`live-fallback-${item.id}`} className="hrms-live-fallback-item">
                            <span className="hrms-mini-avatar-fallback">{item.initials || '—'}</span>
                            <div>
                              <p className="hrms-live-name">{item.label}</p>
                              <p className="hrms-live-time">{item.at ? formatTimeAgo(item.at) : '-'}</p>
                            </div>
                          </div>
                        ))}
                        {!liveFallbackTimeline.length && <EmptyState icon={Clock3} message="No recent attendance signals in this scope" />}
                      </div>
                    )}
                  </div>
                </article>

                <article className="card hrms-overview-card hrms-activity-panel">
                  <div className="row between hrms-activity-panel-head">
                    <div>
                      <h3 className="hrms-panel-title">Recent activity feed</h3>
                      <p className="muted small hrms-panel-sub">Attendance, payroll, leaves & onboarding</p>
                    </div>
                    <Clock3 size={17} strokeWidth={1.65} />
                  </div>
                  {DASHBOARD_V2_ENABLED && (
                    <div className="hrms-activity-filters hrms-activity-filters-premium" role="tablist" aria-label="Activity filters">
                      {[
                        { key: 'all', label: 'All' },
                        { key: 'checkins', label: 'Check-ins' },
                        { key: 'approvals', label: 'Approvals' },
                        { key: 'edits', label: 'Edits' },
                        { key: 'system', label: 'System' },
                      ].map((chip) => (
                        <button
                          key={chip.key}
                          type="button"
                          className={`hrms-activity-chip ${activityTypeFilter === chip.key ? 'active' : ''}`}
                          onClick={() => setActivityTypeFilter(chip.key)}
                          aria-label={`Show ${chip.label} activities`}
                        >
                          {chip.label}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="hrms-activity-list hrms-activity-timeline">
                    <div className="hrms-activity-group">
                      <p className="hrms-activity-group-title">Today</p>
                      {(groupedRecentActivities.today || []).map((item) => {
                        const Icon = item.icon || Activity
                        return (
                          <div className={`hrms-activity-item ${item.type || 'general'} ${item.tone || ''}`} key={item.id}>
                            {item.initials ? (
                              <span className={`hrms-activity-avatar ${item.tone || ''}`}>{item.initials}</span>
                            ) : (
                              <div className="hrms-activity-icon"><Icon size={15} /></div>
                            )}
                            <div>
                              <p className="hrms-activity-title">{item.label}</p>
                              <p className="hrms-activity-detail">{item.detail}</p>
                            </div>
                            {item.badge && <span className={`hrms-activity-badge ${item.tone || ''}`}>{item.badge}</span>}
                            <span className="hrms-activity-time">{item.at ? formatTimeInIST(item.at) : '-'}</span>
                          </div>
                        )
                      })}
                      {!groupedRecentActivities.today.length && <EmptyState icon={Activity} message="No activity logged today" />}
                    </div>
                    <div className="hrms-activity-group">
                      <p className="hrms-activity-group-title">Earlier</p>
                      {(groupedRecentActivities.earlier || []).map((item) => {
                        const Icon = item.icon || Activity
                        return (
                          <div className={`hrms-activity-item ${item.type || 'general'} ${item.tone || ''}`} key={`earlier-${item.id}`}>
                            {item.initials ? (
                              <span className={`hrms-activity-avatar ${item.tone || ''}`}>{item.initials}</span>
                            ) : (
                              <div className="hrms-activity-icon"><Icon size={15} /></div>
                            )}
                            <div>
                              <p className="hrms-activity-title">{item.label}</p>
                              <p className="hrms-activity-detail">{item.detail}</p>
                            </div>
                            {item.badge && <span className={`hrms-activity-badge ${item.tone || ''}`}>{item.badge}</span>}
                            <span className="hrms-activity-time">{item.at ? formatTimeAgo(item.at) : '-'}</span>
                          </div>
                        )
                      })}
                      {!groupedRecentActivities.earlier.length && <EmptyState icon={Clock3} message="No earlier activity in this range" />}
                    </div>
                    {!filteredRecentActivities.length && <EmptyState icon={Activity} message="No recent activities yet" />}
                  </div>
                </article>
              </div>



            </>
          )}

          {view === 'reports' && (
            <div className="reports-analytics-layout">
              <div className="card reports-header-card">
                <div className="row between reports-header-row">
                  <div>
                    <h3>{reportsModeMeta.title}</h3>
                    <p className="muted small">{reportsModeMeta.subtitle}</p>
                  </div>
                  <div className="row reports-export-actions hrms-export-btn-group">
                    <button type="button" className="ghost" onClick={() => fetchReportsAnalytics(token)} disabled={analyticsLoading} aria-label="Refresh Reports">
                      {analyticsLoading ? <Loader2 size={16} className="hrms-spin" /> : <RefreshCw size={16} />}
                    </button>
                    <button type="button" className="ghost" onClick={exportReportsAttendancePdf} title="Export PDF">
                      <FileText size={16} /> <span className="hide-mobile">PDF</span>
                    </button>
                    <button type="button" className="ghost" onClick={exportReportsAttendanceExcel} title="Export Excel">
                      <Sheet size={16} /> <span className="hide-mobile">Excel</span>
                    </button>
                    <button type="button" className="ghost" onClick={exportReportsAttendanceCsv} title="Export CSV">
                      <Download size={16} /> <span className="hide-mobile">CSV</span>
                    </button>
                    <button type="button" className="ghost" onClick={exportReportsAttendancePdf} title="Print View">
                      <Printer size={16} /> <span className="hide-mobile">Print</span>
                    </button>
                  </div>
                </div>

                <div className="reports-filter-grid">
                  <div className="reports-range-tabs" role="group" aria-label="Reports range selector">
                    <button type="button" className={`ghost ${reportsRange === 'today' ? 'active' : ''}`} onClick={() => applyReportsRange('today')}>Today</button>
                    <button type="button" className={`ghost ${reportsRange === 'week' ? 'active' : ''}`} onClick={() => applyReportsRange('week')}>Week</button>
                    <button type="button" className={`ghost ${reportsRange === 'month' ? 'active' : ''}`} onClick={() => applyReportsRange('month')}>Month</button>
                    <button type="button" className={`ghost ${reportsRange === 'custom' ? 'active' : ''}`} onClick={() => setReportsRange('custom')}>Custom</button>
                  </div>
                  <label className="reports-filter-field">
                    <span>From</span>
                    <input
                      type="date"
                      value={reportsFromDate}
                      onChange={(e) => {
                        setReportsRange('custom')
                        setReportsFromDate(e.target.value)
                      }}
                    />
                  </label>
                  <label className="reports-filter-field">
                    <span>To</span>
                    <input
                      type="date"
                      value={reportsToDate}
                      onChange={(e) => {
                        setReportsRange('custom')
                        setReportsToDate(e.target.value)
                      }}
                    />
                  </label>
                  <label className="reports-filter-field">
                    <span>Department</span>
                    <select
                      value={reportsDepartmentFilter}
                      onChange={(e) => {
                        setReportsDepartmentFilter(e.target.value)
                        setReportsEmployeeFilter('all')
                      }}
                    >
                      {reportsDepartmentOptions.map((dept) => (
                        <option key={dept} value={dept}>{dept === 'all' ? 'All Departments' : dept}</option>
                      ))}
                    </select>
                  </label>
                  <label className="reports-filter-field">
                    <span>Employee</span>
                    <select value={reportsEmployeeFilter} onChange={(e) => setReportsEmployeeFilter(e.target.value)}>
                      {reportsEmployeeOptions.map((employee) => (
                        <option key={employee.key} value={employee.key}>{employee.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="reports-filter-field">
                    <span>Status</span>
                    <select
                      value={reportsStatusFilter}
                      onChange={(e) => {
                        setReportsStatusFilter(e.target.value)
                        setReportsPage(1)
                      }}
                    >
                      {(analyticsData?.filters?.statuses || ['all', 'present', 'absent', 'late', 'leave']).map((status) => (
                        <option key={status} value={status}>{status === 'all' ? 'All Status' : status.toUpperCase()}</option>
                      ))}
                    </select>
                  </label>
                  <label className="reports-filter-field">
                    <span>Search</span>
                    <input
                      type="text"
                      value={reportsSearchInput}
                      placeholder="Search employee name"
                      onChange={(e) => setReportsSearchInput(e.target.value)}
                    />
                  </label>
                </div>
                {!!analyticsError && <div className="error">{analyticsError}</div>}
              </div>

              <div className="cards4 reports-kpi-grid">
                {reportsMode === 'attendance' && (
                  <>
                    <HrmsMetricCard
                      icon={UserCheck}
                      title="Average Attendance Rate"
                      value={reportsKpis.attendanceRate}
                      subtitle="% for selected range"
                      trend={reportsKpis.trendAttendance}
                      trendDirection={reportsKpis.attendanceRate >= 70 ? 'up' : 'down'}
                      tone="success"
                      loading={analyticsLoading}
                    />
                    <HrmsMetricCard
                      icon={Clock3}
                      title="Total Working Hours"
                      value={Math.round(reportsKpis.totalHours)}
                      subtitle={`${reportsKpis.totalHours} hrs logged`}
                      trend={reportsKpis.trendHours}
                      trendDirection={reportsKpis.totalHours >= 8 ? 'up' : 'down'}
                      tone="neutral"
                      loading={analyticsLoading}
                    />
                    <HrmsMetricCard
                      icon={AlertCircle}
                      title="Late Arrivals"
                      value={reportsKpis.lateCount}
                      subtitle="Late entries detected"
                      trend={reportsKpis.trendLate}
                      trendDirection={reportsKpis.lateCount > 0 ? 'down' : 'up'}
                      tone="warning"
                      loading={analyticsLoading}
                    />
                    <HrmsMetricCard
                      icon={UserX}
                      title="Absentee Rate"
                      value={reportsKpis.absenteeRate}
                      subtitle="% for selected range"
                      trend={reportsKpis.trendAbsent}
                      trendDirection={reportsKpis.absenteeRate > 0 ? 'down' : 'up'}
                      tone="info"
                      loading={analyticsLoading}
                    />
                  </>
                )}
                {reportsMode === 'monthly' && (
                  <>
                    <HrmsMetricCard icon={CalendarDays} title="Months In Range" value={reportsMonthlyTrend.length} subtitle="Distinct months covered" tone="neutral" loading={analyticsLoading} />
                    <HrmsMetricCard icon={UserCheck} title="Average Attendance" value={reportsKpis.attendanceRate} subtitle="Monthly attendance baseline" tone="success" loading={analyticsLoading} />
                    <HrmsMetricCard icon={Clock3} title="Monthly Work Hours" value={Math.round(reportsKpis.totalHours)} subtitle="Total hours in selected range" tone="info" loading={analyticsLoading} />
                    <HrmsMetricCard icon={AlertCircle} title="Monthly Late Count" value={reportsKpis.lateCount} subtitle="Late rows in selected range" tone="warning" loading={analyticsLoading} />
                  </>
                )}
                {reportsMode === 'employee' && (
                  <>
                    <HrmsMetricCard icon={Users} title="Employees In Report" value={reportsPerformanceRows.length} subtitle="Employees with attendance records" tone="neutral" loading={analyticsLoading} />
                    <HrmsMetricCard icon={Clock3} title="Avg Hours / Employee" value={Number((reportsKpis.totalHours / Math.max(1, reportsPerformanceRows.length)).toFixed(1))} subtitle="Working-hours average" tone="info" loading={analyticsLoading} />
                    <HrmsMetricCard icon={UserCheck} title="High Performers" value={reportsPerformanceRows.filter((row) => row.performancePct >= 80).length} subtitle="Attendance >= 80%" tone="success" loading={analyticsLoading} />
                    <HrmsMetricCard icon={AlertCircle} title="Needs Attention" value={reportsPerformanceRows.filter((row) => row.performancePct < 60).length} subtitle="Attendance below 60%" tone="warning" loading={analyticsLoading} />
                  </>
                )}
              </div>

              {analyticsLoading && (
                <div className="card reports-loading-card">
                  <div className="row compact">
                    <Loader2 size={16} className="spin" />
                    <p className="muted">Loading analytics data...</p>
                  </div>
                </div>
              )}

              {!analyticsLoading && !reportsHasData && (
                <div className="card reports-loading-card">
                  <p className="manual-requests-empty-title">No analytics data available</p>
                  <p className="muted small">Change filters or refresh to fetch latest attendance insights.</p>
                </div>
              )}

              {reportsHasData && reportsMode === 'attendance' && (
                <>
              <div className="reports-charts-grid">
                <article className="card reports-chart-card">
                  <div className="row between">
                    <div>
                      <h4>Attendance Trends</h4>
                      <p className="muted small">Present vs Absent over time</p>
                    </div>
                    <BarChart3 size={16} />
                  </div>
                  <div className="reports-chart-wrap">
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={reportsAttendanceTrend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
                        <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                        <Tooltip />
                        <Legend />
                        <Line type="monotone" dataKey="present" stroke="#10B981" strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                        <Line type="monotone" dataKey="absent" stroke="#EF4444" strokeWidth={2.2} dot={{ r: 2 }} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </article>

                <article className="card reports-chart-card">
                  <div className="row between">
                    <div>
                      <h4>Department-wise Attendance</h4>
                      <p className="muted small">Distribution across departments</p>
                    </div>
                    <Building2 size={16} />
                  </div>
                  <div className="reports-chart-wrap">
                    <ResponsiveContainer width="100%" height={260}>
                      <PieChart>
                        <Tooltip />
                        <Pie data={reportsDepartmentAttendance} dataKey="count" nameKey="department" cx="50%" cy="48%" outerRadius={82} innerRadius={44} paddingAngle={2}>
                          {reportsDepartmentAttendance.map((entry, index) => (
                            <Cell key={`${entry.department}-${index}`} fill={['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#14B8A6'][index % 6]} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="reports-dept-legend" aria-label="Department legend">
                    {reportsDepartmentAttendance.map((entry, index) => (
                      <div className="reports-dept-legend-item" key={`dept-legend-${entry.department || index}`}>
                        <span
                          className="reports-dept-legend-dot"
                          style={{ backgroundColor: ['#10B981', '#3B82F6', '#F59E0B', '#EF4444', '#8B5CF6', '#14B8A6'][index % 6] }}
                        />
                        <span className="reports-dept-legend-label" title={entry.department || 'Unknown'}>{entry.department || 'Unknown'}</span>
                      </div>
                    ))}
                  </div>
                </article>
              </div>

              <div className="reports-charts-grid reports-secondary-grid">
                <article className="card reports-chart-card">
                  <div className="row between">
                    <div>
                      <h4>Summary Breakdown</h4>
                      <p className="muted small">Present vs absent vs late counts</p>
                    </div>
                    <CalendarDays size={16} />
                  </div>
                  <div className="reports-chart-wrap">
                    <ResponsiveContainer width="100%" height={250}>
                      <BarChart data={reportsSummaryBarData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
                        <XAxis dataKey="metric" tick={{ fontSize: 12 }} />
                        <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                        <Tooltip />
                        <Bar dataKey="value" radius={[6, 6, 0, 0]} fill="#3B82F6" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </article>

                <article className="card reports-chart-card">
                  <div className="row between">
                    <div>
                      <h4>Late Coming Analysis</h4>
                      <p className="muted small">On-time vs Late vs Absent</p>
                    </div>
                    <Clock3 size={16} />
                  </div>
                  <div className="reports-chart-wrap">
                    <ResponsiveContainer width="100%" height={250}>
                      <PieChart>
                        <Tooltip />
                        <Legend />
                        <Pie data={reportsLatePie} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={78} innerRadius={42} paddingAngle={2}>
                          {reportsLatePie.map((entry) => (
                            <Cell key={entry.name} fill={entry.color} />
                          ))}
                        </Pie>
                      </PieChart>
                    </ResponsiveContainer>
                  </div>
                </article>
              </div>

              <article className="card reports-table-card">
                <div className="row between">
                  <div>
                    <h4>Attendance Report Table</h4>
                    <p className="muted small">Filtered, sortable, paginated attendance rows</p>
                  </div>
                </div>
                <div className="reports-performance-wrap hrms-table-container">
                  <table className="manual-requests-table reports-performance-table hrms-table">
                    <thead>
                      <tr>
                        <th style={{ position: 'sticky', top: 0, background: 'var(--surface-0, #fff)', zIndex: 1 }}>
                          <button type="button" className="table-sort-btn" onClick={() => toggleReportsSort('date')}>
                            Date
                            <span className="table-sort-arrows" aria-hidden="true">{reportsSort.key === 'date' ? (reportsSort.direction === 'asc' ? '↑' : '↓') : '↑↓'}</span>
                          </button>
                        </th>
                        <th style={{ position: 'sticky', top: 0, background: 'var(--surface-0, #fff)', zIndex: 1 }}>
                          <button type="button" className="table-sort-btn" onClick={() => toggleReportsSort('employeeName')}>
                            Employee
                            <span className="table-sort-arrows" aria-hidden="true">{reportsSort.key === 'employeeName' ? (reportsSort.direction === 'asc' ? '↑' : '↓') : '↑↓'}</span>
                          </button>
                        </th>
                        <th style={{ position: 'sticky', top: 0, background: 'var(--surface-0, #fff)', zIndex: 1 }}>Department</th>
                        <th style={{ position: 'sticky', top: 0, background: 'var(--surface-0, #fff)', zIndex: 1 }}>Check In</th>
                        <th style={{ position: 'sticky', top: 0, background: 'var(--surface-0, #fff)', zIndex: 1 }}>Check Out</th>
                        <th style={{ position: 'sticky', top: 0, background: 'var(--surface-0, #fff)', zIndex: 1 }}>
                          <button type="button" className="table-sort-btn" onClick={() => toggleReportsSort('status')}>
                            Status
                            <span className="table-sort-arrows" aria-hidden="true">{reportsSort.key === 'status' ? (reportsSort.direction === 'asc' ? '↑' : '↓') : '↑↓'}</span>
                          </button>
                        </th>
                        <th style={{ position: 'sticky', top: 0, background: 'var(--surface-0, #fff)', zIndex: 1, textAlign: 'right' }}>
                          <button type="button" className="table-sort-btn" onClick={() => toggleReportsSort('workingHours')}>
                            Hours
                            <span className="table-sort-arrows" aria-hidden="true">{reportsSort.key === 'workingHours' ? (reportsSort.direction === 'asc' ? '↑' : '↓') : '↑↓'}</span>
                          </button>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {reportsFilteredAttendance.map((row, index) => (
                        <tr key={`${row?.employeeId || row?.employeeName || 'employee'}-${row?.date || index}`}>
                          <td>{row?.date || '-'}</td>
                          <td><strong>{row?.employeeName || row?.employee_name || '-'}</strong></td>
                          <td>{row?.department || 'General'}</td>
                          <td>{row?.checkIn || row?.check_in || '-'}</td>
                          <td>{row?.checkOut || row?.check_out || '-'}</td>
                          <td>
                            <span className={`status-badge ${String(row?.status || '').toLowerCase() === 'present' ? 'ok' : String(row?.status || '').toLowerCase() === 'absent' ? 'danger' : 'warning'}`}>
                              {String(row?.status || '-').toUpperCase()}
                            </span>
                          </td>
                          <td style={{ textAlign: 'right' }}>{Number(row?.workingHours || 0).toFixed(2)}</td>
                        </tr>
                      ))}
                      {!reportsFilteredAttendance.length && (
                        <tr>
                          <td colSpan={7} style={{ padding: '40px 0' }}>
                            <EmptyState icon={Filter} message="No records found" detail="Try adjusting the date range or department filter." />
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="attendance-pagination" style={{ marginTop: 12 }}>
                  <p className="muted small">
                    Showing {Math.min(((reportsPagination.page - 1) * reportsPagination.limit) + 1, reportsPagination.total || 0)}-
                    {Math.min(reportsPagination.page * reportsPagination.limit, reportsPagination.total)} of {reportsPagination.total}
                  </p>
                  <div className="row">
                    <button
                      type="button"
                      className="ghost"
                      disabled={reportsPagination.page <= 1}
                      onClick={() => setReportsPage((old) => Math.max(1, old - 1))}
                    >
                      Previous
                    </button>
                    <span className="muted small">Page {reportsPagination.page} / {reportsPagination.totalPages}</span>
                    <button
                      type="button"
                      className="ghost"
                      disabled={reportsPagination.page >= reportsPagination.totalPages}
                      onClick={() => setReportsPage((old) => Math.min(reportsPagination.totalPages, old + 1))}
                    >
                      Next
                    </button>
                  </div>
                </div>
              </article>

              <article className="card reports-download-card">
                <h4>Downloadable Reports</h4>
                <div className="reports-download-actions">
                  <button type="button" onClick={exportReportsAttendancePdf}>Download Attendance PDF</button>
                  <button type="button" className="ghost" onClick={exportReportsAttendanceExcel}>Export Attendance Sheet</button>
                  <button type="button" className="ghost" onClick={exportEmployeeSummaryCsv}>Export Employee Summary</button>
                </div>
              </article>
                </>
              )}

              {reportsHasData && reportsMode === 'monthly' && (
                <>
                  <div className="reports-charts-grid">
                    <article className="card reports-chart-card">
                      <div className="row between">
                        <div>
                          <h4>Monthly Attendance Trend</h4>
                          <p className="muted small">Present vs absent month-over-month</p>
                        </div>
                        <BarChart3 size={16} />
                      </div>
                      <div className="reports-chart-wrap">
                        <ResponsiveContainer width="100%" height={260}>
                          <LineChart data={reportsMonthlyTrend} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
                            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                            <YAxis tick={{ fontSize: 12 }} allowDecimals={false} />
                            <Tooltip />
                            <Legend />
                            <Line type="monotone" dataKey="present" stroke="#10B981" strokeWidth={2.5} dot={{ r: 3 }} />
                            <Line type="monotone" dataKey="absent" stroke="#EF4444" strokeWidth={2.2} dot={{ r: 2 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </article>

                    <article className="card reports-chart-card">
                      <div className="row between">
                        <div>
                          <h4>Monthly Working Hours</h4>
                          <p className="muted small">Total hours per month</p>
                        </div>
                        <Clock3 size={16} />
                      </div>
                      <div className="reports-chart-wrap">
                        <ResponsiveContainer width="100%" height={260}>
                          <BarChart data={reportsMonthlyTrend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
                            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                            <YAxis tick={{ fontSize: 12 }} />
                            <Tooltip />
                            <Bar dataKey="totalHours" radius={[6, 6, 0, 0]} fill="#3B82F6" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </article>
                  </div>

                  <article className="card reports-table-card">
                    <div className="row between">
                      <div>
                        <h4>Monthly Summary Table</h4>
                        <p className="muted small">Month-level attendance summary</p>
                      </div>
                    </div>
                    <div className="reports-performance-wrap">
                      <table className="manual-requests-table reports-performance-table">
                        <thead>
                          <tr>
                            <th>Month</th>
                            <th>Present</th>
                            <th>Absent</th>
                            <th>Late</th>
                            <th>Total Hours</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportsMonthlyTrend.map((row) => (
                            <tr key={row.month}>
                              <td>{row.month}</td>
                              <td>{row.present}</td>
                              <td>{row.absent}</td>
                              <td>{row.late}</td>
                              <td>{row.totalHours}</td>
                            </tr>
                          ))}
                          {!reportsMonthlyTrend.length && (
                            <tr>
                              <td colSpan={5}>
                                <div className="manual-requests-empty-state">
                                  <p className="manual-requests-empty-title">No monthly rows found</p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>
                </>
              )}

              {reportsHasData && reportsMode === 'employee' && (
                <>
                  <div className="reports-charts-grid">
                    <article className="card reports-chart-card">
                      <div className="row between">
                        <div>
                          <h4>Top Employee Work Hours</h4>
                          <p className="muted small">Top contributors by total hours</p>
                        </div>
                        <Users size={16} />
                      </div>
                      <div className="reports-chart-wrap">
                        <ResponsiveContainer width="100%" height={260}>
                          <BarChart data={reportsEmployeeTopByHours} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                            <CartesianGrid strokeDasharray="3 3" stroke="rgba(148,163,184,0.25)" />
                            <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                            <YAxis tick={{ fontSize: 12 }} />
                            <Tooltip />
                            <Bar dataKey="totalHours" radius={[6, 6, 0, 0]} fill="#10B981" />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    </article>

                    <article className="card reports-chart-card">
                      <div className="row between">
                        <div>
                          <h4>Employee Attendance Distribution</h4>
                          <p className="muted small">Present, late and absent totals</p>
                        </div>
                        <PieChart size={16} />
                      </div>
                      <div className="reports-chart-wrap">
                        <ResponsiveContainer width="100%" height={250}>
                          <PieChart>
                            <Tooltip />
                            <Legend />
                            <Pie data={reportsLatePie} dataKey="value" nameKey="name" cx="50%" cy="45%" outerRadius={78} innerRadius={42} paddingAngle={2}>
                              {reportsLatePie.map((entry) => (
                                <Cell key={entry.name} fill={entry.color} />
                              ))}
                            </Pie>
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                    </article>
                  </div>

                  <article className="card reports-table-card">
                    <div className="row between">
                      <div>
                        <h4>Employee Performance Summary</h4>
                        <p className="muted small">Attendance behavior and hours by employee</p>
                      </div>
                    </div>
                    <div className="reports-performance-wrap">
                      <table className="manual-requests-table reports-performance-table">
                        <thead>
                          <tr>
                            <th>Rank</th>
                            <th>Employee</th>
                            <th>Present Days</th>
                            <th>Absent Days</th>
                            <th>Late Count</th>
                            <th>Total Hours</th>
                            <th>Attendance %</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reportsPerformanceRows.map((row) => (
                            <tr key={`${row.name}-${row.rank}`}>
                              <td>{row.rank}</td>
                              <td>{row.name}</td>
                              <td>{row.presentDays}</td>
                              <td>{row.absentDays}</td>
                              <td>{row.lateCount}</td>
                              <td>{Number(row.totalHours || 0).toFixed(1)}</td>
                              <td>{row.performancePct}%</td>
                            </tr>
                          ))}
                          {!reportsPerformanceRows.length && (
                            <tr>
                              <td colSpan={7}>
                                <div className="manual-requests-empty-state">
                                  <p className="manual-requests-empty-title">No employee report rows found</p>
                                </div>
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </article>
                </>
              )}
            </div>
          )}
          {view === 'add' && (
            <AddEmployeeOnboarding
              newEmp={newEmp}
              setNewEmp={setNewEmp}
              employeeFormEmail={employeeFormEmail}
              setEmployeeFormEmail={setEmployeeFormEmail}
              employeeFormRole={employeeFormRole}
              setEmployeeFormRole={setEmployeeFormRole}
              employeeFormStatus={employeeFormStatus}
              setEmployeeFormStatus={setEmployeeFormStatus}
              addEmployeeFeedback={addEmployeeFeedback}
              addEmployeeFieldErrors={addEmployeeFieldErrors}
              addEmployeeShowPassword={addEmployeeShowPassword}
              setAddEmployeeShowPassword={setAddEmployeeShowPassword}
              createEmployeeSubmitting={createEmployeeSubmitting}
              companies={companies}
              addCompanyMode={addCompanyMode}
              setAddCompanyMode={setAddCompanyMode}
              newCompanyName={newCompanyName}
              setNewCompanyName={setNewCompanyName}
              addCompanyError={addCompanyError}
              setAddCompanyError={setAddCompanyError}
              handleAddCompany={handleAddCompany}
              addCompanyBusy={addCompanyBusy}
              employees={employees}
              departments={departments}
              directoryDepartments={directoryDepartments}
              directoryRoles={directoryRoles}
              catalogBusy={catalogBusy}
              newDepartmentName={newDepartmentName}
              setNewDepartmentName={setNewDepartmentName}
              addDepartment={addDepartment}
              editDepartment={editDepartment}
              deleteDepartment={deleteDepartment}
              showInlineDeptManager={showInlineDeptManager}
              setShowInlineDeptManager={setShowInlineDeptManager}
              newRoleName={newRoleName}
              setNewRoleName={setNewRoleName}
              addRole={addRole}
              editRole={editRole}
              deleteRole={deleteRole}
              showInlineRoleManager={showInlineRoleManager}
              setShowInlineRoleManager={setShowInlineRoleManager}
              selectedCompany={selectedCompany}
              goToView={goToView}
              onCancel={() => { setView('directory') }}
              createEmployee={createEmployee}
              roles={roles}
            />
          )}


          {view === 'departments' && (
            <div className="card table-card">
              <div className="row between table-header-row">
                <div>
                  <h3>Departments</h3>
                  <p className="muted small">Manage department catalog for employee assignment.</p>
                </div>
              </div>
              <div className="form-group-card" style={{ maxWidth: 560 }}>
                <label className="add-field-label">Add Department</label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="add-employee-input"
                    placeholder="Department name"
                    value={newDepartmentName}
                    onChange={(e) => setNewDepartmentName(e.target.value)}
                  />
                  <button type="button" onClick={addDepartment} disabled={catalogBusy || !newDepartmentName.trim()}>
                    {catalogBusy ? 'Saving...' : 'Add'}
                  </button>
                </div>
              </div>
              <div className="table-loading-state" style={{ minHeight: 0, alignContent: 'start', justifyItems: 'stretch', marginTop: 8 }}>
                {(departments || []).map((item) => (
                  <div key={item.id} className="row between" style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '8px 10px' }}>
                    <span>{item.name}</span>
                    <div className="row compact">
                      <button type="button" className="ghost" onClick={() => editDepartment(item)} disabled={catalogBusy}>Edit</button>
                      <button type="button" className="danger" onClick={() => deleteDepartment(item)} disabled={catalogBusy}>Delete</button>
                    </div>
                  </div>
                ))}
                {!(departments || []).length && <p className="muted small">No departments available.</p>}
              </div>
            </div>
          )}

          {view === 'roles' && (
            <div className="card table-card">
              <div className="row between table-header-row">
                <div>
                  <h3>Roles</h3>
                  <p className="muted small">Manage role catalog for employee assignment.</p>
                </div>
              </div>
              <div className="form-group-card" style={{ maxWidth: 560 }}>
                <label className="add-field-label">Add Role</label>
                <div className="row" style={{ gap: 8 }}>
                  <input
                    className="add-employee-input"
                    placeholder="Role name"
                    value={newRoleName}
                    onChange={(e) => setNewRoleName(e.target.value.toLowerCase())}
                  />
                  <button type="button" onClick={addRole} disabled={catalogBusy || !newRoleName.trim()}>
                    {catalogBusy ? 'Saving...' : 'Add'}
                  </button>
                </div>
              </div>
              <div className="table-loading-state" style={{ minHeight: 0, alignContent: 'start', justifyItems: 'stretch', marginTop: 8 }}>
                {(roles || []).map((item) => (
                  <div key={item.id} className="row between" style={{ border: '1px solid #e2e8f0', borderRadius: 10, padding: '8px 10px' }}>
                    <span>{item.name}</span>
                    <div className="row compact">
                      <button type="button" className="ghost" onClick={() => editRole(item)} disabled={catalogBusy}>Edit</button>
                      <button type="button" className="danger" onClick={() => deleteRole(item)} disabled={catalogBusy}>Delete</button>
                    </div>
                  </div>
                ))}
                {!(roles || []).length && <p className="muted small">No roles available.</p>}
              </div>
            </div>
          )}

          {view === 'directory' && (
            <div className="card table-card">
              <div className="row between table-header-row">
                <div>
                  <h3>Employee Directory</h3>
                  <p className="muted small">
                    Showing {filteredEmployees.length} employee{filteredEmployees.length !== 1 ? 's' : ''}
                    {selectedCompany ? ` • ${selectedCompany.name}` : ` • ${employees.length} total`}
                  </p>
                </div>
                <div className="row table-toolbar directory-toolbar directory-toolbar-saas">
                  <button
                    type="button"
                    className="ghost"
                    onClick={printEmployeeDirectoryPdf}
                    disabled={!filteredEmployees.length}
                  >
                    Print PDF
                  </button>
                  <div className="table-search-wrap">
                    <Search size={15} className="table-search-icon" aria-hidden="true" />
                    <input
                      className="table-search table-search-with-icon"
                      placeholder="Search employees, login, email, department"
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
                  <div className="directory-filter-block">
                    <label className="directory-filter-label">Filter by Role</label>
                    <select value={directoryRoleFilter} onChange={(e) => setDirectoryRoleFilter(e.target.value)}>
                      <option value="all">All Roles</option>
                      {directoryRoles.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                  <div className="directory-filter-block">
                    <label className="directory-filter-label">Filter by Status</label>
                    <select value={directoryStatusFilter} onChange={(e) => setDirectoryStatusFilter(e.target.value)}>
                      <option value="all">All Status</option>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                  <div className="directory-filter-block">
                    <label className="directory-filter-label">Missing Check-ins</label>
                    <button
                      type="button"
                      className={directoryMissingOnly ? 'active' : 'ghost'}
                      onClick={() => setDirectoryMissingOnly((v) => !v)}
                      title="Show only employees with no attendance record in current dashboard range"
                    >
                      {directoryMissingOnly ? 'Missing only' : 'All'}
                      {!!missingCheckinEmployeeIdSet.size && <span className="muted small"> ({missingCheckinEmployeeIdSet.size})</span>}
                    </button>
                  </div>
                  {(directorySearch || directoryDeptFilter !== 'all' || directoryRoleFilter !== 'all' || directoryStatusFilter !== 'all' || directoryMissingOnly) && (
                    <button
                      type="button"
                      className="ghost"
                      onClick={() => {
                        setDirectorySearch('')
                        setDirectoryDeptFilter('all')
                        setDirectoryRoleFilter('all')
                        setDirectoryStatusFilter('all')
                        setDirectoryMissingOnly(false)
                      }}
                    >
                      Clear Filters
                    </button>
                  )}
                </div>
              </div>

              {!!selectedEmployeeIds.length && (
                <div className="directory-bulk-bar">
                  <p className="muted small"><strong>{selectedEmployeeIds.length}</strong> selected</p>
                  <button
                    type="button"
                    className="danger"
                    onClick={deleteSelectedEmployees}
                  >
                    Delete
                  </button>
                </div>
              )}

              <div className="directory-table-shell">
              <table className="directory-table directory-table-pro">
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
                        Employee
                        <span className="table-sort-arrows" aria-hidden="true">
                          {directorySort.key === 'name' ? (directorySort.direction === 'asc' ? '↑' : '↓') : '↑↓'}
                        </span>
                      </button>
                    </th>
                    <th>Login</th>
                    <th>Mobile</th>
                    <th>Designation</th>
                    <th>
                      <button type="button" className="table-sort-btn" onClick={() => toggleDirectorySort('department')}>
                        Department
                        <span className="table-sort-arrows" aria-hidden="true">
                          {directorySort.key === 'department' ? (directorySort.direction === 'asc' ? '↑' : '↓') : '↑↓'}
                        </span>
                      </button>
                    </th>
                    <th>Role</th>
                    <th>Company</th>
                    <th>Type</th>
                    <th>Joined</th>
                    <th>Status</th>
                    <th>Password Status</th>
                    <th className="directory-actions-col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {paginatedEmployees.map((e) => (
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
                        <div className="directory-employee-cell">
                          <div className="directory-employee-avatar">{initialsOf(e.name || e.login_id || 'E')}</div>
                          <div className="directory-employee-meta">
                            <button
                              type="button"
                              className="ghost directory-employee-name-btn"
                              onClick={() => openEmployeeProfile(e)}
                              title="Open employee profile"
                            >
                              {e.name}
                            </button>
                            <p className="muted small directory-employee-email">{e.email || '-'}</p>
                          </div>
                        </div>
                      </td>
                      <td>{e.login_id}</td>
                      <td>{e.mobile || <span style={{ color: '#d1d5db' }}>—</span>}</td>
                      <td>{e.designation || <span style={{ color: '#d1d5db' }}>—</span>}</td>
                      <td>{e.department || 'General'}</td>
                      <td>{e.role || 'staff'}</td>
                      <td>{e.company_name ? (() => {
                        const cc = (globalCompanies.length ? globalCompanies : companies).find(c => c.name === e.company_name || c.id === e.company_name)
                        const clr = cc?.color || '#2563eb'
                        return <span style={{ padding: '2px 8px', borderRadius: 20, background: `${clr}12`, color: clr, fontSize: '0.75rem', fontWeight: 600, border: `1px solid ${clr}30` }}>{e.company_name}</span>
                      })() : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                      <td>{e.employment_type ? <span style={{ padding: '2px 8px', borderRadius: 20, background: '#f0fdf4', color: '#16a34a', fontSize: '0.75rem', fontWeight: 600 }}>{e.employment_type}</span> : <span style={{ color: '#d1d5db' }}>—</span>}</td>
                      <td>{e.date_of_joining || <span style={{ color: '#d1d5db' }}>—</span>}</td>
                      <td>
                        {(() => {
                          const statusText = String(e.status || '').toLowerCase()
                          const isInactiveByStatus = statusText === 'inactive'
                          const hasIsActiveFlag = typeof e.is_active === 'boolean'
                          const hasActiveFlag = typeof e.active === 'boolean'
                          const isActive = hasIsActiveFlag ? !!e.is_active : (hasActiveFlag ? !!e.active : !isInactiveByStatus)
                          return (
                            <span className={`employee-status-pill ${isActive ? 'active' : 'inactive'}`}>
                              <span className="employee-status-dot" aria-hidden="true" />
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
                      <td className="directory-actions-col">
                        <div className="directory-action-rail" onClick={(evt) => evt.stopPropagation()}>
                          <button
                            type="button"
                            className="hrms-icon-button"
                            data-tooltip="View Profile"
                            aria-label={`View profile for ${e.name || e.login_id || 'employee'}`}
                            disabled={!!tableActionBusy[`${e.id}:view`]}
                            onClick={() => runTableActionBusy(`${e.id}:view`, async () => openEmployeeProfile(e))}
                          >
                            <Eye size={15} />
                          </button>
                          <button
                            type="button"
                            className="hrms-icon-button"
                            data-tooltip="Edit Employee"
                            aria-label={`Edit ${e.name || e.login_id || 'employee'}`}
                            disabled={!!tableActionBusy[`${e.id}:edit`]}
                            onClick={() => runTableActionBusy(`${e.id}:edit`, async () => editEmployee(e))}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            type="button"
                            className="hrms-icon-button"
                            data-tooltip="Generate Payslip"
                            aria-label={`Generate payslip for ${e.name || e.login_id || 'employee'}`}
                            disabled={!!tableActionBusy[`${e.id}:payroll`]}
                            onClick={() => runTableActionBusy(`${e.id}:payroll`, async () => generatePayslipForEmployee(e))}
                          >
                            <FileText size={15} />
                          </button>
                          <button
                            type="button"
                            className="hrms-icon-button"
                            data-tooltip="Mark Attendance"
                            aria-label={`Mark attendance for ${e.name || e.login_id || 'employee'}`}
                            disabled={!!tableActionBusy[`${e.id}:attendance`]}
                            onClick={() => runTableActionBusy(`${e.id}:attendance`, async () => openManualAttendanceModal(e))}
                          >
                            <ClipboardCheck size={15} />
                          </button>
                          <button
                            type="button"
                            className="hrms-icon-button danger"
                            data-tooltip="Delete Employee"
                            aria-label={`Delete ${e.name || e.login_id || 'employee'}`}
                            disabled={!!tableActionBusy[`${e.id}:delete`]}
                            onClick={() => runTableActionBusy(`${e.id}:delete`, async () => deleteEmployee(e))}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {!!employeesLoading && (
                    <tr>
                      <td colSpan={13}>
                        <div className="table-loading-state">
                          <Loader2 size={16} className="hrms-spin" />
                          <p>Loading employees...</p>
                        </div>
                      </td>
                    </tr>
                  )}
                  {!!employeesError && !employeesLoading && (
                    <tr>
                      <td colSpan={13}><p className="error">{employeesError}</p></td>
                    </tr>
                  )}
                  {!filteredEmployees.length && (
                    <tr>
                      <td colSpan={13}>
                        <div className="directory-empty-state">
                          <div className="empty-state-icon" aria-hidden="true">👥</div>
                          <p className="muted">No employees found</p>
                          <button type="button" className="ghost" onClick={() => setView('add')}>Add Employee</button>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
              <div className="attendance-pagination" style={{ marginTop: 12 }}>
                <p className="muted small">
                  Showing {Math.min((directoryPage - 1) * DIRECTORY_PAGE_SIZE + 1, filteredEmployees.length || 0)}-
                  {Math.min(directoryPage * DIRECTORY_PAGE_SIZE, filteredEmployees.length)} of {filteredEmployees.length}
                </p>
                <div className="row">
                  <button type="button" className="ghost" disabled={directoryPage <= 1} onClick={() => setDirectoryPage((old) => Math.max(1, old - 1))}>
                    Previous
                  </button>
                  <span className="muted small">Page {directoryPage} / {directoryTotalPages}</span>
                  <button
                    type="button"
                    className="ghost"
                    disabled={directoryPage >= directoryTotalPages}
                    onClick={() => setDirectoryPage((old) => Math.min(directoryTotalPages, old + 1))}
                  >
                    Next
                  </button>
                </div>
              </div>
            </div>
          )}

          {view === 'assets' && (
            <div className="card table-card">
              <div className="row between table-header-row">
                <div>
                  <h3>Assets Hub</h3>
                  <p className="muted small">Open employee assets directly from one place</p>
                </div>
                <p className="muted small">Employees: {filteredAssetsHubEmployees.length}</p>
              </div>

              <div className="row table-toolbar directory-toolbar directory-toolbar-saas">
                <div className="table-search-wrap">
                  <span className="table-search-icon" aria-hidden="true">🔎</span>
                  <input
                    className="table-search table-search-with-icon"
                    placeholder="Search employee"
                    value={assetsHubSearch}
                    onChange={(e) => setAssetsHubSearch(e.target.value)}
                  />
                </div>
                <div className="directory-filter-block">
                  <label className="directory-filter-label">Department</label>
                  <select value={assetsHubDeptFilter} onChange={(e) => setAssetsHubDeptFilter(e.target.value)}>
                    <option value="all">All Departments</option>
                    {directoryDepartments.map((d) => <option key={d} value={d}>{d}</option>)}
                  </select>
                </div>
                {(assetsHubSearch || assetsHubDeptFilter !== 'all') && (
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setAssetsHubSearch('')
                      setAssetsHubDeptFilter('all')
                    }}
                  >
                    Clear Filters
                  </button>
                )}
              </div>

              <table className="directory-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Login</th>
                    <th>Department</th>
                    <th>Role</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAssetsHubEmployees.map((employee) => (
                    <tr key={employee.id}>
                      <td>{employee.name || '-'}</td>
                      <td>{employee.login_id || '-'}</td>
                      <td>{employee.department || 'General'}</td>
                      <td>{employee.role || 'staff'}</td>
                      <td>
                        <button
                          type="button"
                          className="table-action-btn"
                          disabled={!!tableActionBusy[`${employee.id}:assets`]}
                          onClick={() => runTableActionBusy(`${employee.id}:assets`, async () => openEmployeeProfile(employee, 'assets'))}
                        >
                          Manage Assets
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!!employeesLoading && (
                    <tr>
                      <td colSpan={5}>
                        <div className="table-loading-state">
                          <Loader2 size={16} className="hrms-spin" />
                          <p>Loading employees...</p>
                        </div>
                      </td>
                    </tr>
                  )}
                  {!!employeesError && !employeesLoading && (
                    <tr>
                      <td colSpan={5}><p className="error">{employeesError}</p></td>
                    </tr>
                  )}
                  {!employeesLoading && !employeesError && !filteredAssetsHubEmployees.length && (
                    <tr>
                      <td colSpan={5}>
                        <div className="directory-empty-state">
                          <div className="empty-state-icon" aria-hidden="true">📁</div>
                          <p className="muted">No employees found for assets</p>
                        </div>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {view === 'employeeProfile' && (
            <div className="employee-profile-page">
              <div className="row between employee-profile-page-top">
                <div>
                  <h3>Employee Profile</h3>
                  <p className="muted small">Unified employee management dashboard</p>
                </div>
                <button type="button" className="ghost" onClick={() => navigate('/employees')}>Back to Employees</button>
              </div>

              {employeeProfileLoading && (
                <div className="table-loading-state">
                  <Loader2 size={16} className="hrms-spin" />
                  <p>Loading employee profile...</p>
                </div>
              )}
              {!!employeeProfileError && !employeeProfileLoading && <p className="error">{employeeProfileError}</p>}

              {!employeeProfileLoading && !employeeProfileError && employeeProfileData && (
                <div className="employee-profile-dashboard">
                  <section className="employee-profile-hero">
                    <div className="employee-profile-hero-main">
                      <div className="employee-profile-avatar xl">{initialsOf(employeeProfileData.name || employeeProfileData.login_id || 'E')}</div>
                      <div className="employee-profile-identity">
                        <div className="employee-profile-title-line">
                          <h2>{employeeProfileData.name || '-'}</h2>
                          <span className={`employee-status-pill ${employeeIsActive(employeeProfileData) ? 'active' : 'inactive'}`}>
                            <span className="employee-status-dot" aria-hidden="true" />
                            {employeeIsActive(employeeProfileData) ? 'Active' : 'Inactive'}
                          </span>
                        </div>
                        <p className="employee-profile-role-line">
                          {employeeProfileData.designation || employeeProfileData.role || 'Employee'} · {employeeProfileData.department || 'General'}
                        </p>
                        <div className="employee-profile-meta-grid">
                          <span><strong>ID</strong>{employeeProfileData.emp_id || employeeProfileData.login_id || employeeProfileData.id || '-'}</span>
                          <span><strong>Joined</strong>{formatEmployeeDate(employeeProfileData.date_of_joining || employeeProfileData.joining_date || employeeProfileData.created_at)}</span>
                          <span><strong>Company</strong>{employeeProfileData.company_name || '-'}</span>
                          <span><strong>Manager</strong>{employeeProfileData.reporting_manager || '-'}</span>
                        </div>
                      </div>
                    </div>
                    <div className="employee-profile-hero-actions">
                      <button type="button" className="ghost" onClick={() => editEmployee(employeeProfileData)}>
                        <Pencil size={15} />
                        Edit
                      </button>
                      <button type="button" className="ghost" onClick={() => generatePayslipForEmployee(employeeProfileData)}>
                        <FileText size={15} />
                        Payslip
                      </button>
                      <button type="button" className="ghost" onClick={() => openManualAttendanceModal(employeeProfileData)}>
                        <ClipboardCheck size={15} />
                        Attendance
                      </button>
                      <button type="button" className="danger" onClick={() => deleteEmployee(employeeProfileData)}>
                        <Trash2 size={15} />
                        Delete
                      </button>
                    </div>
                  </section>

                  {employeeProfileSupplementLoading && (
                    <div className="employee-profile-sync-note">
                      <Loader2 size={14} className="hrms-spin" />
                      <span>Syncing attendance, leave, payroll, and documents...</span>
                    </div>
                  )}

                  <section className="employee-quick-stats">
                    {[
                      { label: 'Present Days', value: employeeProfileInsights.presentDays ?? 0, hint: 'Last 30 days', icon: UserCheck, tone: 'green' },
                      { label: 'Leave Balance', value: `${employeeProfileLeaveStats.available.toFixed(employeeProfileLeaveStats.available % 1 ? 1 : 0)} d`, hint: `${employeeProfileLeaveStats.pending.toFixed(employeeProfileLeaveStats.pending % 1 ? 1 : 0)} pending`, icon: CalendarDays, tone: 'blue' },
                      { label: 'Current Salary', value: formatMoney(employeeProfileCurrentSalary), hint: String(employeeProfileSalaryData?.salaryType || employeeProfileData.salary_type || 'CTC_BASED').replace(/_/g, ' '), icon: FileText, tone: 'amber' },
                      { label: 'Overtime Hours', value: `${employeeProfileOvertimeHours} h`, hint: 'Above 8h/day', icon: Timer, tone: 'purple' },
                    ].map((card) => {
                      const Icon = card.icon
                      return (
                        <article key={card.label} className={`employee-profile-stat-card ${card.tone}`}>
                          <div className="employee-profile-stat-icon"><Icon size={18} /></div>
                          <p>{card.label}</p>
                          <strong>{card.value}</strong>
                          <span>{card.hint}</span>
                        </article>
                      )
                    })}
                  </section>

                  <section className="employee-profile-tabs hrms-tabs" role="tablist" aria-label="Employee profile sections">
                    {[
                      { key: 'overview', label: 'Overview' },
                      { key: 'attendance', label: 'Attendance' },
                      { key: 'leaves', label: 'Leaves' },
                      { key: 'payroll', label: 'Payroll' },
                      { key: 'documents', label: 'Documents' },
                      { key: 'activity', label: 'Activity Logs' },
                    ].map((tab) => (
                      <button
                        key={tab.key}
                        type="button"
                        role="tab"
                        className={employeeProfileTab === tab.key ? 'active' : ''}
                        aria-selected={employeeProfileTab === tab.key}
                        onClick={() => setEmployeeProfileTab(tab.key)}
                      >
                        {tab.label}
                      </button>
                    ))}
                  </section>

                  {employeeProfileTab === 'overview' && (
                    <section className="employee-profile-grid">
                      <article className="employee-profile-panel">
                        <h4>Employee Header</h4>
                        <div className="employee-profile-detail-list">
                          <p><span>Designation</span><strong>{employeeProfileData.designation || employeeProfileData.role || '-'}</strong></p>
                          <p><span>Department</span><strong>{employeeProfileData.department || 'General'}</strong></p>
                          <p><span>Employee ID</span><strong>{employeeProfileData.emp_id || employeeProfileData.login_id || employeeProfileData.id || '-'}</strong></p>
                          <p><span>Joining Date</span><strong>{formatEmployeeDate(employeeProfileData.date_of_joining || employeeProfileData.joining_date || employeeProfileData.created_at)}</strong></p>
                          <p><span>Employment Type</span><strong>{employeeProfileData.employment_type || '-'}</strong></p>
                        </div>
                      </article>
                      <article className="employee-profile-panel">
                        <h4>Contact & Personal</h4>
                        <div className="employee-profile-detail-list">
                          <p><span>Email</span><strong>{employeeProfileData.email || '-'}</strong></p>
                          <p><span>Mobile</span><strong>{employeeProfileData.mobile || employeeProfileData.phone || '-'}</strong></p>
                          <p><span>Blood Group</span><strong>{employeeProfileData.blood_group || '-'}</strong></p>
                          <p><span>Emergency Contact</span><strong>{employeeProfileData.emergency_contact_name || '-'} {employeeProfileData.emergency_contact_phone ? `· ${employeeProfileData.emergency_contact_phone}` : ''}</strong></p>
                          <p><span>Address</span><strong>{employeeProfileData.permanent_address || '-'}</strong></p>
                        </div>
                      </article>
                      <article className="employee-profile-panel wide">
                        <h4>Recent Signals</h4>
                        <div className="employee-profile-signal-grid">
                          <div>
                            <span>Last Attendance</span>
                            <strong>{employeeProfileInsights.lastAttendance?.date || '-'}</strong>
                            <p>{employeeProfileInsights.lastAttendance ? `${attendanceUiStatusLabel(employeeProfileInsights.lastAttendance)} · In ${employeeProfileInsights.lastAttendance.check_in || '-'} · Out ${employeeProfileInsights.lastAttendance.check_out || '-'}` : 'No attendance activity found.'}</p>
                          </div>
                          <div>
                            <span>Last Leave / Request</span>
                            <strong>{employeeProfileInsights.lastRequest ? requestStatusLabel(employeeProfileInsights.lastRequest) : '-'}</strong>
                            <p>{employeeProfileInsights.lastRequest ? `${requestTypeLabel(employeeProfileInsights.lastRequest)} · ${formatTimeAgo(employeeProfileInsights.lastRequest.updated_at || employeeProfileInsights.lastRequest.created_at || employeeProfileInsights.lastRequest.date)}` : 'No recent request activity.'}</p>
                          </div>
                          <div>
                            <span>Documents</span>
                            <strong>{employeeProfileDocuments.filter((row) => row.status === 'uploaded').length}/{employeeProfileDocuments.length}</strong>
                            <p>Core employee document checklist completion</p>
                          </div>
                        </div>
                      </article>
                    </section>
                  )}

                  {employeeProfileTab === 'attendance' && (
                    <section className="employee-profile-panel">
                      <div className="row between employee-profile-section-head">
                        <div>
                          <h4>Attendance</h4>
                          <p className="muted small">Monthly calendar, punch logs, late arrivals, and working hours</p>
                        </div>
                        <button type="button" className="ghost" onClick={() => openEmployeeAttendanceModal(employeeProfileData)}>Open Full History</button>
                      </div>
                      <div className="employee-attendance-summary-grid">
                        <article><span>Present</span><strong>{employeeProfileInsights.presentDays ?? 0}</strong></article>
                        <article><span>Late Arrivals</span><strong>{employeeProfileInsights.lateCount ?? 0}</strong></article>
                        <article><span>Total Hours</span><strong>{employeeProfileInsights.totalWorkHours ?? 0}</strong></article>
                        <article><span>Overtime</span><strong>{employeeProfileOvertimeHours}</strong></article>
                      </div>
                      <div className="employee-attendance-content">
                        <div className="employee-calendar-card">
                          <h5>Monthly Attendance Calendar</h5>
                          <div className="employee-calendar-grid">
                            {employeeProfileCalendarDays.map((day) => (
                              <div key={day.date} className={`employee-calendar-day ${day.status}`} title={`${day.date} ${day.label || ''}`}>
                                <strong>{day.day}</strong>
                                <span>{day.label || '-'}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="employee-late-card">
                          <h5>Late Arrivals</h5>
                          {employeeProfileAttendanceRows.filter((row) => String(resolveTimingStatus(row) || '').toLowerCase().includes('late')).slice(0, 8).map((row) => (
                            <div key={`late-${row.id || row.date}`} className="employee-mini-row">
                              <span>{row.date || '-'}</span>
                              <strong>{row.check_in || '-'}</strong>
                            </div>
                          ))}
                          {!employeeProfileAttendanceRows.some((row) => String(resolveTimingStatus(row) || '').toLowerCase().includes('late')) && <p className="muted small">No late arrivals in the loaded range.</p>}
                        </div>
                      </div>
                      <div className="directory-table-shell compact">
                        <table className="directory-table">
                          <thead>
                            <tr>
                              <th>Date</th>
                              <th>Status</th>
                              <th>Check In</th>
                              <th>Check Out</th>
                              <th>Working Hours</th>
                              <th>Timing</th>
                            </tr>
                          </thead>
                          <tbody>
                            {employeeProfileAttendanceRows.slice(0, 50).map((row) => (
                              <tr key={String(row?.id || `${row?.employee_id}-${row?.date}`)}>
                                <td>{row?.date || '-'}</td>
                                <td>{attendanceStatusLabel(row, row?.date)}</td>
                                <td>{row?.check_in || '-'}</td>
                                <td>{row?.check_out || '-'}</td>
                                <td>{formatWorkedHoursFromAttendanceRow(row)}</td>
                                <td>{resolveTimingStatus(row) || '-'}</td>
                              </tr>
                            ))}
                            {!employeeProfileAttendanceRows.length && (
                              <tr><td colSpan={6}><div className="directory-empty-state"><p className="muted">No attendance records found</p></div></td></tr>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </section>
                  )}

                  {employeeProfileTab === 'leaves' && (
                    <section className="employee-profile-grid">
                      <article className="employee-profile-panel">
                        <h4>Leave Balance</h4>
                        <div className="employee-leave-balance-grid">
                          {employeeProfileLeaveStats.items.map((item) => {
                            const unpaid = item.isPaidLeave === false
                            const d = (n) => Number(n || 0).toFixed(Number(n || 0) % 1 ? 1 : 0)
                            return (
                              <div
                                key={item.code}
                                className={`employee-leave-balance-card${unpaid ? ' employee-leave-balance-card--unpaid' : ''}`}
                              >
                                <span>{item.name}</span>
                                {unpaid ? (
                                  <>
                                    <strong>{d(item.used)} d</strong>
                                    <p className="muted small">
                                      {item.pending > 0
                                        ? `${d(item.pending)} unpaid pending approval`
                                        : 'Unpaid days — not part of paid leave balance'}
                                    </p>
                                  </>
                                ) : (
                                  <>
                                    <strong>{d(item.available)} d</strong>
                                    <p>{d(item.used)} used · {d(item.pending)} pending</p>
                                  </>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </article>
                      <article className="employee-profile-panel">
                        <h4>Leave Analytics</h4>
                        <div className="employee-attendance-summary-grid single">
                          <article><span>Total</span><strong>{employeeProfileLeaveStats.total}</strong></article>
                          <article><span>Used</span><strong>{employeeProfileLeaveStats.used}</strong></article>
                          <article><span>Pending</span><strong>{employeeProfileLeaveStats.pending}</strong></article>
                        </div>
                      </article>
                      <article className="employee-profile-panel wide">
                        <div className="row between employee-profile-section-head">
                          <h4>Leave History & Pending Requests</h4>
                          <span className="muted small">{employeeProfileLeaveRows.length} records</span>
                        </div>
                        <div className="directory-table-shell compact">
                          <table className="directory-table">
                            <thead>
                              <tr>
                                <th>Type</th>
                                <th>From</th>
                                <th>To</th>
                                <th>Days</th>
                                <th>Status</th>
                                <th>Reason</th>
                              </tr>
                            </thead>
                            <tbody>
                              {employeeProfileLeaveRows.map((row) => (
                                <tr key={String(row?.id || row?._id || `${row?.start_date || row?.date}-${row?.created_at}`)}>
                                  <td>{requestTypeLabel(row)}</td>
                                  <td>{row?.start_date || row?.from_date || row?.date || '-'}</td>
                                  <td>{row?.end_date || row?.to_date || row?.date || '-'}</td>
                                  <td>{leaveRequestDays(row)}</td>
                                  <td><span className={`employee-request-pill ${requestStatusKey(row)}`}>{requestStatusLabel(row)}</span></td>
                                  <td>{row?.reason || '-'}</td>
                                </tr>
                              ))}
                              {!employeeProfileLeaveRows.length && (
                                <tr><td colSpan={6}><div className="directory-empty-state"><p className="muted">No leave records found</p></div></td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </article>
                    </section>
                  )}

                  {employeeProfileTab === 'payroll' && (
                    <section className="employee-profile-grid">
                      <article className="employee-profile-panel">
                        <h4>Salary Structure</h4>
                        <div className="employee-profile-detail-list">
                          <p><span>Salary Type</span><strong>{String(employeeProfileSalaryData?.salaryType || employeeProfileData.salary_type || 'CTC_BASED').replace(/_/g, ' ')}</strong></p>
                          <p><span>Monthly Gross</span><strong>{formatMoney(employeeProfileSalaryData?.monthlySalary || employeeProfileData.monthly_salary || 0)}</strong></p>
                          <p><span>Net Target</span><strong>{formatMoney(employeeProfileSalaryData?.netTargetMonthly || employeeProfileData.net_target_monthly || 0)}</strong></p>
                        </div>
                      </article>
                      <article className="employee-profile-panel">
                        <h4>Deduction Structure</h4>
                        <div className="employee-profile-detail-list">
                          {(() => {
                            const structure = employeeProfileSalaryData?.structure || {}
                            return [
                              ['PF', structure.pfPct ?? structure.pfPercent ?? 12],
                              ['TDS', structure.tdsPct ?? structure.taxPercent ?? 0],
                              ['Advance', structure.advanceAmount ?? 0],
                              ['Other Deduction', structure.otherDeductionAmt ?? structure.manualDeduction ?? 0],
                            ].map(([label, value]) => (
                              <p key={label}><span>{label}</span><strong>{Number(value || 0)}{String(label).includes('Advance') || String(label).includes('Other') ? '' : '%'}</strong></p>
                            ))
                          })()}
                        </div>
                      </article>
                      <article className="employee-profile-panel wide">
                        <div className="row between employee-profile-section-head">
                          <div>
                            <h4>Generated Payslips & Monthly Payroll History</h4>
                            <p className="muted small">Downloadable PDF payslips from payroll runs</p>
                          </div>
                          <button type="button" className="ghost" onClick={() => generatePayslipForEmployee(employeeProfileData)}>Generate Payslip</button>
                        </div>
                        <div className="directory-table-shell compact">
                          <table className="directory-table">
                            <thead>
                              <tr>
                                <th>Month</th>
                                <th>Gross</th>
                                <th>Deductions</th>
                                <th>Net Pay</th>
                                <th>Status</th>
                                <th>PDF</th>
                              </tr>
                            </thead>
                            <tbody>
                              {employeeProfilePayslips.map((row) => (
                                <tr key={String(row?._id || row?.id || `${row?.year}-${row?.month}`)}>
                                  <td>{monthLabel(row?.year, row?.month)}</td>
                                  <td>{formatMoney(row?.gross_salary || 0)}</td>
                                  <td>{formatMoney(row?.total_deductions || 0)}</td>
                                  <td>{formatMoney(row?.net_salary || row?.net || 0)}</td>
                                  <td><span className={`employee-request-pill ${String(row?.status || 'generated').toLowerCase()}`}>{row?.status || 'generated'}</span></td>
                                  <td>
                                    <button type="button" className="ghost table-action-btn" onClick={() => downloadEmployeePayslipPdf(row)}>
                                      <Download size={14} />
                                      PDF
                                    </button>
                                  </td>
                                </tr>
                              ))}
                              {!employeeProfilePayslips.length && (
                                <tr><td colSpan={6}><div className="directory-empty-state"><p className="muted">No generated payslips found</p></div></td></tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </article>
                    </section>
                  )}

                  {employeeProfileTab === 'documents' && (
                    <section className="employee-profile-panel">
                      <div className="row between employee-profile-section-head">
                        <div>
                          <h4>Documents</h4>
                          <p className="muted small">Aadhaar, PAN, bank details, offer letter, certificates, and uploaded files</p>
                        </div>
                        <button type="button" className="ghost" onClick={openEmployeeAssetsUploadModal}>
                          <Upload size={15} />
                          Upload File
                        </button>
                      </div>
                      <div className="employee-document-grid">
                        {employeeProfileDocuments.map((doc) => (
                          <article key={doc.key} className={`employee-document-card ${doc.status}`}>
                            <div>
                              <FileText size={18} />
                              <strong>{doc.label}</strong>
                            </div>
                            <p>{doc.fileName || doc.detail || 'Not uploaded'}</p>
                            <span>{doc.status === 'uploaded' ? 'Available' : 'Missing'}</span>
                          </article>
                        ))}
                      </div>
                      <div className="row employee-assets-toolbar">
                        <div className="table-search-wrap employee-assets-search">
                          <Search size={14} className="table-search-icon" />
                          <input
                            className="table-search-with-icon"
                            placeholder="Search uploaded documents"
                            value={employeeAssetsSearch}
                            onChange={(e) => {
                              setEmployeeAssetsSearch(e.target.value)
                              setEmployeeAssetsPage(1)
                            }}
                          />
                        </div>
                        <button type="button" className="ghost" onClick={downloadAllEmployeeAssets} disabled={employeeAssetsDownloadingAll || !employeeAssetsTotal}>
                          <Download size={14} />
                          {employeeAssetsDownloadingAll ? 'Preparing ZIP...' : 'Download All'}
                        </button>
                      </div>
                      {employeeAssetsLoading && <div className="table-loading-state"><Loader2 size={16} className="hrms-spin" /><p>Loading documents...</p></div>}
                      {!!employeeAssetsError && !employeeAssetsLoading && <p className="error">{employeeAssetsError}</p>}
                      {!employeeAssetsLoading && !employeeAssetsError && !!filteredEmployeeAssets.length && (
                        <div className="employee-assets-grid compact">
                          {filteredEmployeeAssets.map((asset, index) => {
                            const type = String(asset?.file_type || 'document').toLowerCase()
                            const fileUrl = employeeAssetFileUrl(asset)
                            return (
                              <article key={String(asset?.id || `${asset?.file_name || 'asset'}-${index}`)} className="employee-asset-card">
                                <div className="employee-asset-preview" role="img" aria-label={String(asset?.file_name || 'Asset')}>
                                  {type === 'image' && !!fileUrl ? <img src={fileUrl} alt={String(asset?.file_name || 'Asset')} /> : <div className="employee-asset-preview-icon">{type === 'video' ? <Video size={20} /> : <FileText size={20} />}</div>}
                                </div>
                                <div className="employee-asset-meta">
                                  <p className="employee-asset-name" title={String(asset?.file_name || '')}>{asset?.file_name || '-'}</p>
                                  <div className={`employee-asset-type-badge ${assetTypeClass(type)}`}>{assetTypeLabel(type)}</div>
                                  <p className="muted small">{formatBytes(asset?.size)} · {formatAssetUploadDate(asset?.created_at)}</p>
                                </div>
                                <div className="employee-asset-actions">
                                  <button type="button" className="ghost" onClick={() => setEmployeeAssetPreviewModal({ open: true, asset })}><Eye size={14} />View</button>
                                  <button type="button" className="ghost" onClick={() => {
                                    const url = employeeAssetFileUrl(asset, { download: true })
                                    if (url) window.open(url, '_blank', 'noopener,noreferrer')
                                  }}><Download size={14} />Download</button>
                                  {canDeleteEmployeeAssets && <button type="button" className="danger" onClick={() => confirmDeleteEmployeeAsset(asset)}><Trash2 size={14} />Delete</button>}
                                </div>
                              </article>
                            )
                          })}
                        </div>
                      )}
                      {!employeeAssetsLoading && !employeeAssetsError && !filteredEmployeeAssets.length && (
                        <div className="directory-empty-state"><p className="muted">No uploaded documents found</p></div>
                      )}
                    </section>
                  )}

                  {employeeProfileTab === 'activity' && (
                    <section className="employee-profile-panel">
                      <h4>Activity Logs</h4>
                      <div className="employee-activity-list">
                        {employeeProfileActivityRows.map((row, index) => (
                          <article key={`${row.type}-${row.at}-${index}`} className="employee-activity-log-row">
                            <div className="employee-activity-dot" />
                            <div>
                              <strong>{row.type}</strong>
                              <p>{row.detail}</p>
                            </div>
                            <span>{row.at ? formatTimeAgo(row.at) : '-'}</span>
                          </article>
                        ))}
                        {!employeeProfileActivityRows.length && (
                          <div className="directory-empty-state"><p className="muted">No activity logs available</p></div>
                        )}
                      </div>
                    </section>
                  )}
                </div>
              )}

              {!employeeProfileLoading && !employeeProfileError && !employeeProfileData && (
                <div className="directory-empty-state">
                  <div className="empty-state-icon" aria-hidden="true">👤</div>
                  <p className="muted">No employee data available</p>
                </div>
              )}
            </div>
          )}

          {view === 'employeePayroll' && (
            <section className="card table-card attendance-module-card">
              <div className="attendance-module-topbar">
                <div>
                  <h3>Employee Payroll</h3>
                  <p className="muted small">Separate employee payroll menu for salary structure, preview, and payouts.</p>
                </div>
              </div>

              {/* ── Employee selector (company comes from global navbar switcher) ── */}
              {(() => {
                const allRealEmployees = Array.isArray(employees) ? employees : []
                const activeColor = selectedCompany?.color || '#7c3aed'
                const activeLabel = selectedCompany?.name || 'PR'
                const activeTagline = selectedCompany?.tagline || 'All Employees'

                return (
                  <>
                    {/* Company info banner — driven by global switcher, no local dropdown */}
                    <div style={{
                      display: 'flex', alignItems: 'center', gap: 0,
                      background: `${activeColor}08`,
                      border: `1.5px solid ${activeColor}30`,
                      borderRadius: 12, padding: '10px 18px', marginBottom: 14, overflow: 'hidden',
                    }}>
                      <div style={{
                        width: 38, height: 38, borderRadius: 9,
                        background: `${activeColor}20`, flexShrink: 0,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontWeight: 800, fontSize: '0.8rem', color: activeColor, marginRight: 12,
                      }}>
                        {activeLabel.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase()}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ fontWeight: 700, color: '#111827', fontSize: '0.92rem' }}>{activeLabel}</span>
                          <span style={{
                            background: `${activeColor}18`, color: activeColor,
                            border: `1px solid ${activeColor}40`, borderRadius: 99,
                            fontSize: '0.68rem', fontWeight: 700, padding: '1px 8px',
                          }}>● LIVE</span>
                        </div>
                        <div style={{ color: '#6b7280', fontSize: '0.75rem' }}>{activeTagline}</div>
                      </div>
                      {[
                        { label: 'Employees', value: allRealEmployees.length },
                        { label: 'Est. Payroll', value: allRealEmployees.length > 0 ? `₹${(allRealEmployees.length * 28000).toLocaleString('en-IN')}` : '—' },
                        { label: 'Avg Salary', value: '₹28,000' },
                      ].map((stat, i) => (
                        <div key={stat.label} style={{
                          textAlign: 'center', paddingLeft: 16, marginLeft: 16,
                          borderLeft: i === 0 ? `1px solid ${activeColor}25` : '1px solid #e5e7eb',
                        }}>
                          <div style={{ fontWeight: 700, color: activeColor, fontSize: '0.95rem' }}>{stat.value}</div>
                          <div style={{ color: '#9ca3af', fontSize: '0.68rem', marginTop: 1 }}>{stat.label}</div>
                        </div>
                      ))}
                      <div style={{ marginLeft: 20, fontSize: '0.72rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                        Switch company from <strong style={{ color: '#374151' }}>navbar ↑</strong>
                      </div>
                    </div>

                    {/* Employee selector */}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginBottom: 16, flexWrap: 'wrap' }}>
                      <div style={{ minWidth: 280, flex: 1 }}>
                        <label className="add-field-label" htmlFor="employee-payroll-select">Select Employee</label>
                        <select
                          id="employee-payroll-select"
                          className="add-employee-input"
                          value={String(employeePayrollSelectedEmployee?.id || employeePayrollSelectedEmployee?._id || '')}
                          onChange={e => setEmployeePayrollEmployeeId(e.target.value)}
                        >
                          <option value="">— Select Employee —</option>
                          {allRealEmployees.map(emp => {
                            const eid = String(emp?.id || emp?._id || '')
                            const label = [
                              String(emp?.name || emp?.login_id || eid),
                              emp?.designation ? `(${emp.designation})` : '',
                              emp?.department ? `· ${emp.department}` : '',
                            ].filter(Boolean).join(' ')
                            return <option key={eid} value={eid}>{label}</option>
                          })}
                        </select>
                      </div>
                      {allRealEmployees.length === 0 && (
                        <div style={{
                          padding: '8px 14px', borderRadius: 9, fontSize: '0.78rem',
                          background: '#fef3c7', color: '#92400e',
                          border: '1px solid #fcd34d', fontWeight: 600,
                          display: 'flex', alignItems: 'center', gap: 6, marginBottom: 1,
                        }}>
                          ⚠ No employees in <strong>{activeLabel}</strong> — add employees or switch company from navbar
                        </div>
                      )}
                    </div>

                    {/* ── Calculator / Placeholder ── */}
                    {employeePayrollSelectedEmployee
                      ? <EmployeePayrollCalculator employee={employeePayrollSelectedEmployee} token={token} company={selectedCompany} />
                      : (
                          <div className="directory-empty-state">
                            <div className="empty-state-icon" aria-hidden="true">💰</div>
                            <p className="muted">
                              Select an employee above to open the Salary Calculator.
                            </p>
                            {allRealEmployees.length > 0 && (
                              <p className="muted small" style={{ marginTop: 4, color: '#16a34a' }}>
                                ● {allRealEmployees.length} employee{allRealEmployees.length !== 1 ? 's' : ''} available
                              </p>
                            )}
                          </div>
                        )
                    }
                  </>
                )
              })()}
            </section>
          )}

          {view === 'logs' && (
            <section className={`card table-card attendance-module-card attendance-ops-workspace ${activeSidebarItem === 'attendance-exceptions' ? 'exceptions-ops-workspace' : ''}`}>
              <header className="attendance-ops-header">
                <div className="attendance-ops-heading-block">
                  <h3 className="attendance-ops-title">{activeSidebarItem === 'attendance-exceptions' ? 'Attendance compliance · exceptions' : 'All Records'}</h3>
                  <p className="muted small attendance-ops-sub">
                    {activeSidebarItem === 'attendance-exceptions'
                      ? 'Late arrivals, early exits, and repeat-risk patterns tied to attendance policy.'
                      : 'Operational ledger for check-ins, hours, exceptions, and approvals.'}
                  </p>
                  {activeSidebarItem !== 'attendance-exceptions' && (
                    <p className="muted small attendance-ops-range-hint">Date range follows the dashboard header controls.</p>
                  )}
                  {activeSidebarItem === 'attendance-exceptions' && (
                    <p className="muted small attendance-ops-range-hint">Loads from the dashboard date window ({dashboardRangeBounds.label}).</p>
                  )}
                </div>
                <div className="attendance-ops-header-right">
                  {activeSidebarItem !== 'attendance-exceptions' && (
                    <>
                      <div className="attendance-ops-view-switch" role="group" aria-label="View mode">
                        <button
                          type="button"
                          className={logsViewMode === 'daily' ? 'active' : ''}
                          onClick={() => {
                            setLogsViewMode('daily')
                            applyOverviewRange('today')
                          }}
                        >
                          Daily logs
                        </button>
                        <button
                          type="button"
                          className={logsViewMode === 'monthly' ? 'active' : ''}
                          onClick={() => {
                            setLogsViewMode('monthly')
                            applyOverviewRange('month')
                          }}
                        >
                          Monthly rollup
                        </button>
                      </div>
                      {liveTrackingOn && logsRangeFilter === 'today' && (
                        <span className="attendance-ops-live-pill" title="Refreshing attendance while you stay on Today">
                          <span className="attendance-ops-live-dot" aria-hidden />
                          Live tracking on
                        </span>
                      )}
                      <div className="attendance-ops-global-actions">
                        <button type="button" className="ghost attendance-ops-export-btn" onClick={() => handleLogsExport('csv')} disabled={!filteredAttendance.length || logsExporting === 'csv'}>
                          <Download size={15} />
                          {logsExporting === 'csv' ? '…' : 'CSV'}
                        </button>
                        <button type="button" className="ghost attendance-ops-export-btn" onClick={() => handleLogsExport('excel')} disabled={logsExporting === 'excel'}>
                          <FileSpreadsheet size={15} />
                          {logsExporting === 'excel' ? '…' : 'Excel'}
                        </button>
                        <button type="button" className="attendance-ops-mark-btn" onClick={openManualAttendanceModal}>Mark attendance</button>
                      </div>
                    </>
                  )}
                </div>
              </header>

              {activeSidebarItem === 'attendance-exceptions' && (
                <>
                  <div className="exceptions-ops-policy-strip">
                    <Info size={16} strokeWidth={2} className="exceptions-ops-policy-icon" aria-hidden />
                    <div className="exceptions-ops-policy-copy">
                      <span className="exceptions-ops-policy-title">Attendance policy</span>
                      <span className="exceptions-ops-policy-line">Late check-ins after 9:15 AM count toward violations. Repeated patterns may trigger warnings and half-day payroll actions.</span>
                    </div>
                    <button type="button" className="ghost exceptions-ops-policy-toggle" onClick={() => setExceptionsPolicyOpen((o) => !o)}>
                      {exceptionsPolicyOpen ? 'Less' : 'More'}
                    </button>
                  </div>
                  {exceptionsPolicyOpen && (
                    <p className="exceptions-ops-policy-detail muted small">
                      Use the queue below to notify employees, add audit notes, mark half-days, or close violations when corrective action is complete. Exports mirror the filtered list for compliance audits.
                    </p>
                  )}

                  <div className="exceptions-ops-metrics">
                    <article className="exceptions-ops-metric exceptions-ops-metric-late">
                      <p className="exceptions-ops-metric-label"><AlertTriangle size={13} aria-hidden strokeWidth={2} /> Late today</p>
                      <strong className="exceptions-ops-metric-value">{exceptionsSummary.lateToday}</strong>
                    </article>
                    <article className="exceptions-ops-metric exceptions-ops-metric-early">
                      <p className="exceptions-ops-metric-label"><Clock3 size={13} aria-hidden strokeWidth={2} /> Early exits today</p>
                      <strong className="exceptions-ops-metric-value">{exceptionsSummary.earlyExitsToday}</strong>
                    </article>
                    <article className="exceptions-ops-metric exceptions-ops-metric-repeat">
                      <p className="exceptions-ops-metric-label"><BellRing size={13} aria-hidden strokeWidth={2} /> Repeat risk</p>
                      <strong className="exceptions-ops-metric-value">{exceptionsSummary.repeatOffenders}</strong>
                      <span className="exceptions-ops-metric-sub muted">&nbsp;employees (5+ in 7d)</span>
                    </article>
                  </div>

                  {!!frequentOffenderAlerts.length && (
                    <div className="exceptions-ops-hot-strip" aria-label="Frequent offender highlights">
                      {frequentOffenderAlerts.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          className="exceptions-ops-hot-chip"
                          onClick={() => {
                            setLogsSearch(String(item.employeeName || '').trim())
                          }}
                          title={`Filter table to ${item.employeeName}`}
                        >
                          <span className="exceptions-ops-hot-name">{item.employeeName}</span>
                          <span className="exceptions-ops-hot-meta">{item.countLast7} in 7 days</span>
                        </button>
                      ))}
                    </div>
                  )}

                  <div className="exceptions-ops-toolbar">
                    <div className="exceptions-ops-toolbar-left">
                      <label className="exceptions-ops-field exceptions-ops-search">
                        <Search size={14} aria-hidden />
                        <input
                          type="search"
                          placeholder="Search employee, department, notes…"
                          value={logsSearch}
                          onChange={(e) => setLogsSearch(e.target.value)}
                          aria-label="Search exceptions"
                        />
                      </label>
                      <label className="exceptions-ops-field">
                        <span className="exceptions-ops-field-label">Department</span>
                        <select value={logsDeptFilter} onChange={(e) => setLogsDeptFilter(e.target.value)}>
                          <option value="all">All</option>
                          {logsDeptOptions.map((dept) => (
                            <option key={dept} value={dept}>{dept}</option>
                          ))}
                        </select>
                      </label>
                      <label className="exceptions-ops-field">
                        <span className="exceptions-ops-field-label">Exception type</span>
                        <select value={exceptionTypeFilter} onChange={(e) => setExceptionTypeFilter(e.target.value)}>
                          <option value="both">Late &amp; early exit</option>
                          <option value="late">Late only</option>
                          <option value="early_exit">Early exit only</option>
                        </select>
                      </label>
                    </div>
                    <div className="exceptions-ops-toolbar-right">
                      <button
                        type="button"
                        className="ghost exceptions-ops-tb-btn"
                        onClick={() => {
                          applyOverviewRange('week')
                          setLogsSearch('')
                          setLogsDeptFilter('all')
                          setExceptionTypeFilter('both')
                        }}
                      >
                        <RotateCcw size={14} />
                        Reset
                      </button>
                      <button type="button" className="ghost exceptions-ops-tb-btn" onClick={() => handleExceptionsExport('csv')} disabled={!filteredExceptionRows.length || exceptionsExporting === 'csv'}>
                        <Download size={14} />
                        {exceptionsExporting === 'csv' ? '…' : 'CSV'}
                      </button>
                      <button type="button" className="ghost exceptions-ops-tb-btn" onClick={() => handleExceptionsExport('excel')} disabled={!filteredExceptionRows.length || exceptionsExporting === 'excel'}>
                        <FileSpreadsheet size={14} />
                        {exceptionsExporting === 'excel' ? '…' : 'Excel'}
                      </button>
                    </div>
                  </div>

                  {hasSelectedExceptions && (
                    <div className="attendance-bulk-bar attendance-bulk-bar-sticky exceptions-bulk-bar exceptions-ops-bulk-bar">
                      <label className="exceptions-ops-bulk-select">
                        <input
                          type="checkbox"
                          checked={allVisibleExceptionSelected}
                          onChange={(e) => toggleSelectAllVisibleExceptions(e.target.checked)}
                          aria-label="Select all visible exceptions"
                        />
                        <span>
                          <strong>{selectedExceptionKeys.length}</strong>
                          <span className="exceptions-ops-bulk-meta"> selected · visible {visibleExceptionKeys.length}</span>
                        </span>
                      </label>
                      <div className="attendance-bulk-actions">
                        <button type="button" className="table-action-btn exceptions-ops-bulk-warn" onClick={bulkWarnExceptions} disabled={bulkWarningSending}>
                          {bulkWarningSending ? 'Sending…' : 'Notify selected'}
                        </button>
                        <button type="button" className="table-action-btn ghost" onClick={bulkMarkHalfDayExceptions}>Mark half day</button>
                      </div>
                    </div>
                  )}

                  <div className="attendance-table-wrap exceptions-table-wrap exceptions-ops-table-scroll">
                    <table className="attendance-table exceptions-table exceptions-ops-table">
                      <thead>
                        <tr>
                          <th className="exceptions-ops-col-check">
                            <input
                              type="checkbox"
                              checked={allVisibleExceptionSelected}
                              onChange={(e) => toggleSelectAllVisibleExceptions(e.target.checked)}
                              aria-label="Select all exceptions"
                            />
                          </th>
                          <th><span className="exceptions-th">Employee</span></th>
                          <th><span className="exceptions-th">Department</span></th>
                          <th><span className="exceptions-th">Shift window</span></th>
                          <th><span className="exceptions-th">Actual check-in / out</span></th>
                          <th><span className="exceptions-th">Variance</span></th>
                          <th><span className="exceptions-th">Type</span></th>
                          <th><span className="exceptions-th">Repeat (7d)</span></th>
                          <th><span className="exceptions-th">Status</span></th>
                          <th><span className="exceptions-th">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {loading && (
                          <tr>
                            <td colSpan={10}>
                              <div className="table-loading-state">
                                <Loader2 size={16} className="hrms-spin" />
                                <p>Loading violations…</p>
                              </div>
                            </td>
                          </tr>
                        )}
                        {!loading && pagedExceptionRows.map((item) => {
                          const isHalfDayMarked = exceptionHalfDayKeys.includes(item.key)
                          const isResolvedMarked = exceptionResolvedKeys.includes(item.key)
                          const isSelected = selectedExceptionKeys.includes(item.key)
                          const warningSending = !!warningSendingByKey[item.key]
                          const workflow = exceptionWorkflowStatus(item)
                          const checkInFmt = item.checkIn && item.checkIn !== '-' ? formatTime12Hour(item.checkIn) : '—'
                          const checkOutFmt = item.checkOut && item.checkOut !== '-' ? formatTime12Hour(item.checkOut) : '—'
                          return (
                            <tr key={item.key} className={`exceptions-ops-row exception-row-${item.statusKey}`}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => toggleSelectExceptionRow(item.key, e.target.checked)}
                                  aria-label={`Select exception for ${item.employeeName}`}
                                />
                              </td>
                              <td>
                                <div className="attendance-employee-cell exceptions-ops-emp">
                                  <div className="attendance-employee-avatar exceptions-ops-avatar">{initialsOf(item.employeeName)}</div>
                                  <div>
                                    <div className="exceptions-ops-emp-name">{item.employeeName}</div>
                                    {item.countLast7 >= 3 && (
                                      <span className="exceptions-ops-repeat-chip">{item.countLast7} late/early tags · 7d</span>
                                    )}
                                    {item.streakDays >= 3 && (
                                      <span className="exceptions-ops-streak-chip">{item.streakDays}-day streak</span>
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="exceptions-ops-td-muted">{item.department}</td>
                              <td className="exceptions-ops-td-muted">{item.expectedShiftTime}</td>
                              <td className="exceptions-ops-times">
                                <div><span className="exceptions-ops-ts-label">In</span> {checkInFmt}</div>
                                <div><span className="exceptions-ops-ts-label">Out</span> {checkOutFmt}</div>
                              </td>
                              <td className="exceptions-ops-variance">{item.duration}</td>
                              <td>
                                <span className={`exceptions-type-badge exceptions-ops-type ${item.exceptionType}`}>{exceptionTypeLabel(item.exceptionType)}</span>
                              </td>
                              <td>
                                <div className="exceptions-ops-count-main">{item.countLast7}</div>
                                <div className="exceptions-ops-risk-line muted">{item.statusLabel}</div>
                              </td>
                              <td>
                                <span className={`exceptions-workflow-pill wf-${workflow.key}`}>{workflow.label}</span>
                                <div className="exceptions-ops-wf-meta muted small">Warned ×{item.warningCount}</div>
                                {isHalfDayMarked && <div className="exceptions-ops-wf-meta muted small">Half day flagged</div>}
                              </td>
                              <td>
                                <div className="exceptions-ops-actions" onClick={(evt) => evt.stopPropagation()}>
                                  <button type="button" className="ghost exceptions-ops-act" onClick={() => openAttendanceDetailModal(item.row)}>View</button>
                                  <button type="button" className="ghost exceptions-ops-act" disabled={isResolvedMarked} onClick={() => markExceptionResolved(item)}>{isResolvedMarked ? 'Resolved' : 'Resolve'}</button>
                                  <button type="button" className="ghost exceptions-ops-act" onClick={() => openExceptionNoteModal(item)}>Note</button>
                                  <button
                                    type="button"
                                    className="ghost exceptions-ops-act exceptions-ops-act-notify"
                                    disabled={warningSending || bulkWarningSending || !item.employeeId}
                                    onClick={() => warnEmployeeForException(item)}
                                  >
                                    {warningSending ? '…' : 'Notify'}
                                  </button>
                                  <div className="directory-actions-menu-wrap">
                                    <button
                                      type="button"
                                      className="ghost exceptions-ops-act directory-menu-trigger"
                                      aria-label="More exception actions"
                                      onClick={(evt) => {
                                        evt.stopPropagation()
                                        setExceptionActionMenuId((old) => (old === item.key ? '' : item.key))
                                      }}
                                    >
                                      <MoreVertical size={14} />
                                    </button>
                                    {exceptionActionMenuId === item.key && (
                                      <div className="directory-actions-menu">
                                        <button type="button" className="ghost" onClick={() => { setExceptionActionMenuId(''); openWarningHistory(item) }}>Warning history</button>
                                        <button type="button" className="ghost" disabled={isHalfDayMarked} onClick={() => { setExceptionActionMenuId(''); markExceptionHalfDay(item) }}>
                                          {isHalfDayMarked ? 'Half day marked' : 'Mark half day'}
                                        </button>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                        {!loading && !pagedExceptionRows.length && (
                          <tr>
                            <td colSpan={10}>
                              <div className="exceptions-ops-empty">
                                <ShieldCheck size={36} strokeWidth={1.15} className="exceptions-ops-empty-icon" aria-hidden />
                                <p className="exceptions-ops-empty-title">No attendance violations in this slice</p>
                                <p className="muted small exceptions-ops-empty-copy">Employees are compliant for the filters and dashboard date window, or violations sit outside loaded attendance. Adjust the header range or filters to widen the sweep.</p>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="attendance-pagination exceptions-ops-pagination">
                    <p className="muted small">
                      Showing {Math.min((logsPage - 1) * ATTENDANCE_PAGE_SIZE + 1, filteredExceptionRows.length || 0)}–
                      {Math.min(logsPage * ATTENDANCE_PAGE_SIZE, filteredExceptionRows.length)} of {filteredExceptionRows.length}
                    </p>
                    <div className="row">
                      <button type="button" className="ghost" disabled={logsPage <= 1} onClick={() => setLogsPage((prev) => Math.max(1, prev - 1))}>Previous</button>
                      <span className="muted small">Page {logsPage} / {exceptionTotalPages}</span>
                      <button type="button" className="ghost" disabled={logsPage >= exceptionTotalPages} onClick={() => setLogsPage((prev) => Math.min(exceptionTotalPages, prev + 1))}>Next</button>
                    </div>
                  </div>
                </>
              )}

              {activeSidebarItem !== 'attendance-exceptions' && (
                <>
                  <div className="logs-summary-cards attendance-ops-metrics">
                    <article className="logs-summary-card attendance-ops-metric attendance-ops-metric-neutral">
                      <p className="logs-summary-label">Records</p>
                      <strong className="logs-summary-value">{attendanceModuleSummary.total ?? '—'}</strong>
                    </article>
                    <button type="button" className={`logs-summary-card attendance-ops-metric attendance-ops-metric-present ${logsStatusFilter === 'present' ? 'active' : ''}`} onClick={() => setLogsStatusFilter(logsStatusFilter === 'present' ? 'all' : 'present')}>
                      <p className="logs-summary-label">Present</p>
                      <strong className="logs-summary-value">{attendanceModuleSummary.present ?? '—'}</strong>
                    </button>
                    <button type="button" className={`logs-summary-card attendance-ops-metric attendance-ops-metric-late ${logsStatusFilter === 'late' ? 'active' : ''}`} onClick={() => setLogsStatusFilter(logsStatusFilter === 'late' ? 'all' : 'late')}>
                      <p className="logs-summary-label">Late</p>
                      <strong className="logs-summary-value">{attendanceModuleSummary.late ?? '—'}</strong>
                    </button>
                    <button type="button" className={`logs-summary-card attendance-ops-metric attendance-ops-metric-absent ${logsStatusFilter === 'absent' ? 'active' : ''}`} onClick={() => setLogsStatusFilter(logsStatusFilter === 'absent' ? 'all' : 'absent')}>
                      <p className="logs-summary-label">Absent</p>
                      <strong className="logs-summary-value">{attendanceModuleSummary.absent ?? '—'}</strong>
                    </button>
                    <button type="button" className={`logs-summary-card attendance-ops-metric attendance-ops-metric-half ${logsStatusFilter === 'half_day' ? 'active' : ''}`} onClick={() => setLogsStatusFilter(logsStatusFilter === 'half_day' ? 'all' : 'half_day')}>
                      <p className="logs-summary-label">Half day</p>
                      <strong className="logs-summary-value">{attendanceModuleSummary.halfDay ?? '—'}</strong>
                    </button>
                    <button type="button" className={`logs-summary-card attendance-ops-metric attendance-ops-metric-wfh ${logsStatusFilter === 'wfh' ? 'active' : ''}`} onClick={() => setLogsStatusFilter(logsStatusFilter === 'wfh' ? 'all' : 'wfh')}>
                      <p className="logs-summary-label">WFH</p>
                      <strong className="logs-summary-value">{attendanceModuleSummary.wfh ?? '—'}</strong>
                    </button>
                  </div>

                  <div className="attendance-ops-toolbar">
                    <div className="attendance-ops-toolbar-main">
                      <div className="attendance-ops-quick-row" role="group" aria-label="Quick status filters">
                        {[
                          { id: 'all', label: 'All' },
                          { id: 'present', label: 'Present' },
                          { id: 'late', label: 'Late' },
                          { id: 'absent', label: 'Absent' },
                          { id: 'leave', label: 'Leave' },
                          { id: 'wfh', label: 'WFH' },
                          { id: 'half_day', label: 'Half day' },
                          { id: 'holiday', label: 'Holiday' },
                        ].map((chip) => (
                          <button
                            key={chip.id}
                            type="button"
                            className={`attendance-ops-qf ${logsStatusFilter === chip.id ? 'active' : ''}`}
                            onClick={() => setLogsStatusFilter(chip.id === logsStatusFilter ? 'all' : chip.id)}
                          >
                            {chip.label}
                          </button>
                        ))}
                      </div>
                      <label className="attendance-ops-search">
                        <Search size={14} />
                        <input
                          type="search"
                          placeholder="Search employee, ID, note…"
                          value={logsSearch}
                          onChange={(e) => setLogsSearch(e.target.value)}
                          aria-label="Search attendance records"
                        />
                      </label>
                    </div>
                    <div className="attendance-ops-toolbar-actions">
                      <button type="button" className={`ghost attendance-ops-filter-toggle ${logsAdvancedFiltersOpen ? 'active' : ''}`} onClick={() => setLogsAdvancedFiltersOpen((old) => !old)}>
                        <Filter size={14} />
                        Advanced
                      </button>
                      <button
                        type="button"
                        className="ghost attendance-ops-reset"
                        onClick={() => {
                          applyOverviewRange('today')
                          setLogsSearch('')
                          setLogsStatusFilter('all')
                          setLogsDeptFilter('all')
                          setLogsShiftFilter('all')
                        }}
                      >
                        <RotateCcw size={14} />
                        Reset
                      </button>
                    </div>
                  </div>
                  {logsAdvancedFiltersOpen && (
                    <div className="attendance-ops-advanced-panel">
                      <label className="attendance-filter-field">
                        <span>Department</span>
                        <select value={logsDeptFilter} onChange={(e) => setLogsDeptFilter(e.target.value)}>
                          <option value="all">All Departments</option>
                          {logsDeptOptions.map((dept) => (
                            <option key={dept} value={dept}>{dept}</option>
                          ))}
                        </select>
                      </label>
                      <label className="attendance-filter-field">
                        <span>Shift</span>
                        <select value={logsShiftFilter} onChange={(e) => setLogsShiftFilter(e.target.value)}>
                          <option value="all">All Shifts</option>
                          {logsShiftOptions.map((shift) => (
                            <option key={shift} value={shift}>{shift}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  {!!hasSelectedAttendance && (
                  <div className="attendance-bulk-bar attendance-bulk-bar-sticky attendance-ops-bulk-bar">
                    <label className="attendance-select-all">
                      <input
                        type="checkbox"
                        checked={allVisibleAttendanceSelected}
                        onChange={(e) => toggleSelectAllAttendanceRows(e.target.checked)}
                        aria-label="Select all visible attendance records"
                      />
                      {selectedAttendanceIds.length} selected · visible {paginatedAttendance.length}
                    </label>
                    <div className="attendance-bulk-actions">
                      <button
                        type="button"
                        className="ghost attendance-ops-bulk-btn"
                        disabled={!hasSelectedAttendance}
                        onClick={bulkMarkSelectedAttendance}
                      >
                        <Check size={14} />
                        Mark present
                      </button>
                      <button
                        type="button"
                        className="ghost attendance-ops-bulk-btn"
                        disabled={!hasSelectedAttendance}
                        onClick={bulkApproveSelectedAttendanceRequests}
                      >
                        Approve pending
                      </button>
                      <button
                        type="button"
                        className="ghost attendance-ops-bulk-btn"
                        disabled={!hasSelectedAttendance}
                        onClick={bulkExportSelectedAttendance}
                      >
                        <Download size={14} />
                        Export
                      </button>
                      <button
                        type="button"
                        className="ghost attendance-ops-bulk-btn"
                        disabled={!hasSelectedAttendance}
                        onClick={bulkAddRemarkAttendance}
                      >
                        <Pencil size={14} />
                        Add remark
                      </button>
                      <button
                        type="button"
                        className="ghost attendance-ops-bulk-btn"
                        disabled={!hasSelectedAttendance}
                        onClick={bulkMarkLeaveNavigation}
                      >
                        Mark leave…
                      </button>
                    </div>
                  </div>
                  )}

                  <div className="attendance-table-wrap attendance-ops-table-scroll">
                    <table className="attendance-table attendance-table-upgraded attendance-ops-table">
                      <thead>
                        <tr>
                          <th className="attendance-ops-col-sel"><span className="attendance-th-label">Sel</span></th>
                          <th>
                            <button type="button" className="attendance-th-sort" onClick={() => toggleLogsSort('employee_name')}>
                              Employee
                              <span className="table-sort-arrows" aria-hidden="true">{logsSort.key === 'employee_name' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                            </button>
                          </th>
                          <th>
                            <button type="button" className="attendance-th-sort" onClick={() => toggleLogsSort('department')}>
                              Department
                              <span className="table-sort-arrows" aria-hidden="true">{logsSort.key === 'department' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                            </button>
                          </th>
                          <th>
                            <button type="button" className="attendance-th-sort" onClick={() => toggleLogsSort('shift_label')}>
                              Shift
                              <span className="table-sort-arrows" aria-hidden="true">{logsSort.key === 'shift_label' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                            </button>
                          </th>
                          <th>
                            <button type="button" className="attendance-th-sort" onClick={() => toggleLogsSort('check_in')}>
                              Check In
                              <span className="table-sort-arrows" aria-hidden="true">{logsSort.key === 'check_in' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                            </button>
                          </th>
                          <th>
                            <button type="button" className="attendance-th-sort" onClick={() => toggleLogsSort('check_out')}>
                              Check Out
                              <span className="table-sort-arrows" aria-hidden="true">{logsSort.key === 'check_out' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                            </button>
                          </th>
                          <th>
                            <button type="button" className="attendance-th-sort" onClick={() => toggleLogsSort('worked_minutes')}>
                              Work Hours
                              <span className="table-sort-arrows" aria-hidden="true">{logsSort.key === 'worked_minutes' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                            </button>
                          </th>
                          <th><span className="attendance-th-static">Late By</span></th>
                          <th><span className="attendance-th-static">Overtime</span></th>
                          <th>
                            <button type="button" className="attendance-th-sort" onClick={() => toggleLogsSort('status')}>
                              Status
                              <span className="table-sort-arrows" aria-hidden="true">{logsSort.key === 'status' ? (logsSort.direction === 'asc' ? '↑' : '↓') : '↕'}</span>
                            </button>
                          </th>
                          <th><span className="attendance-th-static">Mode</span></th>
                          <th><span className="attendance-th-static">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {loading && (
                          <tr>
                            <td colSpan={12}>
                              <div className="table-loading-state">
                                <Loader2 size={16} className="hrms-spin" />
                                <p>Loading attendance…</p>
                              </div>
                            </td>
                          </tr>
                        )}
                        {!loading && pagedAttendance.map(({ row: a, absoluteIndex }) => {
                          const rowKey = attendanceRowKey(a, absoluteIndex)
                          const meta = getAttendanceEmployeeMeta(a)
                          const deptLabel = meta.department || a.department || '—'
                          const uiStatus = attendanceUiStatusKey(a)
                          const timingStatus = String(resolveTimingStatus(a) || '').trim()
                          const request = requestPendingByAttendanceKey[rowKey]
                          const isSelected = selectedAttendanceIds.includes(rowKey)
                          const isExpanded = logsExpandedRows.includes(rowKey)
                          const employeeLabel = String(a.employee_name || 'Unknown')
                          const isWfh = attendanceRowIsWfh(a)
                          const statusBadgeKey = isWfh ? 'wfh' : uiStatus
                          const statusPhrase = isWfh ? 'WFH' : (
                            uiStatus === 'present' ? 'Present' : uiStatus === 'late' ? 'Late' : uiStatus === 'absent' ? 'Absent'
                              : uiStatus === 'half_day' ? 'Half day' : uiStatus === 'leave' ? 'Leave' : uiStatus === 'holiday' ? 'Holiday' : attendanceUiStatusLabel(a)
                          )
                          const ci = a.check_in ? formatTime12Hour(a.check_in) : '—'
                          const co = a.check_out ? formatTime12Hour(a.check_out) : '—'
                          const shiftLabelRow = inferShiftLabel(a)
                          const workedText = attendanceUiStatusKey(a) === 'holiday' ? '—' : formatWorkedHoursFromAttendanceRow(a)
                          const rowClassName = [
                            'attendance-ops-row',
                            isSelected ? 'attendance-row-selected' : '',
                            (uiStatus === 'late' || uiStatus === 'absent' || !!request) ? 'has-attention' : '',
                          ].filter(Boolean).join(' ')
                          return (
                            <Fragment key={rowKey}>
                              <tr className={rowClassName}>
                              <td>
                                <input
                                  type="checkbox"
                                  checked={isSelected}
                                  onChange={(e) => toggleSelectAttendanceRow(rowKey, e.target.checked)}
                                  aria-label={`Select attendance record for ${employeeLabel}`}
                                />
                              </td>
                              <td>
                                <div className="attendance-employee-cell attendance-ops-emp">
                                  <div className="attendance-employee-avatar attendance-ops-avatar">{initialsOf(employeeLabel)}</div>
                                  <div>
                                    <div className="attendance-ops-emp-name">{employeeLabel}</div>
                                    <div className="attendance-ops-emp-meta">{a.employee_id || meta.employeeId || '—'} · {a.date || date || ''}</div>
                                  </div>
                                </div>
                              </td>
                              <td className="attendance-ops-muted">{deptLabel}</td>
                              <td className="attendance-ops-muted">{shiftLabelRow || '—'}</td>
                              <td className="attendance-ops-time">{ci}</td>
                              <td className="attendance-ops-time">{co}</td>
                              <td className="attendance-ops-strong">{workedText}</td>
                              <td className="attendance-ops-muted-sm">{formatLateByForRow(a)}</td>
                              <td className="attendance-ops-muted-sm">{formatOvertimeForRow(a)}</td>
                              <td>
                                <span className={`attendance-ops-pill attendance-ops-pill-status status-${statusBadgeKey}`}>{statusPhrase}</span>
                                {!!request && <span className="attendance-ops-pill attendance-ops-pill-pending">Pending</span>}
                              </td>
                              <td>
                                <span className={`attendance-ops-pill attendance-ops-pill-mode ${a.manual_entry ? 'manual' : isWfh ? 'wfh' : 'office'}`}>
                                  {isWfh ? 'WFH' : (a.manual_entry ? 'Manual' : 'Geo / auto')}
                                </span>
                              </td>
                              <td>
                                <div className="attendance-ops-actions">
                                  <button type="button" className="table-action-btn attendance-ops-icon-btn" onClick={() => toggleLogsExpandedRow(rowKey)} title={isExpanded ? 'Collapse row' : 'Expand row'} aria-label={isExpanded ? 'Collapse' : 'Expand'}>
                                    {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                                  </button>
                                  <button type="button" className="table-action-btn attendance-ops-icon-btn" onClick={() => openAttendanceDetailModal(a)} aria-label="View details"><Eye size={14} /></button>
                                  <button type="button" className="table-action-btn attendance-ops-icon-btn" onClick={() => openEditAttendanceFromRecord(a)} aria-label="Edit"><Pencil size={14} /></button>
                                  {!!request && (
                                    <>
                                      <button type="button" className="table-action-btn request-approve-btn" onClick={() => confirmManualRequestAction('approve', request.id)}>Approve</button>
                                      <button type="button" className="table-action-btn danger" onClick={() => reject(request.id)}>Reject</button>
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="attendance-expand-row">
                                <td colSpan={12}>
                                  <div className="attendance-expand-panel attendance-ops-expand">
                                    <p><strong>Timing signal:</strong> {timingStatus || '—'} · <strong>Work mode:</strong> {isWfh ? 'Work from home' : (a.manual_entry ? 'Manual entry' : 'Automatic capture')}</p>
                                    <p><strong>Note:</strong> {a.manual_reason || 'None'} · <strong>Captured on:</strong> {a.clock_date || a.date || '—'}</p>
                                  </div>
                                </td>
                              </tr>
                            )}
                            </Fragment>
                          )
                        })}
                        {!loading && !paginatedAttendance.length && (
                          <tr>
                            <td colSpan={12}>
                              <div className="logs-empty-state attendance-ops-empty">
                                <ClipboardCheck size={32} strokeWidth={1.25} className="attendance-ops-empty-icon" aria-hidden />
                                <p className="attendance-ops-empty-title">No attendance records for this window</p>
                                <p className="muted small attendance-ops-empty-copy">Broaden the range in the header, clear filters with Reset, or use Mark attendance for manual stamps.</p>
                                <button type="button" className="ghost attendance-ops-empty-cta" onClick={() => applyOverviewRange('week')}>Show last 7 days</button>
                              </div>
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {logsTotalPages > 1 && (
                  <div className="attendance-pagination">
                    <p className="muted small">
                      Showing {Math.min((logsPage - 1) * ATTENDANCE_PAGE_SIZE + 1, sortedFilteredAttendance.length || 0)}-
                      {Math.min(logsPage * ATTENDANCE_PAGE_SIZE, sortedFilteredAttendance.length)} of {sortedFilteredAttendance.length}
                    </p>
                    <div className="row">
                      <button type="button" className="ghost" disabled={logsPage <= 1} onClick={() => setLogsPage((prev) => Math.max(1, prev - 1))}>
                        Previous
                      </button>
                      <span className="muted small">Page {logsPage} / {logsTotalPages}</span>
                      <button
                        type="button"
                        className="ghost"
                        disabled={logsPage >= logsTotalPages}
                        onClick={() => setLogsPage((prev) => Math.min(logsTotalPages, prev + 1))}
                      >
                        Next
                      </button>
                    </div>
                  </div>
                  )}
                </>
              )}

              {exceptionNoteModal.open && (
                <div className="modal-overlay" onClick={() => setExceptionNoteModal({ open: false, key: '', row: null, note: '' })}>
                  <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
                    <h3>Add Exception Note</h3>
                    <p className="muted">{exceptionNoteModal?.row?.employeeName || 'Employee'} · {exceptionNoteModal?.row?.department || 'General'}</p>
                    <div className="stack">
                      <textarea
                        rows={4}
                        placeholder="Add internal HR note"
                        value={exceptionNoteModal.note}
                        onChange={(e) => setExceptionNoteModal((old) => ({ ...old, note: e.target.value }))}
                      />
                    </div>
                    <div className="row modal-actions confirm-modal-actions">
                      <button type="button" className="ghost" onClick={() => setExceptionNoteModal({ open: false, key: '', row: null, note: '' })}>Cancel</button>
                      <button type="button" onClick={saveExceptionNote}>Save Note</button>
                    </div>
                  </div>
                </div>
              )}

              {attendanceDetailModal?.open && (
                <div className="modal-overlay" role="presentation" onClick={() => setAttendanceDetailModal({ open: false, row: null, requestId: '' })}>
                  <div className="modal-card attendance-detail-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
                    <div className="row between modal-header">
                      <h4>Attendance Details</h4>
                      <button type="button" className="ghost" onClick={() => setAttendanceDetailModal({ open: false, row: null, requestId: '' })}>
                        <X size={16} />
                      </button>
                    </div>
                    <div className="attendance-detail-grid">
                      <p><strong>Employee:</strong> {attendanceDetailModal?.row?.employee_name || '-'}</p>
                      <p><strong>Employee ID:</strong> {attendanceDetailModal?.row?.employee_id || '-'}</p>
                      <p><strong>Department:</strong> {attendanceDetailModal?.row?.department || '-'}</p>
                      <p><strong>Date:</strong> {attendanceDetailModal?.row?.clock_date || attendanceDetailModal?.row?.date || '-'}</p>
                      <p><strong>Check In:</strong> {attendanceDetailModal?.row?.check_in || '-'}</p>
                      <p><strong>Check Out:</strong> {attendanceDetailModal?.row?.check_out || '-'}</p>
                      <p><strong>Total Work:</strong> {formatWorkedHoursFromAttendanceRow(attendanceDetailModal?.row)}</p>
                      <p><strong>Status:</strong> {attendanceUiStatusLabel(attendanceDetailModal?.row)}</p>
                      <p><strong>Mode:</strong> {attendanceDetailModal?.row?.manual_entry ? 'Manual Entry' : 'Automatic Scan'}</p>
                      <p><strong>Reason:</strong> {attendanceDetailModal?.row?.manual_reason || '-'}</p>
                    </div>
                  </div>
                </div>
              )}
            </section>
          )}

          {view === 'requests' && (
            <section className="card table-card requests-workflow-card requests-ops-workspace">
              <header className="requests-ops-header">
                <div className="requests-ops-heading">
                  <h3 className="requests-ops-title">Requests &amp; approvals</h3>
                  <p className="muted small requests-ops-lead">
                    Operational queue for leave, attendance corrections, reimbursements, and policy conflicts.
                  </p>
                  <p className="requests-ops-range-hint muted small">
                    Date window follows the dashboard header ({dashboardRangeBounds.label}). Refine filters below.
                  </p>
                </div>
              </header>

              <div className="requests-ops-tabs" role="tablist" aria-label="Request approval status">
                <button
                  type="button"
                  role="tab"
                  aria-selected={manualStatusFilter === ''}
                  className={`requests-ops-tab ${manualStatusFilter === '' ? 'active' : ''} requests-ops-tab--all`}
                  onClick={() => setManualStatusFilter('')}
                >
                  <span>All</span>
                  <span className="requests-ops-tab-count">{requestsWorkspaceKpis.all}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={manualStatusFilter === 'pending'}
                  className={`requests-ops-tab ${manualStatusFilter === 'pending' ? 'active' : ''} requests-ops-tab--pending`}
                  onClick={() => setManualStatusFilter('pending')}
                >
                  <span>Pending</span>
                  <span className="requests-ops-tab-count">{requestsWorkspaceKpis.pending}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={manualStatusFilter === 'approved'}
                  className={`requests-ops-tab ${manualStatusFilter === 'approved' ? 'active' : ''} requests-ops-tab--approved`}
                  onClick={() => setManualStatusFilter('approved')}
                >
                  <span>Approved</span>
                  <span className="requests-ops-tab-count">{requestsWorkspaceKpis.approved}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={manualStatusFilter === 'rejected'}
                  className={`requests-ops-tab ${manualStatusFilter === 'rejected' ? 'active' : ''} requests-ops-tab--rejected`}
                  onClick={() => setManualStatusFilter('rejected')}
                >
                  <span>Rejected</span>
                  <span className="requests-ops-tab-count">{requestsWorkspaceKpis.rejected}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={manualStatusFilter === 'conflict'}
                  className={`requests-ops-tab ${manualStatusFilter === 'conflict' ? 'active' : ''} requests-ops-tab--conflict`}
                  onClick={() => setManualStatusFilter('conflict')}
                >
                  <span>Conflict</span>
                  <span className="requests-ops-tab-count">{requestsWorkspaceKpis.conflict}</span>
                </button>
              </div>

              <div className="requests-ops-metrics">
                <article className="requests-ops-metric requests-ops-metric-pending">
                  <p className="requests-ops-metric-label"><AlertCircle size={13} strokeWidth={2} aria-hidden /> Pending</p>
                  <strong className="requests-ops-metric-value">{requestsWorkspaceKpis.pending}</strong>
                </article>
                <article className="requests-ops-metric requests-ops-metric-approved">
                  <p className="requests-ops-metric-label"><CheckCircle2 size={13} strokeWidth={2} aria-hidden /> Approved</p>
                  <strong className="requests-ops-metric-value">{requestsWorkspaceKpis.approved}</strong>
                </article>
                <article className="requests-ops-metric requests-ops-metric-rejected">
                  <p className="requests-ops-metric-label"><X size={13} strokeWidth={2} aria-hidden /> Rejected</p>
                  <strong className="requests-ops-metric-value">{requestsWorkspaceKpis.rejected}</strong>
                </article>
                <article className="requests-ops-metric requests-ops-metric-conflict">
                  <p className="requests-ops-metric-label"><AlertCircle size={13} strokeWidth={2} aria-hidden /> Conflict</p>
                  <strong className="requests-ops-metric-value">{requestsWorkspaceKpis.conflict}</strong>
                </article>
                <article className="requests-ops-metric requests-ops-metric-neutral">
                  <p className="requests-ops-metric-label"><Clock3 size={13} strokeWidth={2} aria-hidden /> Avg approval</p>
                  <strong className="requests-ops-metric-value">{requestsWorkspaceKpis.avgApprovalHours}</strong>
                  <span className="requests-ops-metric-sub muted">Decline rate {requestsWorkspaceKpis.rejectionRate}</span>
                </article>
                {leaveAnalytics?.usage_by_type?.slice(0, 2).map((usage) => (
                  <article key={usage._id} className="requests-ops-metric requests-ops-metric-neutral">
                    <p className="requests-ops-metric-label"><CalendarDays size={13} strokeWidth={2} aria-hidden /> {usage._id}</p>
                    <strong className="requests-ops-metric-value">{usage.total_days}d</strong>
                    <span className="requests-ops-metric-sub muted">Approved leave</span>
                  </article>
                ))}
              </div>

              <div className="requests-ops-toolbar">
                <div className="requests-ops-toolbar-left">
                  <label className="requests-ops-field requests-ops-search">
                    <Search size={14} aria-hidden />
                    <input
                      type="search"
                      placeholder="Search employee, reason, note…"
                      value={requestsSearch}
                      onChange={(e) => setRequestsSearch(e.target.value)}
                      aria-label="Search requests"
                    />
                  </label>
                  <label className="requests-ops-field">
                    <span className="requests-ops-field-label">Type</span>
                    <select value={requestsTypeFilter} onChange={(e) => setRequestsTypeFilter(e.target.value)}>
                      {requestTypeOptions.map((type) => (
                        <option key={type.key} value={type.key}>{type.label}</option>
                      ))}
                    </select>
                  </label>
                  <label className="requests-ops-field">
                    <span className="requests-ops-field-label">Department</span>
                    <select value={requestsDeptFilter} onChange={(e) => setRequestsDeptFilter(e.target.value)}>
                      <option value="all">All</option>
                      {requestsDepartmentOptions.filter((x) => x !== 'all').map((dept) => (
                        <option key={dept} value={dept}>{dept}</option>
                      ))}
                    </select>
                  </label>
                  <label className="requests-ops-field">
                    <span className="requests-ops-field-label">Priority</span>
                    <select value={requestsPriorityFilter} onChange={(e) => setRequestsPriorityFilter(e.target.value)}>
                      <option value="all">All</option>
                      <option value="urgent">Urgent</option>
                      <option value="medium">Medium</option>
                      <option value="normal">Normal</option>
                    </select>
                  </label>
                </div>
                <div className="requests-ops-toolbar-right">
                  <button type="button" className="ghost requests-ops-tool-btn" onClick={() => setRequestsViewMode((old) => (old === 'table' ? 'calendar' : 'table'))}>
                    <CalendarDays size={14} />
                    {requestsViewMode === 'table' ? 'Calendar' : 'Table'}
                  </button>
                  <button type="button" className="ghost requests-ops-tool-btn" onClick={exportRequestsCsv}>
                    <Download size={14} />
                    Export
                  </button>
                  <button type="button" className="ghost requests-ops-tool-btn" onClick={loadAll}>
                    <RotateCcw size={14} />
                    Refresh
                  </button>
                </div>
              </div>

              {showRequestSelection && (
                <div className="attendance-bulk-bar requests-bulk-bar requests-ops-bulk-bar">
                  <label className="requests-ops-bulk-select">
                    <input
                      type="checkbox"
                      className="requests-select-checkbox"
                      checked={allVisibleRequestsSelected}
                      onChange={toggleSelectAllVisibleRequests}
                      aria-label="Select all visible requests"
                    />
                    <span>
                      <strong>{selectedRequestIds.length}</strong> selected
                      <span className="requests-ops-bulk-meta"> · visible {visibleRequestIds.length}</span>
                    </span>
                  </label>
                  <div className="attendance-bulk-actions requests-ops-bulk-actions">
                    <button
                      type="button"
                      className="table-action-btn request-approve-btn requests-ops-bulk-primary"
                      disabled={!selectedRequestIds.length}
                      onClick={approveSelectedRequests}
                    >
                      <Check size={14} />
                      Approve
                    </button>
                    <button
                      type="button"
                      className="table-action-btn request-reject-btn"
                      disabled={!selectedRequestIds.length}
                      onClick={rejectSelectedRequests}
                    >
                      <X size={14} />
                      Reject
                    </button>
                    <button
                      type="button"
                      className="ghost requests-ops-bulk-secondary"
                      disabled
                      title="Route reviewers through your HR policy or ticketing — not wired in this module."
                    >
                      <UserCheck size={14} />
                      Assign reviewer
                    </button>
                  </div>
                </div>
              )}

              {requestsViewMode === 'calendar' ? (
                <div className="requests-ops-calendar task-calendar-grid">
                  {paginatedManualRequests.map((r) => {
                    const status = requestStatusKey(r)
                    return (
                      <article key={r.id} className="task-calendar-card" onClick={() => setRequestDetailsModal({ open: true, request: r })}>
                        <p className="task-calendar-date">{requestDateKey(r) || '-'}</p>
                        <strong>{r.employee_name || '-'}</strong>
                        <p className="muted small">{requestTypeLabel(r)} {r.num_days ? `(${r.num_days}d)` : ''}</p>
                        <p className={`request-status-badge ${status}`} style={{ marginTop: 'auto', alignSelf: 'flex-start' }}>{requestStatusLabel(r)}</p>
                      </article>
                    )
                  })}
                  {!paginatedManualRequests.length && <p className="muted small requests-ops-calendar-empty">No requests in this view for the current filters.</p>}
                </div>
              ) : (
                <div className="requests-table-wrap requests-ops-table-scroll">
                  <table className="manual-requests-table requests-table-upgraded requests-ops-table">
                    <thead>
                      <tr>
                        {showRequestSelection && (
                          <th className="requests-ops-col-check">
                            <input
                              type="checkbox"
                              className="requests-select-checkbox"
                              checked={allVisibleRequestsSelected}
                              onChange={toggleSelectAllVisibleRequests}
                              aria-label="Select all requests"
                            />
                          </th>
                        )}
                        <th><span className="requests-th">Employee</span></th>
                        <th><span className="requests-th">Department</span></th>
                        <th><span className="requests-th">Request type</span></th>
                        <th><span className="requests-th">Duration</span></th>
                        <th><span className="requests-th">Priority</span></th>
                        <th><span className="requests-th">Requested dates</span></th>
                        <th><span className="requests-th">Reason</span></th>
                        <th><span className="requests-th">Status</span></th>
                        <th><span className="requests-th">Actions</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {loading && (
                        <tr>
                          <td colSpan={showRequestSelection ? 10 : 9}>
                            <div className="table-loading-state">
                              <Loader2 size={16} className="hrms-spin" />
                              <p>Loading requests…</p>
                            </div>
                          </td>
                        </tr>
                      )}
                      {!loading && paginatedManualRequests.map((r) => {
                        const status = requestStatusKey(r)
                        const priority = requestPriorityKey(r)
                        const employeeMeta = requestEmployeeMeta(r)
                        const reasonText = String(r.reason || '—').trim()
                        const displayReason = reasonText.length > 72 ? `${reasonText.slice(0, 72)}…` : reasonText
                        const conflictReason = requestConflictReason(r)
                        const submittedAt = r.requested_at || r.created_at || r.applied_at
                        const rowClasses = [
                          'requests-ops-row',
                          status === 'pending' ? 'manual-request-row-pending' : '',
                          status === 'rejected' ? 'manual-request-row-rejected' : '',
                          status === 'conflict' ? 'manual-request-row-conflict' : '',
                        ].filter(Boolean).join(' ')
                        return (
                          <tr key={r.id} className={rowClasses}>
                            {showRequestSelection && (
                              <td>
                                <input
                                  type="checkbox"
                                  className="requests-select-checkbox"
                                  checked={selectedRequestIds.includes(r.id)}
                                  onChange={() => toggleRequestSelection(r.id)}
                                  aria-label={`Select request of ${r.employee_name || 'employee'}`}
                                />
                              </td>
                            )}
                            <td>
                              <div className="attendance-employee-cell requests-ops-employee">
                                <div className="attendance-employee-avatar requests-ops-avatar">{initialsOf(r.employee_name)}</div>
                                <div>
                                  <div className="requests-ops-emp-name">{r.employee_name || '—'}</div>
                                  {status === 'pending' && <span className="requests-ops-emp-flag">Needs review</span>}
                                </div>
                              </div>
                            </td>
                            <td className="requests-ops-td-muted">
                              <div>{employeeMeta.department}</div>
                              <div className="requests-ops-td-sub">{employeeMeta.role}</div>
                            </td>
                            <td>
                              <span className="requests-type-pill requests-ops-type-pill">{requestTypeLabel(r)}</span>
                            </td>
                            <td className="requests-ops-td-strong">
                              {r.num_days ? `${r.num_days}d` : '—'}
                            </td>
                            <td>
                              <span className={`request-priority-badge requests-ops-priority ${priority}`} title={`Priority: ${requestPriorityLabel(r)}`}>
                                {requestPriorityLabel(r)}
                              </span>
                            </td>
                            <td>
                              <div className="requests-ops-date-main">{requestDateKey(r) || '—'}</div>
                              {submittedAt && (
                                <div className="requests-ops-date-sub">
                                  {dateKeyInIST(submittedAt)} · {formatTimeInIST(submittedAt)}
                                </div>
                              )}
                            </td>
                            <td className="requests-ops-reason" title={reasonText}>{displayReason}</td>
                            <td>
                              <span className={`request-status-badge requests-ops-status ${status}`}>{requestStatusLabel(r)}</span>
                              {!!conflictReason && <p className="requests-inline-note requests-ops-note">Conflict: {conflictReason}</p>}
                              {!!requestRejectionNote(r) && <p className="requests-inline-note requests-ops-note">Note: {requestRejectionNote(r)}</p>}
                              {!!r.auto_lop && <p className="requests-inline-note requests-ops-note">LOP ({r.lop_days}d)</p>}
                            </td>
                            <td className="row compact manual-request-actions requests-ops-actions">
                              {status === 'pending' && (
                                <button className="table-action-btn request-approve-btn" title="Approve request" onClick={() => confirmManualRequestAction('approve', r.id)}>Approve</button>
                              )}
                              {status === 'approved' && isReimbursementRequest(r) && (
                                <button
                                  type="button"
                                  className="table-action-btn request-paid-btn"
                                  title="Release reimbursement payment"
                                  onClick={() => markRequestPaid(r.id)}
                                >
                                  Mark paid
                                </button>
                              )}
                              {(status === 'pending' || status === 'conflict') && (
                                <button className="table-action-btn request-reject-btn" title="Reject request" onClick={() => confirmManualRequestAction('reject', r.id)}>Reject</button>
                              )}
                              <button
                                type="button"
                                className="ghost table-action-btn requests-ops-icon-btn"
                                onClick={() => setRequestDetailsModal({ open: true, request: r })}
                              >
                                <Eye size={14} />
                                View
                              </button>
                            </td>
                          </tr>
                        )
                      })}
                      {!loading && !paginatedManualRequests.length && (
                        <tr>
                          <td colSpan={showRequestSelection ? 10 : 9}>
                            <div className="requests-ops-empty">
                              <ClipboardList size={36} strokeWidth={1.25} className="requests-ops-empty-icon" aria-hidden />
                              <p className="requests-ops-empty-title">No requests in this slice</p>
                              <p className="muted small requests-ops-empty-copy">
                                Nothing matches the status tab and filters for the current dashboard date window. Adjust the header range, clear filters, or refresh after new submissions.
                              </p>
                              <button type="button" className="ghost requests-ops-empty-cta" onClick={loadAll}>Refresh data</button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="attendance-pagination requests-ops-pagination">
                <p className="muted small">
                  Showing {Math.min((requestsPage - 1) * REQUESTS_PAGE_SIZE + 1, filteredManualRequests.length || 0)}–
                  {Math.min(requestsPage * REQUESTS_PAGE_SIZE, filteredManualRequests.length)} of {filteredManualRequests.length}
                </p>
                <div className="row">
                  <button type="button" className="ghost" disabled={requestsPage <= 1} onClick={() => setRequestsPage((old) => Math.max(1, old - 1))}>Previous</button>
                  <span className="muted small">Page {requestsPage} / {requestsTotalPages}</span>
                  <button type="button" className="ghost" disabled={requestsPage >= requestsTotalPages} onClick={() => setRequestsPage((old) => Math.min(requestsTotalPages, old + 1))}>Next</button>
                </div>
              </div>
            </section>
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

          {(view === 'accountProfile' || view === 'accountChangePassword' || view === 'accountSecurity') && (
            <AccountPage
              token={token}
              section={view === 'accountChangePassword' ? 'change-password' : (view === 'accountSecurity' ? 'security' : 'profile')}
              onFlash={flash}
              onProfileNameUpdated={(nextName) => {
                const next = String(nextName || '').trim()
                if (next) setUsername(next)
              }}
              onAdminTokenRefresh={(newToken) => {
                const next = String(newToken || '').trim()
                if (!next) return
                localStorage.setItem(ADMIN_KEY, next)
                setToken(next)
              }}
            />
          )}

          {view === 'bulkPayroll' && (
            <BulkPayrollRun
              token={token}
              companies={companies}
              selectedCompanyId={selectedCompanyId}
              employees={employees}
            />
          )}

          {view === 'settings' && (
            <div className="cards2">
              {!!settingsFeedback.text && (
                <div className={`${settingsFeedback.type === 'success' ? 'success' : 'error'} settings-feedback-full`}>{settingsFeedback.text}</div>
              )}
              <p className="muted small settings-last-updated">Last updated: {settingsLastUpdatedLabel}</p>
              {activeSidebarItem === 'settings-policies' ? (
                <AttendancePolicyEngine />
              ) : (
                <form className="card form settings-card" onSubmit={saveGeofenceSettings}>
                  <h3>Geofence Settings</h3>
                  {selectedCompany?.name ? (
                    <p className="muted small settings-help" style={{ marginBottom: 12 }}>
                      These values apply to employees of <strong>{selectedCompany.name}</strong> only.
                      Use the company switcher in the header to edit geofence for another company.
                    </p>
                  ) : (
                    <p className="muted small settings-help" style={{ marginBottom: 12 }}>
                      Select a company in the header to configure office geofence per company.
                    </p>
                  )}
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
              )}
            </div>
          )}
        </section>
      </div>
      {employeeAssetsUploadModal.open && (
        <div className="modal-overlay" onClick={closeEmployeeAssetsUploadModal}>
          <div className="modal-card employee-assets-upload-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Upload File</h3>
            <p className="muted small">Files will be linked to this employee automatically.</p>
            <p className="muted small">Supported: JPG, PNG, MP4, PDF, DOCX (max 10 MB each)</p>

            <div
              className={`employee-assets-dropzone ${employeeAssetsUploadModal.dragActive ? 'active' : ''}`}
              onDragOver={(e) => {
                e.preventDefault()
                setEmployeeAssetsUploadModal((old) => ({ ...old, dragActive: true }))
              }}
              onDragLeave={(e) => {
                e.preventDefault()
                setEmployeeAssetsUploadModal((old) => ({ ...old, dragActive: false }))
              }}
              onDrop={(e) => {
                e.preventDefault()
                setEmployeeAssetsUploadModal((old) => ({ ...old, dragActive: false }))
                const files = Array.from(e.dataTransfer?.files || [])
                appendFilesToUploadModal(files)
              }}
            >
              <Upload size={18} />
              <p>Drag & drop files here</p>
              <p className="muted small">or choose files from your system</p>
              <input
                type="file"
                multiple
                accept={ASSET_INPUT_ACCEPT}
                onChange={(e) => {
                  appendFilesToUploadModal(Array.from(e.target.files || []))
                  e.target.value = ''
                }}
              />
            </div>

            {!!employeeAssetsUploadModal.rejected?.length && (
              <div className="employee-assets-upload-rejected">
                {(employeeAssetsUploadModal.rejected || []).slice(-4).map((row, index) => (
                  <p key={`${row.fileName}-${index}`} className="muted small">
                    {row.fileName}: {row.reason}
                  </p>
                ))}
              </div>
            )}

            {!!employeeAssetsUploadModal.files.length && (
              <div className="employee-assets-upload-list">
                {employeeAssetsUploadModal.files.map((row) => (
                  <div key={row.id} className="employee-assets-upload-row">
                    <div className="row compact">
                      {row.fileType === 'image' && row.previewUrl && (
                        <img src={row.previewUrl} alt={row.fileName} className="employee-assets-upload-thumb" />
                      )}
                      {row.fileType === 'video' && row.previewUrl && (
                        <video src={row.previewUrl} className="employee-assets-upload-thumb" muted />
                      )}
                      {row.fileType === 'image' && row.previewUrl && <ImageIcon size={14} />}
                      {row.fileType === 'video' && <Video size={14} />}
                      {row.fileType === 'document' && <FileText size={14} />}
                      <span>{row.fileName}</span>
                    </div>
                    <div className="row compact">
                      <span className="muted small">{formatBytes(row.size)}</span>
                      <button type="button" className="ghost" onClick={() => removeAssetDraftRow(row.id)}>Remove</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {employeeAssetsUploadModal.uploading && (
              <div className="employee-assets-upload-progress">
                <div className="employee-assets-upload-progress-top">
                  <span className="muted small">
                    Uploading {employeeAssetsUploadModal.uploadedCount}/{employeeAssetsUploadModal.totalCount || employeeAssetsUploadModal.files.length}
                  </span>
                  <span className="muted small">{employeeAssetsUploadModal.progressPercent}%</span>
                </div>
                <div className="employee-assets-upload-progress-track">
                  <div className="employee-assets-upload-progress-fill" style={{ width: `${employeeAssetsUploadModal.progressPercent}%` }} />
                </div>
                {!!employeeAssetsUploadModal.currentFileName && <p className="muted small">Current: {employeeAssetsUploadModal.currentFileName}</p>}
              </div>
            )}

            <div className="row modal-actions">
              <button type="button" className="ghost" onClick={closeEmployeeAssetsUploadModal} disabled={employeeAssetsUploadModal.uploading}>
                Cancel
              </button>
              <button type="button" onClick={submitEmployeeAssetsUpload} disabled={employeeAssetsUploadModal.uploading || !employeeAssetsUploadModal.files.length}>
                {employeeAssetsUploadModal.uploading ? 'Uploading...' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}

      {employeeAssetPreviewModal.open && !!employeeAssetPreviewModal.asset && (
        <div className="modal-overlay" onClick={() => setEmployeeAssetPreviewModal({ open: false, asset: null })}>
          <div className="modal-card employee-assets-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>{String(employeeAssetPreviewModal.asset?.file_name || 'Asset Preview')}</h3>
              <button type="button" className="ghost" onClick={() => setEmployeeAssetPreviewModal({ open: false, asset: null })}>
                <X size={14} />
              </button>
            </div>
            <div className="employee-assets-preview-info">
              <span className={`employee-asset-type-badge ${assetTypeClass(employeeAssetPreviewModal.asset?.file_type)}`}>
                {assetTypeLabel(employeeAssetPreviewModal.asset?.file_type)}
              </span>
              <span className="muted small">{formatBytes(employeeAssetPreviewModal.asset?.size)}</span>
              <span className="muted small">Uploaded {formatAssetUploadDate(employeeAssetPreviewModal.asset?.created_at)}</span>
              <span className="muted small">By {String(employeeAssetPreviewModal.asset?.uploaded_by || 'admin')}</span>
            </div>
            <div className="employee-assets-preview-body">
              {String(employeeAssetPreviewModal.asset?.file_type || '').toLowerCase() === 'image' && (
                <img
                  src={employeeAssetFileUrl(employeeAssetPreviewModal.asset)}
                  alt={String(employeeAssetPreviewModal.asset?.file_name || 'Asset')}
                  className="employee-assets-preview-image"
                />
              )}
              {String(employeeAssetPreviewModal.asset?.file_type || '').toLowerCase() === 'video' && (
                <video
                  src={employeeAssetFileUrl(employeeAssetPreviewModal.asset)}
                  controls
                  className="employee-assets-preview-video"
                />
              )}
              {!['image', 'video'].includes(String(employeeAssetPreviewModal.asset?.file_type || '').toLowerCase()) && (
                <div className="employee-assets-preview-document">
                  <FileText size={28} />
                  <p className="muted">Preview is not available for this document type.</p>
                </div>
              )}
            </div>
            <div className="row modal-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  const url = employeeAssetFileUrl(employeeAssetPreviewModal.asset)
                  if (url) window.open(url, '_blank', 'noopener,noreferrer')
                }}
              >
                Open
              </button>
              <button
                type="button"
                onClick={() => {
                  const url = employeeAssetFileUrl(employeeAssetPreviewModal.asset, { download: true })
                  if (url) window.open(url, '_blank', 'noopener,noreferrer')
                }}
              >
                Download
              </button>
            </div>
          </div>
        </div>
      )}

      {employeeAssetRenameModal.open && !!employeeAssetRenameModal.asset && (
        <div className="modal-overlay" onClick={() => setEmployeeAssetRenameModal({ open: false, asset: null, fileName: '', saving: false })}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Rename File</h3>
            <p className="muted small">Update file name while keeping file type unchanged.</p>
            <label className="muted small">File Name</label>
            <input
              type="text"
              value={employeeAssetRenameModal.fileName}
              onChange={(e) => setEmployeeAssetRenameModal((old) => ({ ...old, fileName: e.target.value }))}
              placeholder="Enter new file name"
              disabled={employeeAssetRenameModal.saving}
            />
            <div className="row modal-actions">
              <button
                type="button"
                className="ghost"
                onClick={() => setEmployeeAssetRenameModal({ open: false, asset: null, fileName: '', saving: false })}
                disabled={employeeAssetRenameModal.saving}
              >
                Cancel
              </button>
              <button type="button" onClick={renameEmployeeAsset} disabled={employeeAssetRenameModal.saving}>
                {employeeAssetRenameModal.saving ? 'Renaming...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {warningHistoryModal.open && (
        <div className="modal-overlay" onClick={() => setWarningHistoryModal({ open: false, employeeId: '', employeeName: '', loading: false, error: '', rows: [] })}>
          <div className="modal-card employee-tasks-modal-card" style={{ maxWidth: 680 }} onClick={(e) => e.stopPropagation()}>
            <div className="row between" style={{ alignItems: 'center' }}>
              <h3>Warning History · {warningHistoryModal.employeeName || 'Employee'}</h3>
              <button
                type="button"
                className="ghost"
                onClick={() => setWarningHistoryModal({ open: false, employeeId: '', employeeName: '', loading: false, error: '', rows: [] })}
              >
                Close
              </button>
            </div>
            {warningHistoryModal.loading && <p className="muted">Loading warning history...</p>}
            {!!warningHistoryModal.error && <p className="text-danger">{warningHistoryModal.error}</p>}
            {!warningHistoryModal.loading && !warningHistoryModal.error && !warningHistoryModal.rows.length && (
              <p className="muted">No warnings found for this employee.</p>
            )}
            {!warningHistoryModal.loading && !!warningHistoryModal.rows.length && (
              <div className="task-list-table-wrap" style={{ marginTop: 8, maxHeight: '52vh', overflowY: 'auto' }}>
                <table className="attendance-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Reason</th>
                      <th>Late Count</th>
                      <th>Latest Delay</th>
                    </tr>
                  </thead>
                  <tbody>
                    {warningHistoryModal.rows.map((row) => (
                      <tr key={String(row?.id || `${row?.created_at || ''}-${row?.reason || ''}`)}>
                        <td>{warningCreatedAtLabel(row?.created_at)}</td>
                        <td>{String(row?.reason || '-')}</td>
                        <td>{Number(row?.late_count || 0)}</td>
                        <td>{Number(row?.latest_delay || 0)} min</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

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
              <button type="button" className="ghost" onClick={exportEmployeeAttendanceExcel} disabled={employeeAttendanceModal.loading || !(employeeAttendanceModal.rows || []).length}>
                Export Excel
              </button>
              <button type="button" className="ghost" onClick={printEmployeeAttendanceHistory} disabled={employeeAttendanceModal.loading || !(employeeAttendanceModal.rows || []).length}>
                Print PDF
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
                      {(() => {
                        const statusKey = attendanceStatusKey(a, a.date)
                        const timing = statusKey === 'holiday' ? '-' : String(resolveTimingStatus(a) || '-')
                        const worked = statusKey === 'holiday' ? '-' : formatWorkedHoursFromAttendanceRow(a)
                        const mode = statusKey === 'holiday' ? '-' : (a.manual_entry ? 'MANUAL' : 'AUTO')
                        return (
                          <>
                            <td>{a.date || '-'}</td>
                            <td>{formatWeekdayFromDateKey(a.date)}</td>
                            <td>{a.check_in || '-'}</td>
                            <td>{a.check_out || '-'}</td>
                            <td>{worked}</td>
                            <td>{timing}</td>
                            <td>{attendanceStatusLabel(a, a.date)}</td>
                            <td>{mode}</td>
                            <td>{a.manual_reason || '-'}</td>
                          </>
                        )
                      })()}
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
          <div className="modal-card request-details-modal-card request-workflow-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Request Detail</h3>
            <div className="request-details-grid">
              <p><strong>Employee:</strong> {requestDetailsModal.request?.employee_name || '-'}</p>
              <p><strong>Department:</strong> {requestEmployeeMeta(requestDetailsModal.request).department}</p>
              <p><strong>Role:</strong> {requestEmployeeMeta(requestDetailsModal.request).role}</p>
              <p><strong>Request Type:</strong> {requestTypeLabel(requestDetailsModal.request)}</p>
              <p><strong>Priority:</strong> <span className={`request-priority-badge ${requestPriorityKey(requestDetailsModal.request)}`}>{requestPriorityLabel(requestDetailsModal.request)}</span></p>
              <p><strong>Date:</strong> {requestDateKey(requestDetailsModal.request) || '-'}</p>
              <p><strong>Status:</strong> <span className={`request-status-badge ${requestStatusKey(requestDetailsModal.request)}`}>{requestStatusLabel(requestDetailsModal.request)}</span></p>
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
              <p className="request-detail-reason"><strong>Reason:</strong> {requestDetailsModal.request?.reason || '-'}</p>
              {!!requestConflictReason(requestDetailsModal.request) && (
                <p className="request-detail-reason"><strong>Conflict Reason:</strong> {requestConflictReason(requestDetailsModal.request)}</p>
              )}
              {!!requestRejectionNote(requestDetailsModal.request) && (
                <p className="request-detail-reason"><strong>Rejection Note:</strong> {requestRejectionNote(requestDetailsModal.request)}</p>
              )}
              <p><strong>Supporting Documents:</strong> {requestDetailsModal.request?.document_url ? 'Available' : 'No attachments'}</p>
            </div>

            <div className="request-history-panel">
              <h4>Request History</h4>
              <div className="request-history-list">
                <div className="request-history-item">
                  <strong>Requested</strong>
                  <p>{requestDetailsModal.request?.requested_at || requestDetailsModal.request?.created_at ? `${dateKeyInIST(requestDetailsModal.request?.requested_at || requestDetailsModal.request?.created_at)} ${formatTimeInIST(requestDetailsModal.request?.requested_at || requestDetailsModal.request?.created_at)}` : '-'}</p>
                </div>
                <div className="request-history-item">
                  <strong>Last Updated</strong>
                  <p>{requestDetailsModal.request?.updated_at ? `${dateKeyInIST(requestDetailsModal.request?.updated_at)} ${formatTimeInIST(requestDetailsModal.request?.updated_at)}` : '-'}</p>
                </div>
                <div className="request-history-item">
                  <strong>Final Decision</strong>
                  <p>{requestStatusLabel(requestDetailsModal.request)}{requestDetailsModal.request?.approved_at ? ` · ${dateKeyInIST(requestDetailsModal.request?.approved_at)} ${formatTimeInIST(requestDetailsModal.request?.approved_at)}` : ''}</p>
                </div>
              </div>
            </div>

            <div className="request-timeline">
              <h4>Workflow Timeline</h4>
              <div className="request-timeline-item done">
                <span className="request-timeline-dot" />
                <div>
                  <strong>Submitted</strong>
                  <p>{requestDetailsModal.request?.created_at ? `${dateKeyInIST(requestDetailsModal.request?.created_at)} ${formatTimeInIST(requestDetailsModal.request?.created_at)}` : '-'}</p>
                </div>
              </div>
              <div className={`request-timeline-item ${requestStatusKey(requestDetailsModal.request) !== 'pending' ? 'done' : 'pending'}`}>
                <span className="request-timeline-dot" />
                <div>
                  <strong>Reviewed</strong>
                  <p>{requestStatusKey(requestDetailsModal.request) === 'pending' ? 'Awaiting review by admin' : 'Reviewed by admin'}</p>
                </div>
              </div>
              <div className={`request-timeline-item ${requestStatusKey(requestDetailsModal.request) === 'pending' ? 'pending' : 'done'}`}>
                <span className="request-timeline-dot" />
                <div>
                  <strong>{requestStatusKey(requestDetailsModal.request) === 'rejected' ? 'Rejected' : 'Approved / Completed'}</strong>
                  <p>{requestStatusKey(requestDetailsModal.request) === 'pending' ? 'Decision pending' : (requestDetailsModal.request?.approved_at ? `${dateKeyInIST(requestDetailsModal.request?.approved_at)} ${formatTimeInIST(requestDetailsModal.request?.approved_at)}` : 'Updated')}</p>
                </div>
              </div>
            </div>

            <div className="row modal-actions confirm-modal-actions">
              {(requestStatusKey(requestDetailsModal.request) === 'pending' || requestStatusKey(requestDetailsModal.request) === 'conflict') && (
                <>
                  <button
                    type="button"
                    className="table-action-btn request-approve-btn"
                    onClick={() => {
                      confirmManualRequestAction('approve', requestDetailsModal.request?.id)
                      setRequestDetailsModal({ open: false, request: null })
                    }}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="table-action-btn request-reject-btn"
                    onClick={() => {
                      confirmManualRequestAction('reject', requestDetailsModal.request?.id)
                      setRequestDetailsModal({ open: false, request: null })
                    }}
                  >
                    Reject
                  </button>
                </>
              )}
              {requestStatusKey(requestDetailsModal.request) === 'approved' && isReimbursementRequest(requestDetailsModal.request) && (
                <button
                  type="button"
                  className="table-action-btn request-paid-btn"
                  onClick={() => {
                    markRequestPaid(requestDetailsModal.request?.id)
                    setRequestDetailsModal({ open: false, request: null })
                  }}
                >
                  Mark Paid
                </button>
              )}
              <button type="button" className="ghost" onClick={() => setRequestDetailsModal({ open: false, request: null })}>Close</button>
            </div>
          </div>
        </div>
      )}
      {rejectReasonModal.open && (
        <div className="modal-overlay" onClick={() => setRejectReasonModal({ open: false, requestIds: [], reason: 'Rejected by admin', saving: false })}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{(rejectReasonModal.requestIds || []).length > 1 ? 'Reject Selected Requests' : 'Reject Request'}</h3>
            <p className="muted">
              {(rejectReasonModal.requestIds || []).length > 1
                ? `You are rejecting ${(rejectReasonModal.requestIds || []).length} selected request(s).`
                : 'Add a rejection reason for audit and employee visibility.'}
            </p>
            <div className="stack">
              <label className="muted small">Action Comment (Required for reject)</label>
              <input
                type="text"
                placeholder="Enter rejection reason"
                value={rejectReasonModal.reason}
                onChange={(e) => setRejectReasonModal((old) => ({ ...old, reason: e.target.value }))}
              />
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={rejectReasonModal.saving}
                onClick={() => setRejectReasonModal({ open: false, requestIds: [], reason: 'Rejected by admin', saving: false })}
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
      {approveReasonModal.open && (
        <div className="modal-overlay" onClick={() => setApproveReasonModal({ open: false, requestIds: [], reason: 'Approved by admin', saving: false })}>
          <div className="modal-card confirm-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>{(approveReasonModal.requestIds || []).length > 1 ? 'Approve Selected Requests' : 'Approve Request'}</h3>
            <p className="muted">
              {(approveReasonModal.requestIds || []).length > 1
                ? `You are approving ${(approveReasonModal.requestIds || []).length} selected request(s).`
                : 'Add an approval remark for audit and employee visibility.'}
            </p>
            <div className="stack">
              <label className="muted small">Approval Remark</label>
              <input
                type="text"
                placeholder="Enter approval remark"
                value={approveReasonModal.reason}
                onChange={(e) => setApproveReasonModal((old) => ({ ...old, reason: e.target.value }))}
              />
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button
                type="button"
                className="ghost"
                disabled={approveReasonModal.saving}
                onClick={() => setApproveReasonModal({ open: false, requestIds: [], reason: 'Approved by admin', saving: false })}
              >
                Cancel
              </button>
              <button type="button" className="table-action-btn request-approve-btn" disabled={approveReasonModal.saving} onClick={submitApproveReason}>
                {approveReasonModal.saving ? 'Approving...' : 'Approve'}
              </button>
            </div>
          </div>
        </div>
      )}
      {editEmployeeModal.open && (
        <div className="modal-overlay" onClick={() => setEditEmployeeModal(EMPTY_EDIT_EMP)}>
          <div className="modal-card confirm-modal-card edit-employee-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>Edit Employee — {editEmployeeModal.name || editEmployeeModal.loginId}</h3>
            <div className="stack">
              {/* ── Personal ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', marginBottom: 4 }}>
                <div><label className="add-field-label">Full Name *</label>
                  <input className="add-employee-input" placeholder="Full Name" value={editEmployeeModal.name} onChange={e => setEditEmployeeModal(o => ({ ...o, name: e.target.value }))} /></div>
                <div><label className="add-field-label">Mobile</label>
                  <input className="add-employee-input" placeholder="+91 98765 43210" value={editEmployeeModal.mobile} onChange={e => setEditEmployeeModal(o => ({ ...o, mobile: e.target.value }))} /></div>
                <div><label className="add-field-label">Email *</label>
                  <input className="add-employee-input" type="email" placeholder="Email" value={editEmployeeModal.email} onChange={e => setEditEmployeeModal(o => ({ ...o, email: e.target.value }))} /></div>
                <div><label className="add-field-label">Father's Name</label>
                  <input className="add-employee-input" placeholder="Father's Name" value={editEmployeeModal.father_name} onChange={e => setEditEmployeeModal(o => ({ ...o, father_name: e.target.value }))} /></div>
                <div><label className="add-field-label">Date of Birth</label>
                  <input className="add-employee-input" type="date" value={editEmployeeModal.dob} onChange={e => setEditEmployeeModal(o => ({ ...o, dob: e.target.value }))} /></div>
                <div><label className="add-field-label">Gender</label>
                  <select className="add-employee-input" value={editEmployeeModal.gender} onChange={e => setEditEmployeeModal(o => ({ ...o, gender: e.target.value }))}>
                    <option value="">Select</option><option>Male</option><option>Female</option><option>Other</option></select></div>
                <div><label className="add-field-label">Blood Group</label>
                  <select className="add-employee-input" value={editEmployeeModal.blood_group} onChange={e => setEditEmployeeModal(o => ({ ...o, blood_group: e.target.value }))}>
                    <option value="">Select</option>{['A+','A-','B+','B-','AB+','AB-','O+','O-'].map(bg=><option key={bg}>{bg}</option>)}</select></div>
                <div><label className="add-field-label">Marital Status</label>
                  <select className="add-employee-input" value={editEmployeeModal.marital_status} onChange={e => setEditEmployeeModal(o => ({ ...o, marital_status: e.target.value }))}>
                    <option value="">Select</option><option>Single</option><option>Married</option><option>Divorced</option><option>Widowed</option></select></div>
              </div>

              {/* ── Job ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', marginBottom: 4 }}>
                <div><label className="add-field-label">Employee ID</label>
                  <input className="add-employee-input" placeholder="EMP-001" value={editEmployeeModal.emp_id} onChange={e => setEditEmployeeModal(o => ({ ...o, emp_id: e.target.value.toUpperCase() }))} /></div>
                <div><label className="add-field-label">Designation</label>
                  <input className="add-employee-input" placeholder="e.g. Engineer" value={editEmployeeModal.designation} onChange={e => setEditEmployeeModal(o => ({ ...o, designation: e.target.value }))} /></div>
                <div><label className="add-field-label">Department</label>
                  <select className="add-employee-input" value={editEmployeeModal.department} onChange={e => setEditEmployeeModal(o => ({ ...o, department: e.target.value }))}>
                    {directoryDepartments.map(d=><option key={d}>{d}</option>)}</select></div>
                <div><label className="add-field-label">Role</label>
                  <select className="add-employee-input" value={editEmployeeModal.role} onChange={e => setEditEmployeeModal(o => ({ ...o, role: e.target.value }))}>
                    {directoryRoles.map(r=><option key={r}>{r}</option>)}</select></div>
                <div><label className="add-field-label">Company</label>
                  <select className="add-employee-input" value={editEmployeeModal.company_name} onChange={e => setEditEmployeeModal(o => ({ ...o, company_name: e.target.value }))}>
                    <option value="">Select Company</option>{companies.map(c=><option key={c.id} value={c.name}>{c.name}</option>)}</select></div>
                <div><label className="add-field-label">Employment Type</label>
                  <select className="add-employee-input" value={editEmployeeModal.employment_type} onChange={e => setEditEmployeeModal(o => ({ ...o, employment_type: e.target.value }))}>
                    <option>Full-time</option><option>Part-time</option><option>Contract</option><option>Intern</option></select></div>
                <div><label className="add-field-label">Date of Joining</label>
                  <input className="add-employee-input" type="date" value={editEmployeeModal.date_of_joining} onChange={e => setEditEmployeeModal(o => ({ ...o, date_of_joining: e.target.value }))} /></div>
                <div><label className="add-field-label">Status</label>
                  <select className="add-employee-input" value={editEmployeeModal.status} onChange={e => setEditEmployeeModal(o => ({ ...o, status: e.target.value }))}>
                    <option value="active">Active</option><option value="inactive">Inactive</option></select></div>
                <div><label className="add-field-label">Login ID</label>
                  <input className="add-employee-input" placeholder="Login ID" value={editEmployeeModal.loginId} onChange={e => setEditEmployeeModal(o => ({ ...o, loginId: e.target.value }))} /></div>
                <div><label className="add-field-label">Reporting Manager</label>
                  <select className="add-employee-input" value={editEmployeeModal.reporting_manager} onChange={e => setEditEmployeeModal(o => ({ ...o, reporting_manager: e.target.value }))}>
                    <option value="">None / Self</option>{employees.map(emp=><option key={emp.id||emp._id} value={emp.name}>{emp.name}</option>)}</select></div>
              </div>

              {/* ── Documents ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', marginBottom: 4 }}>
                <div><label className="add-field-label">Aadhaar</label>
                  <input className="add-employee-input" placeholder="XXXX XXXX XXXX" maxLength={14} value={editEmployeeModal.aadhaar_number} onChange={e => setEditEmployeeModal(o => ({ ...o, aadhaar_number: e.target.value }))} /></div>
                <div><label className="add-field-label">PAN</label>
                  <input className="add-employee-input" placeholder="ABCDE1234F" maxLength={10} value={editEmployeeModal.pan_number} onChange={e => setEditEmployeeModal(o => ({ ...o, pan_number: e.target.value.toUpperCase() }))} /></div>
              </div>

              {/* ── Bank ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', marginBottom: 4 }}>
                <div><label className="add-field-label">Bank Name</label>
                  <input className="add-employee-input" placeholder="e.g. SBI" value={editEmployeeModal.bank_name} onChange={e => setEditEmployeeModal(o => ({ ...o, bank_name: e.target.value }))} /></div>
                <div><label className="add-field-label">IFSC Code</label>
                  <input className="add-employee-input" placeholder="SBIN0001234" maxLength={11} value={editEmployeeModal.bank_ifsc} onChange={e => setEditEmployeeModal(o => ({ ...o, bank_ifsc: e.target.value.toUpperCase() }))} /></div>
                <div style={{ gridColumn: 'span 2' }}><label className="add-field-label">Account Number</label>
                  <input className="add-employee-input" placeholder="Account Number" value={editEmployeeModal.bank_account_no} onChange={e => setEditEmployeeModal(o => ({ ...o, bank_account_no: e.target.value.replace(/\D/g,'') }))} /></div>
              </div>

              {/* ── Compensation ── */}
              <div style={{ marginBottom: 4 }}>
                <label className="add-field-label">Salary Type</label>
                <div className="salary-type-toggle" style={{ marginTop: 4 }}>
                  {[{ val: 'CTC_BASED', label: '📊 CTC' }, { val: 'IN_HAND', label: '💵 In-Hand' }].map(opt => (
                    <button key={opt.val} type="button" className={`salary-type-btn compact ${editEmployeeModal.salary_type === opt.val ? 'active' : ''}`}
                      onClick={() => setEditEmployeeModal(o => ({ ...o, salary_type: opt.val }))}>{opt.label}</button>
                  ))}
                </div>
                {editEmployeeModal.salary_type === 'CTC_BASED' ? (
                  <input className="add-employee-input" type="number" min="0" placeholder="Monthly Gross (₹)" style={{ marginTop: 6 }}
                    value={editEmployeeModal.monthly_salary} onChange={e => setEditEmployeeModal(o => ({ ...o, monthly_salary: e.target.value }))} />
                ) : (
                  <input className="add-employee-input" type="number" min="0" placeholder="Net In-Hand (₹)" style={{ marginTop: 6 }}
                    value={editEmployeeModal.net_target_monthly} onChange={e => setEditEmployeeModal(o => ({ ...o, net_target_monthly: e.target.value }))} />
                )}
              </div>

              {/* ── Work Policy ── */}
              <div style={{ marginBottom: 4 }}>
                <label className="add-field-label">Saturday Policy</label>
                <select className="add-employee-input" value={editEmployeeModal.work_policy?.saturdayPolicy || 'OFF'}
                  onChange={e => setEditEmployeeModal(o => ({ ...o, work_policy: { ...(o.work_policy||{}), saturdayPolicy: e.target.value } }))}>
                  <option value="OFF">OFF – Paid Weekend</option>
                  <option value="WORKING">WORKING</option>
                  <option value="HALF_DAY">HALF_DAY</option>
                </select>
                <div style={{ display: 'flex', gap: 8, marginTop: 6 }}>
                  <input className="add-employee-input" type="time" style={{ flex:1 }} title="Shift Start"
                    value={editEmployeeModal.work_policy?.shiftStart || '09:00'} onChange={e => setEditEmployeeModal(o => ({ ...o, work_policy: { ...(o.work_policy||{}), shiftStart: e.target.value } }))} />
                  <input className="add-employee-input" type="time" style={{ flex:1 }} title="Shift End"
                    value={editEmployeeModal.work_policy?.shiftEnd || '18:00'} onChange={e => setEditEmployeeModal(o => ({ ...o, work_policy: { ...(o.work_policy||{}), shiftEnd: e.target.value } }))} />
                </div>
              </div>
            </div>
            <div className="row modal-actions confirm-modal-actions">
              <button type="button" className="ghost" disabled={editEmployeeModal.saving}
                onClick={() => setEditEmployeeModal(EMPTY_EDIT_EMP)}>Cancel</button>
              <button type="button" disabled={editEmployeeModal.saving} onClick={submitEditEmployee}>
                {editEmployeeModal.saving ? 'Saving...' : 'Save Changes'}</button>
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
