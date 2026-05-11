import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Save, RefreshCw, Loader2, AlertTriangle, CheckCircle2,
  Printer, X, DollarSign, BarChart3, Zap,
  Calendar, Database, Edit3, RotateCcw, Check,
} from 'lucide-react'
import { apiFetch } from '../../api'
import './EmployeePayrollCalculator.css'

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const DEFAULT_STRUCTURE = {
  basicPercent: 50,
  hraPercent: 20,
  conveyancePercent: 10,
  ccaPercent: 8,
  medicalPercent: 7,
  otherAllowancePercent: 5,
  pfPercent: 12,
  taxPercent: 5,
  advanceDeduction: 0,
  otherDeductionPct: 0,
}

const DEFAULT_ATTENDANCE = {
  totalDays: 31,
  sundays: 5,
  saturdaysOff: 0,
  paidHolidays: 0,
  weekoffDays: 2,
  payableDays: 4,
  attendanceWorkingDays: 10,
  presentDays: 2,
  casualLeave: 0,
  sickLeave: 0,
  paidLeave: 0,
  halfDays: 0,
  overtimeHours: 0,
  lateMarks: 0,
  earlyExits: 0,
  paidDays: 4,
  lopDays: 4,
}

/** Full calendar length of selected payroll month (always used as salary divisor). */
function calendarDaysInSelectedMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

/** Count Sat+Sun from day 1 through `throughDay` inclusive (MTD weekends for payable fallback). */
function countWeekendsThrough(year, month, throughDay) {
  const last = calendarDaysInSelectedMonth(year, month)
  const end = Math.min(Math.max(1, Number(throughDay) || last), last)
  let n = 0
  for (let d = 1; d <= end; d += 1) {
    const wd = new Date(year, month - 1, d).getDay()
    if (wd === 0 || wd === 6) n += 1
  }
  return n
}

function r2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

function fmtINR(n, decimals = 2) {
  const v = Number(n || 0)
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`
}

function fmtINRShort(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function numberToWords(num) {
  if (!num || num === 0) return 'Zero Rupees Only'
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen']
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety']

  num = Math.round(Math.abs(num))
  if (num === 0) return 'Zero Rupees Only'

  function below100(n) {
    if (n < 20) return ones[n]
    return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '')
  }
  function below1000(n) {
    if (n < 100) return below100(n)
    return ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + below100(n % 100) : '')
  }

  let result = ''
  if (num >= 10000000) {
    result += below1000(Math.floor(num / 10000000)) + ' Crore '
    num %= 10000000
  }
  if (num >= 100000) {
    result += below100(Math.floor(num / 100000)) + ' Lakh '
    num %= 100000
  }
  if (num >= 1000) {
    result += below100(Math.floor(num / 1000)) + ' Thousand '
    num %= 1000
  }
  if (num > 0) {
    result += below1000(num)
  }
  return result.trim() + ' Rupees Only'
}

/** Paid day-units (MTD): Present + paid leaves + holidays + weekends (+ half-day credit). */
function paidUnitsFromPreview(preview, year, month) {
  const present = Number(preview.presentDays) || 0
  const casual = Number(preview.casualLeaveDays) || 0
  const sick = Number(preview.sickLeaveDays) || 0
  const pl = Number(preview.paidLeaveDays) || 0
  const ph = Number(preview.paidHolidayDays ?? preview.holidayDays) || 0
  const half = (Number(preview.halfDays ?? preview.halfDayCount) || 0) * 0.5
  const synced =
    Number(preview.syncedThroughDay) ||
    Number(preview.elapsedCalendarDays) ||
    Number(preview.daysTracked) ||
    0
  const weekendsApi = Number(preview.weekoffDays) || 0
  const weekendsFallback = synced > 0 ? countWeekendsThrough(year, month, synced) : 0
  const weekoffs = Math.max(weekendsApi, weekendsFallback)
  const sum = present + casual + sick + pl + ph + weekoffs + half
  const apiPaid = Number(preview.paidDays)
  if (Number.isFinite(apiPaid) && apiPaid > 0) {
    return r2(Math.max(sum, apiPaid))
  }
  return r2(sum)
}

function splitEarningsOnBase(base, structure) {
  const s = structure || DEFAULT_STRUCTURE
  const basicAmt = r2((Number(s.basicPercent) / 100) * base)
  const hraAmt = r2((Number(s.hraPercent) / 100) * base)
  const conveyanceAmt = r2((Number(s.conveyancePercent) / 100) * base)
  const ccaAmt = r2((Number(s.ccaPercent) / 100) * base)
  const medicalAmt = r2((Number(s.medicalPercent) / 100) * base)
  const otherAllowAmt = r2((Number(s.otherAllowancePercent) / 100) * base)
  const totalEarnings = r2(basicAmt + hraAmt + conveyanceAmt + ccaAmt + medicalAmt + otherAllowAmt)
  const pfAmt = r2((Number(s.pfPercent) / 100) * basicAmt)
  const tdsAmt = r2((Number(s.taxPercent) / 100) * base)
  const advanceAdj = Number(s.advanceDeduction) || 0
  const totalDeductions = r2(pfAmt + tdsAmt + advanceAdj)
  return {
    basicAmt,
    hraAmt,
    conveyanceAmt,
    ccaAmt,
    medicalAmt,
    otherAllowAmt,
    totalEarnings,
    pfAmt,
    tdsAmt,
    advanceAdj,
    totalDeductions,
  }
}

/** Map payroll-preview API → display payroll (always calendar divisor; never trust API dailyRate alone). */
function payrollFromPreview(preview, monthlySalaryFallback, year, month, structure) {
  if (!preview) return null
  const grossMonthly = Number(preview.monthlySalary ?? monthlySalaryFallback ?? 0)
  const calendarFull = Math.max(
    1,
    Number(preview.calendarDaysInFullMonth) || calendarDaysInSelectedMonth(year, month),
  )
  const perDay = r2(grossMonthly / calendarFull)
  const lopDays = Math.max(0, Number(preview.lopDays) || 0)
  const lopDeduction = r2(perDay * lopDays)
  const paidUnits = paidUnitsFromPreview(preview, year, month)
  const effectiveGross = Math.max(0, r2(perDay * paidUnits))
  const split = splitEarningsOnBase(effectiveGross, structure)
  const overtimeEarnings = r2(
    Number(preview.overtimeEarnings) > 0
      ? Number(preview.overtimeEarnings)
      : (Number(preview.overtimeHours) || 0) * (perDay / 8) * 1.5,
  )
  const netPayable = Math.max(0, r2(split.totalEarnings - split.totalDeductions + overtimeEarnings))
  const resolved = paidUnits + lopDays
  const pctFromApi = Number(preview.attendancePct)
  const attendancePct = Number.isFinite(pctFromApi) && pctFromApi >= 0
    ? String(r2(pctFromApi))
    : (resolved > 0 ? (((paidUnits / resolved) * 100).toFixed(1)) : '0.0')
  const earningPctTotal =
    (structure.basicPercent || 0) + (structure.hraPercent || 0) +
    (structure.conveyancePercent || 0) + (structure.ccaPercent || 0) +
    (structure.medicalPercent || 0) + (structure.otherAllowancePercent || 0)
  return {
    gross: grossMonthly,
    perDay,
    divisor: calendarFull,
    lopDays,
    lopDeduction,
    effectiveGross,
    basicAmt: split.basicAmt,
    hraAmt: split.hraAmt,
    conveyanceAmt: split.conveyanceAmt,
    ccaAmt: split.ccaAmt,
    medicalAmt: split.medicalAmt,
    specialAmt: 0,
    bonusAmt: 0,
    otherAllowAmt: split.otherAllowAmt,
    earningPctTotal,
    totalEarnings: split.totalEarnings,
    pfAmt: split.pfAmt,
    tdsAmt: split.tdsAmt,
    advanceAdj: split.advanceAdj,
    totalDeductions: split.totalDeductions,
    netPayable,
    overtimeEarnings,
    attendancePct,
    paidDays: paidUnits,
  }
}

function payrollFromPreviewInHand(preview, monthlySalaryFallback, year, month, structure) {
  const p = payrollFromPreview(preview, monthlySalaryFallback, year, month, structure)
  if (!p) return null
  return { ...p, gross: Number(preview?.monthlySalary ?? monthlySalaryFallback ?? 0) }
}

function attendanceFromPreview(data, year, month) {
  if (!data) return null
  const calendarFull =
    Number(data.calendarDaysInFullMonth) || calendarDaysInSelectedMonth(year, month)
  const elapsed =
    Number(data.elapsedCalendarDays) || Number(data.daysTracked) || Number(data.syncedThroughDay) || 0
  const paidUnits = paidUnitsFromPreview(data, year, month)
  return {
    totalDays: calendarFull,
    sundays: data.sundaysInMonth ?? 0,
    saturdaysOff: data.saturdaysInMonth ?? data.saturdaysOffInMonth ?? 0,
    paidHolidays: data.paidHolidayDays ?? data.holidayDays ?? 0,
    weekoffDays: Math.max(Number(data.weekoffDays) || 0, elapsed > 0 ? countWeekendsThrough(year, month, elapsed) : 0),
    payableDays: paidUnits,
    attendanceWorkingDays: elapsed || Number(data.workingDaysInMonth) || 0,
    presentDays: data.presentDays ?? 0,
    casualLeave: data.casualLeaveDays ?? 0,
    sickLeave: data.sickLeaveDays ?? 0,
    paidLeave: data.paidLeaveDays ?? 0,
    halfDays: data.halfDayCount ?? data.halfDays ?? 0,
    overtimeHours: data.overtimeHours ?? 0,
    lateMarks: data.lateMarks ?? 0,
    earlyExits: data.earlyExits ?? 0,
    paidDays: paidUnits,
    lopDays: Number(data.lopDays) || 0,
  }
}

function normalizeStructureFromApi(s) {
  if (!s || typeof s !== 'object') return DEFAULT_STRUCTURE
  return {
    basicPercent: Number(s.basicPct ?? s.basicPercent ?? DEFAULT_STRUCTURE.basicPercent),
    hraPercent: Number(s.hraPct ?? s.hraPercent ?? DEFAULT_STRUCTURE.hraPercent),
    conveyancePercent: Number(s.conveyancePct ?? s.conveyancePercent ?? DEFAULT_STRUCTURE.conveyancePercent),
    ccaPercent: Number(s.ccaPct ?? s.ccaPercent ?? DEFAULT_STRUCTURE.ccaPercent),
    medicalPercent: Number(s.medicalPct ?? s.medicalPercent ?? DEFAULT_STRUCTURE.medicalPercent),
    otherAllowancePercent: Number(
      s.otherEarningsPct ?? s.otherAllowancePercent ?? s.bonusPct ?? DEFAULT_STRUCTURE.otherAllowancePercent,
    ),
    pfPercent: Number(s.pfPct ?? s.pfPercent ?? DEFAULT_STRUCTURE.pfPercent),
    taxPercent: Number(s.tdsPct ?? s.taxPercent ?? DEFAULT_STRUCTURE.taxPercent),
    advanceDeduction: Number(s.advanceAmount ?? s.advanceDeduction ?? 0),
  }
}

async function apiFetchWithPaths(paths, options, token) {
  let lastErr
  for (let i = 0; i < paths.length; i += 1) {
    try {
      return await apiFetch(paths[i], options, token)
    } catch (e) {
      lastErr = e
      const st = e?.status
      // 405/404: try next path (older servers or stacks that block nested /payslips/ routes)
      if ((st === 405 || st === 404) && i < paths.length - 1) continue
      throw e
    }
  }
  throw lastErr
}

export default function EmployeePayrollCalculator({ employee, token, company }) {
  const today = new Date()
  const [year, setYear] = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)
  const [monthlySalary, setMonthlySalary] = useState(40000)
  const [structure, setStructure] = useState(DEFAULT_STRUCTURE)
  const [attendance, setAttendance] = useState(DEFAULT_ATTENDANCE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState(null)
  const [autoMode, setAutoMode] = useState(true)
  const [editMode, setEditMode] = useState(false)
  const [payslipStatus, setPayslipStatus] = useState('none') // none | published | approved
  const [approving, setApproving] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [revoking, setRevoking] = useState(false)
  const [preview, setPreview] = useState(null)
  const [payslipHistory, setPayslipHistory] = useState([])
  const debounceRef = useRef(null)
  const payslipRef = useRef(null)

  const empId = employee?.id || employee?._id || ''
  const empName = employee?.name || 'Sumit'
  const empDept = employee?.department || 'General'
  const empRole = employee?.role || 'Staff'
  const empCode = employee?.emp_code || employee?.login_id || 'SUMI'

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

  // ═══ PAYROLL: auto mode uses server MTD preview; manual = local grid formula ═══
  const payroll = useMemo(() => {
    const useServer = autoMode && !editMode && preview

    const pctSum =
      (structure.basicPercent || 0) + (structure.hraPercent || 0) +
      (structure.conveyancePercent || 0) + (structure.ccaPercent || 0) +
      (structure.medicalPercent || 0) + (structure.otherAllowancePercent || 0)

    if (useServer && preview.salaryType === 'IN_HAND') {
      const p = payrollFromPreviewInHand(preview, monthlySalary, year, month, structure)
      if (p) return { ...p, earningPctTotal: pctSum }
    }
    if (useServer && preview.salaryType !== 'IN_HAND') {
      const p = payrollFromPreview(preview, monthlySalary, year, month, structure)
      if (p) return { ...p, earningPctTotal: pctSum }
    }

    const gross = Number(monthlySalary) || 0
    const divisor = calendarDaysInSelectedMonth(year, month)
    const perDay = r2(gross / divisor)

    const sumPay =
      (attendance.presentDays || 0) +
      (attendance.casualLeave || 0) +
      (attendance.sickLeave || 0) +
      (attendance.paidLeave || 0) +
      (attendance.paidHolidays || 0) +
      (attendance.weekoffDays || 0) +
      ((attendance.halfDays || 0) * 0.5)
    const paidUnits =
      attendance.payableDays != null && attendance.payableDays !== ''
        ? Math.max(0, Number(attendance.payableDays) || 0)
        : Math.max(0, sumPay)
    const lopDaysEff = Math.max(0, Number(attendance.lopDays) || 0)
    const lopDeduction = r2(perDay * lopDaysEff)
    const effectiveGross = Math.max(0, r2(perDay * paidUnits))

    const basicAmt = (structure.basicPercent / 100) * effectiveGross
    const hraAmt = (structure.hraPercent / 100) * effectiveGross
    const conveyanceAmt = (structure.conveyancePercent / 100) * effectiveGross
    const ccaAmt = (structure.ccaPercent / 100) * effectiveGross
    const medicalAmt = (structure.medicalPercent / 100) * effectiveGross
    const otherAllowAmt = (structure.otherAllowancePercent / 100) * effectiveGross

    const earningPctTotal = (structure.basicPercent || 0) + (structure.hraPercent || 0) +
      (structure.conveyancePercent || 0) + (structure.ccaPercent || 0) +
      (structure.medicalPercent || 0) + (structure.otherAllowancePercent || 0)

    const totalEarnings = basicAmt + hraAmt + conveyanceAmt + ccaAmt + medicalAmt + otherAllowAmt

    const pfAmt = (structure.pfPercent / 100) * basicAmt
    const tdsAmt = (structure.taxPercent / 100) * effectiveGross
    const advanceAdj = Number(structure.advanceDeduction) || 0
    const totalDeductions = pfAmt + tdsAmt + advanceAdj

    const overtimeEarnings = (attendance.overtimeHours || 0) * (perDay / 8) * 1.5

    const attendancePct = (attendance.attendanceWorkingDays || 0) > 0
      ? (((paidUnits || 0) / Math.max(1, (paidUnits || 0) + lopDaysEff)) * 100).toFixed(1)
      : '0.0'

    return {
      gross, perDay, divisor, lopDays: lopDaysEff, lopDeduction, effectiveGross,
      basicAmt, hraAmt, conveyanceAmt, ccaAmt, medicalAmt, otherAllowAmt,
      specialAmt: 0,
      bonusAmt: 0,
      earningPctTotal, totalEarnings,
      pfAmt, tdsAmt, advanceAdj, totalDeductions,
      netPayable: totalEarnings - totalDeductions + overtimeEarnings,
      overtimeEarnings, attendancePct, paidDays: paidUnits,
    }
  }, [monthlySalary, structure, attendance, autoMode, editMode, preview, year, month])

  const isMtdPeriod = preview?.isMonthToDate === true

  // ═══ LOAD DATA ═══
  const loadStructure = useCallback(async () => {
    if (!empId) { setLoading(false); return }
    setLoading(true)
    try {
      const data = await apiFetch(`/api/employees/${empId}/salary-structure`, {}, token)
      if (data.monthlySalary) setMonthlySalary(data.monthlySalary)
      if (data.structure) {
        setStructure(normalizeStructureFromApi(data.structure))
      }
    } catch { /* use defaults */ }
    finally { setLoading(false) }
  }, [empId, token])

  const loadPayslipStatus = useCallback(async () => {
    if (!empId) return
    try {
      const qe = encodeURIComponent(empId)
      const data = await apiFetch(`/api/payroll/payslips/status?employee_id=${qe}&year=${year}&month=${month}`, {}, token)
      setPayslipStatus(data.status || 'none')
    } catch {
      setPayslipStatus('none')
    }
  }, [empId, token, year, month])

  const loadPayslipHistory = useCallback(async () => {
    if (!empId) return
    try {
      const qe = encodeURIComponent(empId)
      const rows = await apiFetch(`/api/payroll/payslips/history?employee_id=${qe}`, {}, token)
      setPayslipHistory(Array.isArray(rows) ? rows : [])
    } catch {
      setPayslipHistory([])
    }
  }, [empId, token])

  const fetchPreview = useCallback(async () => {
    if (!empId) return
    try {
      const data = await apiFetch(
        `/api/employees/${empId}/payroll-preview?year=${year}&month=${month}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...structure, monthlySalary }) },
        token,
      )
      setPreview(data)
      if (autoMode && !editMode && data) {
        const nextAtt = attendanceFromPreview(data, year, month)
        if (nextAtt) setAttendance(prev => ({ ...prev, ...nextAtt }))
      }
    } catch { /* keep last preview */ }
  }, [empId, token, year, month, structure, monthlySalary, autoMode, editMode])

  useEffect(() => { loadStructure() }, [loadStructure])
  useEffect(() => { loadPayslipStatus() }, [loadPayslipStatus])
  useEffect(() => { loadPayslipHistory() }, [loadPayslipHistory])

  useEffect(() => {
    if (!autoMode) return
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(fetchPreview, 400)
    return () => clearTimeout(debounceRef.current)
  }, [fetchPreview, autoMode])

  // ═══ HANDLERS ═══
  const handleSave = async () => {
    setSaving(true)
    try {
      await apiFetch(`/api/employees/${empId}/salary-structure`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...structure, monthlySalary }),
      }, token)
      showToast('Payroll saved successfully')
    } catch (err) {
      showToast(err?.message || 'Save failed', 'error')
    } finally { setSaving(false) }
  }

  const handlePublishAndApprove = async () => {
    if (payslipStatus === 'approved') return
    if (payslipStatus === 'published') {
      setApproving(true)
      try {
        console.log('Sending approve request: POST /api/payroll/payslips/approve', { employee_id: empId, year, month });
        console.log('Sending approve request: POST /api/payroll/payslips/approve', { employee_id: empId, year, month });
        await apiFetch(`/api/payroll/payslips/approve`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ employee_id: empId, year, month })
        }, token)
        setPayslipStatus('approved')
        showToast('Payslip approved! Employee can now download.')
        loadPayslipHistory()
      } catch (err) {
        showToast(err?.message || 'Approval failed', 'error')
      } finally { setApproving(false) }
    } else {
      setPublishing(true)
      try {
        const kind = preview?.isMonthToDate ? 'interim_mtd' : 'final'
        const snapshot = {
          monthlyCtc: monthlySalary,
          payableDays: attendance.payableDays,
          presentDays: attendance.presentDays,
          lopDays: payroll.lopDays,
          paidLeaveDays: (attendance.casualLeave || 0) + (attendance.sickLeave || 0) + (attendance.paidLeave || 0),
          lopDed: payroll.lopDeduction,
          perDay: payroll.perDay,
          attendanceWorkingDays: attendance.attendanceWorkingDays,
          totalDaysInMonth: attendance.totalDays,
          attendancePct: parseFloat(String(payroll.attendancePct || '0')) || 0,
          mtdEarned: preview?.earnedSalary ?? payroll.effectiveGross,
          earnings: {
            basic: payroll.basicAmt,
            hra: payroll.hraAmt,
            conveyance: payroll.conveyanceAmt,
            cca: payroll.ccaAmt,
            medical: payroll.medicalAmt,
            otherEarnings: payroll.specialAmt || 0,
            bonus: payroll.bonusAmt || 0,
            overtime: payroll.overtimeEarnings || 0,
          },
          totalEarnings: payroll.totalEarnings,
          pf: payroll.pfAmt,
          tds: payroll.tdsAmt,
          advance: payroll.advanceAdj,
          totalDeductions: payroll.totalDeductions,
          netSalary: payroll.netPayable,
          payslipKind: kind,
        }
        await apiFetch(`/api/employees/${empId}/payslips/publish`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ year, month, snapshot }),
        }, token)
        setPayslipStatus('published')
        showToast('Payslip published! Click "Done" again to approve for employee download.')
        loadPayslipHistory()
      } catch (err) {
        showToast(err?.message || 'Publish failed', 'error')
      } finally { setPublishing(false) }
    }
  }

  const handleRevokeApproval = async () => {
    if (payslipStatus !== 'approved') return
    setRevoking(true)
    try {
      await apiFetch(`/api/employees/${empId}/payslips/revoke`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month }),
      }, token)
      setPayslipStatus('published')
      showToast('Approval revoked. Employee download disabled until you approve again.')
      loadPayslipStatus()
      loadPayslipHistory()
    } catch (err) {
      showToast(err?.message || 'Revoke failed', 'error')
    } finally { setRevoking(false) }
  }

  const handleStructureChange = (field, value) => {
    setStructure(prev => ({ ...prev, [field]: Number(value) || 0 }))
  }

  const handleAttendanceChange = (field, value) => {
    setAttendance(prev => ({ ...prev, [field]: Number(value) || 0 }))
  }

  const handleEditManually = () => {
    setAutoMode(false)
    setEditMode(true)
  }

  const handleResetAttendance = () => {
    setAutoMode(true)
    setEditMode(false)
    fetchPreview()
  }

  const handlePrint = () => {
    const printContent = payslipRef.current
    if (!printContent) return
    const win = window.open('', '_blank')
    win.document.write(`
      <html><head><title>Payslip - ${empName} - ${MONTHS[month-1]} ${year}</title>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { font-family: 'Inter', -apple-system, sans-serif; padding: 24px; color: #111827; }
        .ps-wrap { max-width: 700px; margin: 0 auto; }
        .ps-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 16px; border-bottom: 2px solid #10b981; margin-bottom: 16px; }
        .ps-logo { display: flex; align-items: center; gap: 10px; }
        .ps-logo-icon { width: 36px; height: 36px; border-radius: 8px; background: #10b981; color: white; display: flex; align-items: center; justify-content: center; font-weight: bold; font-size: 14px; }
        .ps-company { font-size: 16px; font-weight: 700; }
        .ps-subtitle { font-size: 11px; color: #6b7280; }
        .ps-period { text-align: right; }
        .ps-period-label { font-size: 10px; color: #6b7280; text-transform: uppercase; }
        .ps-period-val { font-size: 14px; font-weight: 700; color: #059669; }
        .ps-details { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-bottom: 16px; }
        .ps-detail { display: flex; justify-content: space-between; padding: 5px 8px; background: #f9fafb; border-radius: 4px; font-size: 11px; }
        .ps-detail span { color: #6b7280; }
        .ps-detail strong { color: #111827; }
        .ps-lop { padding: 8px 12px; background: #fefce8; border: 1px solid #fde047; border-radius: 6px; font-size: 11px; color: #92400e; margin-bottom: 14px; }
        .ps-table-wrap { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px; }
        .ps-col { border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; }
        .ps-col-header { padding: 8px 10px; font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.5px; }
        .ps-col-header.earn { background: #ecfdf5; color: #059669; }
        .ps-col-header.ded { background: #fef2f2; color: #dc2626; }
        .ps-col-body { padding: 6px 10px; }
        .ps-line { display: flex; justify-content: space-between; padding: 3px 0; font-size: 11px; border-bottom: 1px solid #fafafa; }
        .ps-col-total { display: flex; justify-content: space-between; padding: 8px 10px; font-size: 11px; font-weight: 700; border-top: 1px solid #e5e7eb; }
        .ps-col-total.earn { background: #f0fdf4; color: #065f46; }
        .ps-col-total.ded { background: #fff1f2; color: #991b1b; }
        .ps-net { text-align: center; padding: 16px; background: #ecfdf5; border: 2px solid #6ee7b7; border-radius: 10px; margin-bottom: 14px; }
        .ps-net-label { font-size: 10px; font-weight: 800; color: #059669; text-transform: uppercase; letter-spacing: 0.5px; }
        .ps-net-amount { font-size: 24px; font-weight: 900; color: #065f46; display: block; margin: 4px 0; }
        .ps-net-words { font-size: 10px; color: #6b7280; }
        .ps-att-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 4px; margin-bottom: 14px; }
        .ps-att-item { text-align: center; padding: 6px 4px; background: #f9fafb; border-radius: 4px; border: 1px solid #f3f4f6; }
        .ps-att-val { font-size: 11px; font-weight: 800; }
        .ps-att-lbl { font-size: 8px; color: #9ca3af; text-transform: uppercase; }
        .ps-att-lop { background: #fef2f2; border-color: #fecaca; }
        .ps-att-lop .ps-att-val { color: #dc2626; }
        .ps-signatures { display: flex; justify-content: space-between; padding-top: 24px; border-top: 1px solid #e5e7eb; }
        .ps-sig { text-align: center; }
        .ps-sig-line { width: 100px; height: 1px; background: #d1d5db; margin: 0 auto 4px; }
        .ps-sig span { font-size: 9px; color: #9ca3af; }
        @media print { body { padding: 12px; } }
      </style></head><body>
      <div class="ps-wrap">
        <div class="ps-header">
          <div class="ps-logo">
            <div class="ps-logo-icon">₹</div>
            <div><div class="ps-company">${company?.name || 'Company Payroll'}</div><div class="ps-subtitle">Official Salary Slip</div></div>
          </div>
          <div class="ps-period"><div class="ps-period-label">Salary Slip</div><div class="ps-period-val">${MONTHS_SHORT[month-1]} ${year}</div></div>
        </div>
        <div class="ps-details">
          <div class="ps-detail"><span>Employee Name</span><strong>${empName}</strong></div>
          <div class="ps-detail"><span>Department</span><strong>${empDept}</strong></div>
          <div class="ps-detail"><span>Pay Period</span><strong>${MONTHS[month-1]} ${year}</strong></div>
          <div class="ps-detail"><span>Employee Code</span><strong>${empCode}</strong></div>
          <div class="ps-detail"><span>Designation</span><strong>${empRole}</strong></div>
          <div class="ps-detail"><span>Gross Salary</span><strong>${fmtINR(payroll.gross)}</strong></div>
        </div>
        ${payroll.lopDays > 0 ? `<div class="ps-lop">⚠ LOP: ${payroll.lopDays} days deducted · ${fmtINR(payroll.lopDeduction)} reduced from gross</div>` : ''}
        <div class="ps-table-wrap">
          <div class="ps-col">
            <div class="ps-col-header earn">EARNINGS</div>
            <div class="ps-col-body">
              <div class="ps-line"><span>Basic Salary</span><span>${fmtINR(payroll.basicAmt)}</span></div>
              <div class="ps-line"><span>HRA</span><span>${fmtINR(payroll.hraAmt)}</span></div>
              <div class="ps-line"><span>Conveyance</span><span>${fmtINR(payroll.conveyanceAmt)}</span></div>
              <div class="ps-line"><span>CCA</span><span>${fmtINR(payroll.ccaAmt)}</span></div>
              <div class="ps-line"><span>Medical</span><span>${fmtINR(payroll.medicalAmt)}</span></div>
              ${payroll.overtimeEarnings > 0 ? `<div class="ps-line"><span>Overtime</span><span>${fmtINR(payroll.overtimeEarnings)}</span></div>` : ''}
            </div>
            <div class="ps-col-total earn"><span>Total Earnings</span><strong>${fmtINR(payroll.totalEarnings + payroll.overtimeEarnings)}</strong></div>
          </div>
          <div class="ps-col">
            <div class="ps-col-header ded">DEDUCTIONS</div>
            <div class="ps-col-body">
              <div class="ps-line"><span>PF (${structure.pfPercent}% of Basic)</span><span>${fmtINR(payroll.pfAmt)}</span></div>
              <div class="ps-line"><span>TDS (${structure.taxPercent}%)</span><span>${fmtINR(payroll.tdsAmt)}</span></div>
              ${payroll.advanceAdj > 0 ? `<div class="ps-line"><span>Advance Adj.</span><span>${fmtINR(payroll.advanceAdj)}</span></div>` : ''}
            </div>
            <div class="ps-col-total ded"><span>Total Deductions</span><strong>${fmtINR(payroll.totalDeductions)}</strong></div>
          </div>
        </div>
        <div class="ps-net">
          <div class="ps-net-label">NET PAYABLE SALARY</div>
          <span class="ps-net-amount">${fmtINR(payroll.netPayable)}</span>
          <div class="ps-net-words">In Words: ${numberToWords(payroll.netPayable)}</div>
        </div>
        <div class="ps-att-grid">
          <div class="ps-att-item"><div class="ps-att-val">${attendance.totalDays}</div><div class="ps-att-lbl">Calendar Days</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${attendance.payableDays}</div><div class="ps-att-lbl">Payable Days</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${attendance.presentDays}</div><div class="ps-att-lbl">Present</div></div>
          <div class="ps-att-item ps-att-lop"><div class="ps-att-val">${payroll.lopDays}</div><div class="ps-att-lbl">LOP Days</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${attendance.paidDays}</div><div class="ps-att-lbl">Paid Days</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${attendance.casualLeave}</div><div class="ps-att-lbl">CL</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${attendance.sickLeave}</div><div class="ps-att-lbl">SL</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${attendance.paidLeave}</div><div class="ps-att-lbl">PL</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${attendance.overtimeHours}</div><div class="ps-att-lbl">OT Hrs</div></div>
          <div class="ps-att-item"><div class="ps-att-val">${payroll.attendancePct}%</div><div class="ps-att-lbl">Attendance</div></div>
        </div>
        <div class="ps-signatures">
          <div class="ps-sig"><div class="ps-sig-line"></div><span>Authorized Signatory</span></div>
          <div class="ps-sig"><div class="ps-sig-line"></div><span>Employee Signature</span></div>
        </div>
      </div></body></html>
    `)
    win.document.close()
    setTimeout(() => { win.print(); win.close() }, 300)
  }

  if (loading) {
  return (
      <div className="epc-loading">
        <Loader2 size={28} className="animate-spin text-emerald-500" />
        <p className="text-sm text-gray-500 mt-2">Loading payroll data…</p>
      </div>
    )
  }

  const doneButtonLabel = payslipStatus === 'approved' ? 'Approved ✓'
    : payslipStatus === 'published' ? 'Done (Approve)'
    : 'Done (Publish & Lock)'

  const doneButtonDisabled = payslipStatus === 'approved' || approving || publishing

  return (
    <div className="epc-root">
      {/* Toast */}
      {toast && (
        <div className={`epc-toast ${toast.type === 'success' ? 'epc-toast-success' : 'epc-toast-error'}`}>
          {toast.type === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          <span>{toast.msg}</span>
          <button onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}

      {/* ═══ TOP EMPLOYEE HEADER ═══ */}
      <div className="epc-header-card">
        <div className="epc-header-left">
          <div className="epc-avatar">
            {empName.charAt(0).toUpperCase()}
          </div>
          <div className="epc-header-info">
            <h2 className="epc-emp-name">{empName}</h2>
            <p className="epc-emp-meta">{empRole} · {empDept} · EMP : {empCode}</p>
          </div>
          <div className="epc-pay-period-badge">
            <span className="epc-badge-label">PAY PERIOD</span>
            <span className="epc-badge-value">{MONTHS_SHORT[month - 1]} {year}</span>
        </div>
        </div>
        <div className="epc-header-right">
          <select value={month} onChange={e => setMonth(Number(e.target.value))} className="epc-select">
              {MONTHS_SHORT.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))} className="epc-select">
            {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          <button className="epc-btn-icon" onClick={() => { fetchPreview(); loadPayslipStatus() }} title="Refresh">
            <RefreshCw size={15} />
          </button>
          <button className="epc-btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            <span>{saving ? 'Saving…' : 'Save'}</span>
          </button>
          <button className="epc-btn-primary" onClick={handlePrint} title="Print Payslip">
            <Printer size={14} />
            <span>Print</span>
          </button>
        </div>
      </div>

      {/* ═══ PAYROLL METRIC STRIP ═══ */}
      <div className="epc-metric-strip">
        <div className="epc-metric-card epc-metric-blue">
          <span className="epc-metric-label">GROSS SALARY</span>
          <span className="epc-metric-value">{fmtINR(payroll.gross)}</span>
        </div>
        <div className="epc-metric-card epc-metric-blue">
          <span className="epc-metric-label">PER DAY SALARY</span>
          <span className="epc-metric-value">{fmtINR(payroll.perDay)}</span>
      </div>
        <div className="epc-metric-card epc-metric-red">
          <span className="epc-metric-label">LOP DAYS</span>
          <span className="epc-metric-value">{payroll.lopDays}</span>
        </div>
        <div className="epc-metric-card epc-metric-red">
          <span className="epc-metric-label">LOP DEDUCTION</span>
          <span className="epc-metric-value">−{fmtINR(Math.abs(payroll.lopDeduction))}</span>
            </div>
        <div className="epc-metric-card epc-metric-green">
          <span className="epc-metric-label">EFFECTIVE GROSS</span>
          <span className="epc-metric-value">{fmtINR(payroll.effectiveGross)}</span>
              </div>
        <div className="epc-metric-card epc-metric-green">
          <span className="epc-metric-label">NET PAYABLE</span>
          <span className="epc-metric-value">{fmtINR(payroll.netPayable)}</span>
        </div>
      </div>
      <p className="epc-metric-footer">
        {attendance.presentDays} present · {payroll.lopDays} LOP · {attendance.attendanceWorkingDays} attendance-tracked working days
      </p>
      {isMtdPeriod && (
        <div className="epc-mtd-banner">
          <Calendar size={14} className="shrink-0 text-emerald-600" />
          <span>
            <strong>Month-to-date:</strong> figures use attendance and policy through day{' '}
            <strong>{preview?.syncedThroughDay ?? '—'}</strong> only (not the full month ahead).
          </span>
        </div>
      )}

      {/* ═══ MAIN CONTENT: LEFT + RIGHT ═══ */}
      <div className="epc-main-layout">
        {/* LEFT COLUMN */}
        <div className="epc-left-col">

          {/* CARD 1: Gross Monthly Salary */}
          <div className="epc-card">
            <div className="epc-card-header">
              <h3 className="epc-card-title">
                <DollarSign size={16} className="text-emerald-500" />
                Gross Monthly Salary
              </h3>
            </div>
            <div className="epc-salary-input-wrap">
              <span className="epc-rupee-prefix">₹</span>
            <input
              type="number"
              min={0}
              step={1000}
              value={monthlySalary || ''}
              onChange={e => setMonthlySalary(parseFloat(e.target.value) || 0)}
                className="epc-salary-input"
              />
        </div>
            <div className="epc-salary-calc-row">
              <div className="epc-calc-item">
                <span className="epc-calc-label">Calendar days (divisor)</span>
                <span className="epc-calc-value">{payroll.divisor}</span>
      </div>
              <div className="epc-calc-item">
                <span className="epc-calc-label">Payable day-units (MTD)</span>
                <span className="epc-calc-value">{payroll.paidDays}</span>
      </div>
              <div className="epc-calc-item">
                <span className="epc-calc-label">Per day salary</span>
                <span className="epc-calc-value">{fmtINR(payroll.perDay)}</span>
        </div>
              <div className="epc-calc-item">
                <span className="epc-calc-label">Basis</span>
                <span className="epc-calc-value">{`${new Date(year, month, 0).getDate()} calendar days (${MONTHS_SHORT[month - 1]} ${year})`}</span>
        </div>
              <div className="epc-calc-item">
                <span className="epc-calc-label">LOP Deduction</span>
                <span className="epc-calc-value epc-text-red">−{fmtINR(Math.abs(payroll.lopDeduction))}</span>
        </div>
              <div className="epc-calc-item">
                <span className="epc-calc-label">Effective Gross</span>
                <span className="epc-calc-value epc-text-green">{fmtINR(payroll.effectiveGross)}</span>
        </div>
      </div>
            <div className="epc-helper-text">
              <p><strong>Per day salary</strong> = Monthly Gross ÷ actual calendar days in the payroll month (e.g. 31 for March). Payroll accruals use days elapsed toward month-end attendance (MTD).</p>
              <p><strong>LOP Deduction</strong> = Per Day × LOP days. LOP = Payable Days − (Present + CL + SL + PL + Holidays + Half Days/2).</p>
              <p><strong>Effective Gross (MTD)</strong> = Per day × payable day-units (Present + leaves + holidays + weekends in period). All earnings percentages are computed on this amount.</p>
        </div>
            <p className="epc-helper-footer">
              ({attendance.presentDays} present of {attendance.attendanceWorkingDays} attendance-tracked working days — {autoMode ? 'auto-fetched' : 'manually entered'})
            </p>
          </div>

          {/* CARD 2: Payroll Attendance Engine */}
          <div className="epc-card">
            <div className="epc-card-header">
              <h3 className="epc-card-title">
                <Calendar size={16} className="text-emerald-500" />
                Payroll Attendance Engine
              </h3>
              <span className="epc-live-badge">
                <Database size={12} />
                {autoMode ? 'Live from DB' : 'Manual Edit'}
              </span>
            </div>
            <div className="epc-engine-actions">
            <button
                className={`epc-engine-btn ${autoMode ? 'active' : ''}`}
                onClick={() => { setAutoMode(true); setEditMode(false); fetchPreview() }}
            >
                <Zap size={13} />
                Auto Mode {autoMode ? 'ON' : 'OFF'}
            </button>
              <button
                className={`epc-engine-btn ${editMode ? 'active' : ''}`}
                onClick={handleEditManually}
              >
                <Edit3 size={13} />
                Edit Manually
              </button>
              <button className="epc-engine-btn" onClick={handleResetAttendance}>
                <RotateCcw size={13} />
                Reset
              </button>
              <button className="epc-engine-btn-icon" onClick={fetchPreview}>
                <RefreshCw size={13} />
              </button>
      </div>
            {autoMode && (
              <div className="epc-sync-card">
                <CheckCircle2 size={14} className="text-emerald-500" />
                <span>Attendance synced from <strong>{attendance.presentDays}</strong> attendance records and <strong>{(attendance.casualLeave || 0) + (attendance.sickLeave || 0) + (attendance.paidLeave || 0)}</strong> approved leave records.</span>
                </div>
            )}
            {editMode && (
              <div className="epc-edit-card">
                <Edit3 size={14} className="text-amber-500" />
                <span>Manual edit mode — attendance fields are editable. Changes are local until saved.</span>
                </div>
            )}
            <div className="epc-sync-meta">
              <div className="epc-sync-item">
                <span className="epc-sync-label">Last Synced</span>
                <span className="epc-sync-value">{new Date().toLocaleDateString('en-IN')} {new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>
              <div className="epc-sync-item">
                <span className="epc-sync-label">Attendance Records</span>
                <span className="epc-sync-value">{attendance.presentDays}</span>
                    </div>
              <div className="epc-sync-item">
                <span className="epc-sync-label">Approved Leaves</span>
                <span className="epc-sync-value">{(attendance.casualLeave || 0) + (attendance.sickLeave || 0) + (attendance.paidLeave || 0)}</span>
                  </div>
              <div className="epc-sync-item">
                <span className="epc-sync-label">Paid Holidays</span>
                <span className="epc-sync-value">{attendance.paidHolidays}</span>
              </div>
                </div>
                </div>

          {/* PAYROLL SUMMARY MINI CARDS */}
          <div className="epc-mini-metric-row">
            <div className="epc-mini-metric epc-mini-blue">
              <span className="epc-mini-label">GROSS SALARY</span>
              <span className="epc-mini-value">{fmtINRShort(payroll.gross)}</span>
                      </div>
            <div className="epc-mini-metric epc-mini-blue">
              <span className="epc-mini-label">PER DAY SALARY</span>
              <span className="epc-mini-value">{fmtINR(payroll.perDay)}</span>
                    </div>
            <div className="epc-mini-metric epc-mini-red">
              <span className="epc-mini-label">LOP DAYS</span>
              <span className="epc-mini-value">{payroll.lopDays}</span>
                  </div>
            <div className="epc-mini-metric epc-mini-red">
              <span className="epc-mini-label">LOP DEDUCTION</span>
              <span className="epc-mini-value">{fmtINR(payroll.lopDeduction)}</span>
              </div>
            <div className="epc-mini-metric epc-mini-green">
              <span className="epc-mini-label">EFFECTIVE GROSS</span>
              <span className="epc-mini-value">{fmtINR(payroll.effectiveGross)}</span>
            </div>
            <div className="epc-mini-metric epc-mini-green">
              <span className="epc-mini-label">NET PAYABLE</span>
              <span className="epc-mini-value">{fmtINR(payroll.netPayable)}</span>
            </div>
          </div>

          {/* ATTENDANCE DETAILS GRID */}
          <div className="epc-card">
            <div className="epc-att-grid">
              <div className="epc-att-row">
                <div className="epc-att-cell">
                  <span className="epc-att-label">TOTAL DAYS</span>
                  <input type="number" className="epc-att-input" value={attendance.totalDays}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('totalDays', e.target.value)} />
                </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">SUNDAYS</span>
                  <input type="number" className="epc-att-input" value={attendance.sundays}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('sundays', e.target.value)} />
                </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">SATURDAYS OFF</span>
                  <input type="number" className="epc-att-input" value={attendance.saturdaysOff}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('saturdaysOff', e.target.value)} />
                    </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">PAID HOLIDAYS</span>
                  <input type="number" className="epc-att-input" value={attendance.paidHolidays}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('paidHolidays', e.target.value)} />
                    </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">PAYABLE DAYS</span>
                  <input type="number" className="epc-att-input epc-att-highlight" value={attendance.payableDays}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('payableDays', e.target.value)} />
                      </div>
                  </div>

              <div className="epc-att-section-label">
                <Calendar size={13} />
                ATTENDANCE WORKING DAYS
              </div>

              <div className="epc-att-row">
                <div className="epc-att-cell">
                  <span className="epc-att-label">PRESENT DAYS</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.presentDays}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('presentDays', e.target.value)} />
                </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">CASUAL LEAVE</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.casualLeave}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('casualLeave', e.target.value)} />
                </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">SICK LEAVE</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.sickLeave}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('sickLeave', e.target.value)} />
                    </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">PAID LEAVE</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.paidLeave}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('paidLeave', e.target.value)} />
                    </div>
                  </div>

              <div className="epc-att-note">Tracked workdays only — not used as salary divisor</div>

              <div className="epc-att-row">
                <div className="epc-att-cell">
                  <span className="epc-att-label">HALF DAYS</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.halfDays}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('halfDays', e.target.value)} />
              </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">OVERTIME HOURS</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.overtimeHours}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('overtimeHours', e.target.value)} />
            </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">LATE MARKS</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.lateMarks}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('lateMarks', e.target.value)} />
                </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">EARLY EXITS</span>
                  <input type="number" className={`epc-att-input ${editMode ? 'epc-att-editable' : ''}`} value={attendance.earlyExits}
                    readOnly={!editMode} onChange={e => handleAttendanceChange('earlyExits', e.target.value)} />
                </div>
                <div className="epc-att-cell">
                  <span className="epc-att-label">PAID DAYS</span>
                  <input type="number" className="epc-att-input" value={payroll.paidDays} readOnly />
                </div>
              </div>

              <div className="epc-att-row epc-att-row-lop">
                <div className="epc-att-cell epc-att-cell-lop">
                  <span className="epc-att-label">LOP / ABSENT</span>
                  <input type="number" className="epc-att-input epc-att-lop" value={payroll.lopDays} readOnly />
                  </div>
              </div>
              </div>

            {/* Bottom summary */}
            <div className="epc-att-summary-row">
              <div className="epc-att-summary-card">
                <span className="epc-att-sum-val">{attendance.payableDays}</span>
                <span className="epc-att-sum-label">Payable days</span>
                  </div>
              <div className="epc-att-summary-card">
                <span className="epc-att-sum-val">{payroll.paidDays}</span>
                <span className="epc-att-sum-label">Paid days</span>
                </div>
              <div className="epc-att-summary-card">
                <span className="epc-att-sum-val">{fmtINRShort(payroll.overtimeEarnings)}</span>
                <span className="epc-att-sum-label">Overtime Earnings</span>
              </div>
              <div className="epc-att-summary-card">
                <span className="epc-att-sum-val">{payroll.attendancePct}%</span>
                <span className="epc-att-sum-label">Attendance %</span>
              </div>
            </div>
          </div>

          {/* CARD 3: Earnings Structure */}
          <div className="epc-card">
            <div className="epc-card-header">
              <h3 className="epc-card-title">
                <BarChart3 size={16} className="text-emerald-500" />
                Earnings Structure
              </h3>
              <span className="epc-structure-pct">
                {payroll.earningPctTotal.toFixed(2)}% / 100%
              </span>
                </div>
            <div className="epc-progress-bar">
              <div className="epc-progress-fill" style={{ width: `${Math.min(100, payroll.earningPctTotal)}%` }} />
            </div>
            <p className="epc-structure-note">
              <CheckCircle2 size={12} className="text-emerald-500" />
              {payroll.earningPctTotal === 100 ? 'Total = 100% — Structure complete' :
               payroll.earningPctTotal > 100 ? `Warning: Total exceeds 100% (${payroll.earningPctTotal.toFixed(1)}%)` :
               `Total = ${payroll.earningPctTotal.toFixed(1)}% — ${(100 - payroll.earningPctTotal).toFixed(1)}% remaining`}
            </p>

            <table className="epc-structure-table">
                  <thead>
                <tr>
                  <th>Component</th>
                  <th>%</th>
                  <th>Amount</th>
                </tr>
                  </thead>
                  <tbody>
                {[
                  { key: 'basicPercent', label: 'Basic Salary', dot: 'epc-dot-blue', amt: payroll.basicAmt },
                  { key: 'hraPercent', label: 'HRA', dot: 'epc-dot-purple', amt: payroll.hraAmt },
                  { key: 'conveyancePercent', label: 'Conveyance Allowance', dot: 'epc-dot-teal', amt: payroll.conveyanceAmt },
                  { key: 'ccaPercent', label: 'CCA', dot: 'epc-dot-orange', amt: payroll.ccaAmt },
                  { key: 'medicalPercent', label: 'Medical', dot: 'epc-dot-pink', amt: payroll.medicalAmt },
                  { key: 'otherAllowancePercent', label: 'Other Allowance', dot: 'epc-dot-gray', amt: payroll.otherAllowAmt },
                ].map(row => (
                  <tr key={row.key}>
                    <td>
                      <span className={`epc-component-dot ${row.dot}`} />
                      {row.label}
                    </td>
                    <td>
                      <input
                        type="number"
                        className="epc-pct-input"
                        value={structure[row.key]}
                        onChange={e => handleStructureChange(row.key, e.target.value)}
                        min={0} max={100} step={0.5}
                      />
                      <span className="epc-pct-symbol">%</span>
                    </td>
                    <td className="epc-amt-cell">{fmtINR(row.amt)}</td>
                      </tr>
                    ))}
                  </tbody>
              <tfoot>
                <tr className="epc-structure-total">
                  <td><strong>Total Earnings</strong></td>
                  <td><strong>{payroll.earningPctTotal.toFixed(0)}%</strong></td>
                  <td className="epc-amt-cell"><strong>{fmtINR(payroll.totalEarnings)}</strong></td>
                </tr>
              </tfoot>
                </table>

            {/* Deductions Section */}
            <div className="epc-deduction-header">
              <h4>Deductions</h4>
                </div>
            <table className="epc-structure-table epc-deduction-table">
                  <thead>
                <tr>
                  <th>Component</th>
                  <th>%</th>
                  <th>Amount</th>
                </tr>
                  </thead>
                  <tbody>
                <tr>
                  <td><span className="epc-component-dot epc-dot-red" />PF (on Basic)</td>
                  <td>
                    <input type="number" className="epc-pct-input" value={structure.pfPercent}
                      onChange={e => handleStructureChange('pfPercent', e.target.value)} min={0} max={30} step={0.5} />
                    <span className="epc-pct-symbol">%</span>
                  </td>
                  <td className="epc-amt-cell epc-text-red">-{fmtINR(payroll.pfAmt)}</td>
                      </tr>
                <tr>
                  <td><span className="epc-component-dot epc-dot-amber" />TDS (Income Tax)</td>
                  <td>
                    <input type="number" className="epc-pct-input" value={structure.taxPercent}
                      onChange={e => handleStructureChange('taxPercent', e.target.value)} min={0} max={40} step={0.5} />
                    <span className="epc-pct-symbol">%</span>
                  </td>
                  <td className="epc-amt-cell epc-text-red">-{fmtINR(payroll.tdsAmt)}</td>
                      </tr>
                <tr>
                  <td><span className="epc-component-dot epc-dot-gray" />Advance Adjustment</td>
                  <td>
                    <input type="number" className="epc-pct-input" value={structure.advanceDeduction || 0}
                      onChange={e => handleStructureChange('advanceDeduction', e.target.value)} min={0} step={100}
                      style={{ width: '60px' }} />
                    <span className="epc-pct-symbol">₹</span>
                  </td>
                  <td className="epc-amt-cell epc-text-red">-{fmtINR(payroll.advanceAdj)}</td>
                    </tr>
                  </tbody>
              <tfoot>
                <tr className="epc-structure-total epc-deduction-total">
                  <td><strong>Total Deductions</strong></td>
                  <td></td>
                  <td className="epc-amt-cell epc-text-red"><strong>-{fmtINR(payroll.totalDeductions)}</strong></td>
                </tr>
              </tfoot>
                </table>
          </div>

          {/* Payslip history (stored slips) */}
          <div className="epc-card epc-history-card">
            <div className="epc-card-header">
              <h3 className="epc-card-title">
                <Calendar size={16} className="text-emerald-500" />
                Payslip history
              </h3>
            </div>
            {payslipHistory.length === 0 ? (
              <p className="epc-history-empty">No payslips stored for this employee yet.</p>
            ) : (
              <div className="epc-history-table-wrap">
                <table className="epc-history-table">
                  <thead>
                    <tr>
                      <th>Period</th>
                      <th>Status</th>
                      <th className="epc-hnum">Net</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payslipHistory.map(row => (
                      <tr key={`${row.year}-${row.month}-${row.id || ''}`}>
                        <td>{MONTHS_SHORT[(row.month || 1) - 1]} {row.year}</td>
                        <td>
                          <span className={`epc-hstat epc-hstat-${row.status || 'none'}`}>{row.status || '—'}</span>
                        </td>
                        <td className="epc-hnum">{fmtINR(row.net_salary)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* ═══ RIGHT COLUMN — LIVE PAYSLIP PREVIEW ═══ */}
        <div className="epc-right-col">
          {/* DONE / APPROVED BUTTON */}
          <div className="epc-done-btn-wrap">
            <button
              className={`epc-done-btn ${payslipStatus === 'approved' ? 'epc-done-approved' : ''}`}
              onClick={handlePublishAndApprove}
              disabled={doneButtonDisabled}
            >
              {(approving || publishing) ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
              <span>{doneButtonLabel}</span>
            </button>
            {payslipStatus === 'approved' && (
              <p className="epc-done-note">Employee can now download this payslip</p>
            )}
            {payslipStatus === 'approved' && (
              <button
                type="button"
                className="epc-revoke-btn"
                disabled={revoking}
                onClick={handleRevokeApproval}
              >
                {revoking ? <Loader2 size={14} className="animate-spin" /> : null}
                Revoke approval (allow edits)
              </button>
            )}
                  </div>

          <div className="epc-payslip-card" ref={payslipRef}>
            {/* Payslip Header */}
            <div className="epc-payslip-header">
              <div className="epc-payslip-logo">
                <div className="epc-payslip-logo-icon">
                  <DollarSign size={18} />
                </div>
                  <div>
                  <h4 className="epc-payslip-company">{company?.name || 'Company Payroll'}</h4>
                  <p className="epc-payslip-subtitle">Official Salary Slip</p>
                  </div>
                  </div>
              <div className="epc-payslip-period">
                <span className="epc-payslip-period-label">Salary Slip</span>
                <span className="epc-payslip-period-value">{MONTHS_SHORT[month - 1]} {year}</span>
                </div>
              </div>

            {/* Employee Details */}
            <div className="epc-payslip-details">
              <div className="epc-payslip-detail-row"><span>Employee Name</span><strong>{empName}</strong></div>
              <div className="epc-payslip-detail-row"><span>Department</span><strong>{empDept}</strong></div>
              <div className="epc-payslip-detail-row"><span>Pay Period</span><strong>{MONTHS[month - 1]} {year}</strong></div>
              <div className="epc-payslip-detail-row"><span>Employee Code</span><strong>{empCode}</strong></div>
              <div className="epc-payslip-detail-row"><span>Designation</span><strong>{empRole}</strong></div>
              <div className="epc-payslip-detail-row"><span>Gross Salary</span><strong>{fmtINR(payroll.gross)}</strong></div>
            </div>

            {/* LOP Warning */}
            {payroll.lopDays > 0 && (
              <div className="epc-payslip-lop-warning">
                <AlertTriangle size={13} />
                <span>LOP: {payroll.lopDays} days deducted · {fmtINR(payroll.lopDeduction)} reduced from gross</span>
            </div>
          )}

            {/* Earnings vs Deductions Table */}
            <div className="epc-payslip-table-wrap">
              <div className="epc-payslip-col">
                <div className="epc-payslip-col-header epc-earn">EARNINGS</div>
                <div className="epc-payslip-col-body">
                  <div className="epc-payslip-line"><span>Basic Salary</span><span>{fmtINR(payroll.basicAmt)}</span></div>
                  <div className="epc-payslip-line"><span>HRA</span><span>{fmtINR(payroll.hraAmt)}</span></div>
                  <div className="epc-payslip-line"><span>Conveyance</span><span>{fmtINR(payroll.conveyanceAmt)}</span></div>
                  <div className="epc-payslip-line"><span>CCA</span><span>{fmtINR(payroll.ccaAmt)}</span></div>
                  <div className="epc-payslip-line"><span>Medical</span><span>{fmtINR(payroll.medicalAmt)}</span></div>
                  {payroll.overtimeEarnings > 0 && (
                    <div className="epc-payslip-line"><span>Overtime</span><span>{fmtINR(payroll.overtimeEarnings)}</span></div>
                  )}
                </div>
                <div className="epc-payslip-col-total epc-earn">
                  <span>Total Earnings</span>
                  <strong>{fmtINR(payroll.totalEarnings + payroll.overtimeEarnings)}</strong>
                </div>
              </div>
              <div className="epc-payslip-col">
                <div className="epc-payslip-col-header epc-ded">DEDUCTIONS</div>
                <div className="epc-payslip-col-body">
                  <div className="epc-payslip-line"><span>PF</span><span>{fmtINR(payroll.pfAmt)}</span></div>
                  <div className="epc-payslip-line"><span>TDS</span><span>{fmtINR(payroll.tdsAmt)}</span></div>
                  {payroll.advanceAdj > 0 && (
                    <div className="epc-payslip-line"><span>Advance Adj.</span><span>{fmtINR(payroll.advanceAdj)}</span></div>
                  )}
                </div>
                <div className="epc-payslip-col-total epc-ded">
                  <span>Total Deductions</span>
                  <strong>{fmtINR(payroll.totalDeductions)}</strong>
                </div>
              </div>
            </div>

            {/* Net Payable Footer */}
            <div className="epc-payslip-net">
              <span className="epc-payslip-net-label">NET PAYABLE SALARY</span>
              <span className="epc-payslip-net-amount">{fmtINR(payroll.netPayable)}</span>
              <span className="epc-payslip-net-words">In Words: {numberToWords(payroll.netPayable)}</span>
            </div>

            {/* Attendance Mini Grid */}
            <div className="epc-payslip-att-grid">
              {[
                { val: attendance.totalDays, label: 'Calendar Days' },
                { val: attendance.payableDays, label: 'Payable Days' },
                { val: attendance.sundays, label: 'Weekends' },
                { val: attendance.paidHolidays, label: 'Holidays' },
                { val: attendance.presentDays, label: 'Present' },
                { val: attendance.casualLeave, label: 'CL' },
                { val: attendance.sickLeave, label: 'SL' },
                { val: attendance.paidLeave, label: 'PL' },
                { val: attendance.halfDays, label: 'Half Days' },
                { val: payroll.paidDays, label: 'Paid Days' },
                { val: payroll.lopDays, label: 'LOP Days', lop: true },
                { val: fmtINR(payroll.perDay, 0), label: 'Per Day' },
                { val: attendance.overtimeHours, label: 'OT Hrs' },
                { val: attendance.lateMarks, label: 'Late' },
                { val: attendance.earlyExits, label: 'Early Exit' },
              ].map((item, i) => (
                <div key={i} className={`epc-payslip-att-item ${item.lop ? 'epc-pag-lop' : ''}`}>
                  <span className="epc-pag-val">{item.val}</span>
                  <span className="epc-pag-label">{item.label}</span>
                </div>
              ))}
            </div>

            {/* Signatures */}
            <div className="epc-payslip-signatures">
              <div className="epc-signature-block">
                <div className="epc-signature-line" />
                <span>HR Signature</span>
              </div>
              <div className="epc-signature-block">
                <div className="epc-signature-line" />
                <span>Employee Signature</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
