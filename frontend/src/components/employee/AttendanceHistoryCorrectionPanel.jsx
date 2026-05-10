import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, History, ShieldCheck } from 'lucide-react'
import { apiFetch } from '../../api'
import {
  calendarMonthStartDateKey,
  dateKeyOffsetFromToday,
  formatDateInput,
  formatWeekdayFromDateKey,
  isWeekendDateKey,
  listDateKeysInRange,
  normalizeAttendanceRow,
} from '../../utils/helpers'

const CORRECTION_DRAFT_KEY = 'employee_correction_draft_v1'

const REQUEST_TYPES = [
  { value: 'forgot_punch_in', label: 'Forgot Punch In' },
  { value: 'forgot_punch_out', label: 'Forgot Punch Out' },
  { value: 'wrong_check_in_time', label: 'Wrong Check-In Time' },
  { value: 'location_issue', label: 'Location Issue' },
  { value: 'camera_verification_failed', label: 'Camera Verification Failed' },
  { value: 'system_error', label: 'System Error' },
  { value: 'wfh_attendance_missing', label: 'WFH Attendance Missing' },
  { value: 'manual_attendance_request', label: 'Manual Attendance Request' },
]

function readCorrectionDraft() {
  try {
    const raw = localStorage.getItem(CORRECTION_DRAFT_KEY)
    if (!raw) {
      return {
        requestType: 'forgot_punch_in',
        date: formatDateInput(),
        expectedCheckIn: '',
        expectedCheckOut: '',
        reason: '',
        emergencyComment: '',
        attachment: null,
        attachmentName: '',
      }
    }
    const parsed = JSON.parse(raw)
    return {
      requestType: String(parsed?.requestType || 'forgot_punch_in'),
      date: String(parsed?.date || formatDateInput()),
      expectedCheckIn: String(parsed?.expectedCheckIn || ''),
      expectedCheckOut: String(parsed?.expectedCheckOut || ''),
      reason: String(parsed?.reason || ''),
      emergencyComment: String(parsed?.emergencyComment || ''),
      attachment: null,
      attachmentName: '',
    }
  } catch {
    return {
      requestType: 'forgot_punch_in',
      date: formatDateInput(),
      expectedCheckIn: '',
      expectedCheckOut: '',
      reason: '',
      emergencyComment: '',
      attachment: null,
      attachmentName: '',
    }
  }
}

function saveCorrectionDraft(form) {
  try {
    localStorage.setItem(CORRECTION_DRAFT_KEY, JSON.stringify({
      requestType: form.requestType,
      date: form.date,
      expectedCheckIn: form.expectedCheckIn,
      expectedCheckOut: form.expectedCheckOut,
      reason: form.reason,
      emergencyComment: form.emergencyComment,
    }))
  } catch {
    // no-op
  }
}

function parseTimeToMinutes(value) {
  const text = String(value || '').trim().toLowerCase()
  if (!text) return null

  const ampm = text.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/i)
  if (ampm) {
    let h = Number(ampm[1])
    const m = Number(ampm[2])
    const period = String(ampm[3] || '').toLowerCase()
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null
    if (period === 'pm' && h < 12) h += 12
    if (period === 'am' && h === 12) h = 0
    if (h < 0 || h > 23 || m < 0 || m > 59) return null
    return (h * 60) + m
  }

  const basic = text.match(/^(\d{1,2}):(\d{2})$/)
  if (!basic) return null
  const h = Number(basic[1])
  const m = Number(basic[2])
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  if (h < 0 || h > 23 || m < 0 || m > 59) return null
  return (h * 60) + m
}

function formatMinutes(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n) || n <= 0) return '0h 0m'
  const h = Math.floor(n / 60)
  const m = Math.floor(n % 60)
  return `${h}h ${m}m`
}

function formatWorkingHours(row) {
  const inM = parseTimeToMinutes(row?.check_in)
  const outM = parseTimeToMinutes(row?.check_out)
  if (inM == null || outM == null) return '-'
  let diff = outM - inM
  if (diff < 0) diff += (24 * 60)
  return formatMinutes(diff)
}

function workingMinutes(row) {
  const inM = parseTimeToMinutes(row?.check_in)
  const outM = parseTimeToMinutes(row?.check_out)
  if (inM == null || outM == null) return 0
  let diff = outM - inM
  if (diff < 0) diff += (24 * 60)
  return Math.max(0, diff)
}

function attendanceStatusKey(row) {
  const raw = String(row?.status || '').trim().toLowerCase()
  const timing = String(row?.timing_status || '').trim().toLowerCase()
  const reason = String(row?.manual_reason || '').trim().toLowerCase()
  const dateKey = String(row?.date || '').trim()

  if (dateKey) {
    const day = new Date(`${dateKey}T00:00:00`).getDay()
    if (day === 0 || day === 6) return 'holiday'
  }

  if (reason.includes('wfh') || raw.includes('wfh') || timing.includes('wfh')) return 'work_from_home'
  if (raw.includes('leave') || timing.includes('leave')) return 'leave'
  if (raw.includes('absent')) return 'absent'
  if (raw.includes('late') || timing.includes('late')) return 'late'

  const mins = workingMinutes(row)
  if (mins > 0 && mins < 240) return 'half_day'

  if (mins > 0 || raw.includes('check')) return 'present'
  return 'absent'
}

function attendanceStatusLabel(row) {
  const key = attendanceStatusKey(row)
  if (key === 'present') return 'Present'
  if (key === 'absent') return 'Absent'
  if (key === 'late') return 'Late'
  if (key === 'half_day') return 'Half Day'
  if (key === 'work_from_home') return 'Work From Home'
  if (key === 'leave') return 'Leave'
  return 'Holiday'
}

function correctionStatusKey(row) {
  const status = String(row?.status || '').trim().toLowerCase()
  if (status === 'approved') return 'approved'
  if (status === 'rejected' || status === 'conflict') return 'rejected'
  return 'pending'
}

function correctionStatusLabel(row) {
  const status = correctionStatusKey(row)
  if (status === 'approved') return 'Approved'
  if (status === 'rejected') return 'Rejected'
  return 'Pending'
}

function issueTypeLabel(row) {
  const key = String(row?.issue_type || '').trim().toLowerCase()
  const hit = REQUEST_TYPES.find((x) => x.value === key)
  if (hit) return hit.label
  const reqType = String(row?.request_type || '').trim().toLowerCase()
  if (reqType === 'wfh') return 'WFH Attendance Missing'
  return 'Manual Attendance Request'
}

function csvEscape(value) {
  const text = String(value ?? '')
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

export default function AttendanceHistoryCorrectionPanel({
  attendanceState,
  attendanceTimes,
  canPunchIn,
  canPunchOut,
  onPunchIn,
  onPunchOut,
  token = '',
}) {
  const [loading, setLoading] = useState(false)
  const [attendanceRows, setAttendanceRows] = useState([])
  const [historyFrom, setHistoryFrom] = useState('')
  const [historyTo, setHistoryTo] = useState('')
  const [attendanceSearch, setAttendanceSearch] = useState('')
  const [attendanceRange, setAttendanceRange] = useState('month')
  const [customFrom, setCustomFrom] = useState(() => calendarMonthStartDateKey(new Date()))
  const [customTo, setCustomTo] = useState(formatDateInput())

  const [correctionForm, setCorrectionForm] = useState(readCorrectionDraft)
  const [correctionRows, setCorrectionRows] = useState([])
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })

  async function loadAttendance(range = attendanceRange, from = customFrom, to = customTo) {
    let fromDate = from
    let toDate = to
    const today = formatDateInput()

    if (range === 'today') {
      fromDate = today
      toDate = today
    } else if (range === 'week') {
      fromDate = dateKeyOffsetFromToday(-6)
      toDate = today
    } else if (range === 'month') {
      toDate = today
      fromDate = calendarMonthStartDateKey(new Date())
    }

    setHistoryFrom(fromDate)
    setHistoryTo(toDate)
    setLoading(true)
    try {
      const data = await apiFetch(
        `/user/attendance_history?from_date=${encodeURIComponent(fromDate)}&to_date=${encodeURIComponent(toDate)}`,
        {},
        token,
      )
      const rows = Array.isArray(data?.rows) ? data.rows.map((row) => normalizeAttendanceRow(row)) : []
      setAttendanceRows(rows)
    } catch {
      setAttendanceRows([])
    } finally {
      setLoading(false)
    }
  }

  async function loadCorrectionHistory() {
    try {
      const rows = await apiFetch('/user/correction_requests', {}, token)
      setCorrectionRows(Array.isArray(rows) ? rows : [])
    } catch {
      setCorrectionRows([])
    }
  }

  useEffect(() => {
    loadAttendance()
    loadCorrectionHistory()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const filteredAttendanceRows = useMemo(() => {
    const q = String(attendanceSearch || '').trim().toLowerCase()
    if (!q) return attendanceRows
    return attendanceRows.filter((row) => {
      const text = [
        row?.date,
        formatWeekdayFromDateKey(row?.date),
        row?.check_in,
        row?.check_out,
        attendanceStatusLabel(row),
      ].join(' ').toLowerCase()
      return text.includes(q)
    })
  }, [attendanceRows, attendanceSearch])

  const attendanceSummarySubtitle = attendanceRange === 'month'
    ? 'this month · until today'
    : attendanceRange === 'week'
      ? 'last 7 days'
      : attendanceRange === 'today'
        ? 'today'
        : ''

  const summaryCards = useMemo(() => {
    const today = formatDateInput()
    const monthFirst = calendarMonthStartDateKey()
    let fromD = String(historyFrom || '').trim()
    const toD = String(historyTo || '').trim()

    if (attendanceRange === 'month') {
      if (!fromD || fromD < monthFirst) fromD = monthFirst
    }

    const endBound = !toD ? today : (toD > today ? today : toD)
    const workingDates = fromD
      ? listDateKeysInRange(fromD, endBound).filter((k) => !isWeekendDateKey(k))
      : []

    const byDate = {}
    attendanceRows.forEach((row) => {
      const dk = String(row?.date || '').trim()
      if (dk) byDate[dk] = row
    })

    let presentLike = 0
    let absent = 0
    let late = 0
    let exempt = 0

    workingDates.forEach((d) => {
      const row = byDate[d]
      const key = row ? attendanceStatusKey(row) : 'absent'
      if (key === 'leave' || key === 'holiday') {
        exempt += 1
        return
      }
      if (key === 'late') late += 1
      if (key === 'present' || key === 'late' || key === 'work_from_home' || key === 'half_day') {
        presentLike += 1
      } else {
        absent += 1
      }
    })

    const denom = Math.max(0, workingDates.length - exempt)
    const percent = denom > 0 ? Math.round((presentLike / denom) * 100) : 0

    return {
      attendancePercent: Number.isFinite(percent) ? percent : 0,
      present: presentLike,
      absent,
      late,
    }
  }, [attendanceRows, historyFrom, historyTo, attendanceRange])

  function exportCsv() {
    const headers = [
      'Date',
      'Day',
      'Check In Time',
      'Check Out Time',
      'Working Hours',
      'Break Time',
      'Late Arrival',
      'Early Exit',
      'Half Day',
      'Overtime Hours',
      'Attendance Status',
    ]

    const lines = [headers.join(',')]
    filteredAttendanceRows.forEach((row) => {
      const workedMinutes = workingMinutes(row)
      const checkInMin = parseTimeToMinutes(row?.check_in)
      const checkOutMin = parseTimeToMinutes(row?.check_out)
      const breakTime = workedMinutes >= (6 * 60) ? '1h 0m' : '0h 0m'
      const lateArrival = checkInMin != null && checkInMin > (9 * 60 + 15) ? 'Yes' : 'No'
      const earlyExit = checkOutMin != null && checkOutMin < (18 * 60) ? 'Yes' : 'No'
      const halfDay = attendanceStatusKey(row) === 'half_day' ? 'Yes' : 'No'
      const overtime = formatMinutes(Math.max(0, workedMinutes - (9 * 60)))

      const values = [
        row?.date || '-',
        formatWeekdayFromDateKey(row?.date),
        row?.check_in || '-',
        row?.check_out || '-',
        formatWorkingHours(row),
        breakTime,
        lateArrival,
        earlyExit,
        halfDay,
        overtime,
        attendanceStatusLabel(row),
      ]
      lines.push(values.map(csvEscape).join(','))
    })

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `attendance_history_${formatDateInput()}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  async function exportPdf() {
    try {
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF()
      let y = 14
      pdf.setFontSize(14)
      pdf.text('Attendance History Report', 10, y)
      y += 8
      pdf.setFontSize(10)

      filteredAttendanceRows.slice(0, 35).forEach((row) => {
        const line = `${row?.date || '-'} | ${formatWeekdayFromDateKey(row?.date)} | In: ${row?.check_in || '-'} | Out: ${row?.check_out || '-'} | ${attendanceStatusLabel(row)}`
        pdf.text(line, 10, y)
        y += 6
        if (y > 280) {
          pdf.addPage()
          y = 14
        }
      })

      pdf.save(`attendance_history_${formatDateInput()}.pdf`)
    } catch {
      setNotice({ type: 'error', text: 'Unable to export PDF right now.' })
    }
  }

  async function submitCorrectionRequest() {
    const issueType = String(correctionForm.requestType || '').trim()
    const date = String(correctionForm.date || '').trim()
    const reason = String(correctionForm.reason || '').trim()

    if (!issueType || !date || !reason) {
      setNotice({ type: 'error', text: 'Request type, date, and reason are required.' })
      return
    }

    setCorrectionSubmitting(true)
    try {
      const form = new FormData()
      const requestType = issueType === 'wfh_attendance_missing' ? 'wfh' : (issueType === 'location_issue' ? 'outside_office' : 'other')
      form.append('request_type', requestType)
      form.append('work_mode', requestType === 'wfh' ? 'wfh' : 'office')
      form.append('source', 'correction')
      form.append('issue_type', issueType)
      form.append('date', date)
      form.append('from_date', date)
      form.append('to_date', date)
      form.append('expected_check_in', String(correctionForm.expectedCheckIn || '').trim())
      form.append('expected_check_out', String(correctionForm.expectedCheckOut || '').trim())
      form.append('reason', reason)
      form.append('emergency_comment', String(correctionForm.emergencyComment || '').trim())
      if (correctionForm.attachment) form.append('attachment', correctionForm.attachment)

      await apiFetch('/manual_attendance_request', {
        method: 'POST',
        body: form,
      }, token)

      localStorage.removeItem(CORRECTION_DRAFT_KEY)
      setCorrectionForm({
        requestType: 'forgot_punch_in',
        date: formatDateInput(),
        expectedCheckIn: '',
        expectedCheckOut: '',
        reason: '',
        emergencyComment: '',
        attachment: null,
        attachmentName: '',
      })
      setNotice({ type: 'success', text: 'Correction request submitted and synced to Admin Attendance Requests.' })
      await loadCorrectionHistory()
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to submit correction request' })
    } finally {
      setCorrectionSubmitting(false)
    }
  }

  function saveCorrectionFormDraft() {
    saveCorrectionDraft(correctionForm)
    setNotice({ type: 'success', text: 'Correction draft saved.' })
  }

  return (
    <section className="employee-attendance-shell">

      <div className="employee-attendance-summary-grid">
        <article className="card employee-attendance-summary-card">
          <p>Attendance %
            {!!attendanceSummarySubtitle && <span className="muted small" style={{ display: 'block', fontWeight: 400, marginTop: 2 }}>{attendanceSummarySubtitle}</span>}
          </p>
          <strong>{summaryCards.attendancePercent}%</strong>
        </article>
        <article className="card employee-attendance-summary-card">
          <p>Present days
            {!!attendanceSummarySubtitle && <span className="muted small" style={{ display: 'block', fontWeight: 400, marginTop: 2 }}>{attendanceSummarySubtitle}</span>}
          </p>
          <strong>{summaryCards.present}</strong>
        </article>
        <article className="card employee-attendance-summary-card">
          <p>Absent days
            {!!attendanceSummarySubtitle && <span className="muted small" style={{ display: 'block', fontWeight: 400, marginTop: 2 }}>{attendanceSummarySubtitle}</span>}
          </p>
          <strong>{summaryCards.absent}</strong>
        </article>
        <article className="card employee-attendance-summary-card">
          <p>Late marks
            {!!attendanceSummarySubtitle && <span className="muted small" style={{ display: 'block', fontWeight: 400, marginTop: 2 }}>{attendanceSummarySubtitle}</span>}
          </p>
          <strong>{summaryCards.late}</strong>
        </article>
      </div>


      <article className="card employee-correction-card">
        <div className="employee-attendance-section-title">
          <ShieldCheck size={18} />
          <h3>Correction Request</h3>
        </div>

        <div className="employee-correction-form-grid">
          <label>
            <span>Request Type</span>
            <select value={correctionForm.requestType} onChange={(e) => setCorrectionForm((old) => ({ ...old, requestType: e.target.value }))}>
              {REQUEST_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Date</span>
            <input type="date" value={correctionForm.date} onChange={(e) => setCorrectionForm((old) => ({ ...old, date: e.target.value }))} />
          </label>

          <label>
            <span>Expected Check-In Time</span>
            <input type="time" value={correctionForm.expectedCheckIn} onChange={(e) => setCorrectionForm((old) => ({ ...old, expectedCheckIn: e.target.value }))} />
          </label>

          <label>
            <span>Expected Check-Out Time</span>
            <input type="time" value={correctionForm.expectedCheckOut} onChange={(e) => setCorrectionForm((old) => ({ ...old, expectedCheckOut: e.target.value }))} />
          </label>

          <label className="employee-correction-full">
            <span>Reason</span>
            <textarea rows={3} value={correctionForm.reason} onChange={(e) => setCorrectionForm((old) => ({ ...old, reason: e.target.value }))} />
          </label>

          <label>
            <span>Attachment Upload</span>
            <input
              type="file"
              onChange={(e) => {
                const file = e.target?.files?.[0] || null
                setCorrectionForm((old) => ({ ...old, attachment: file, attachmentName: file?.name || '' }))
              }}
            />
            {!!correctionForm.attachmentName && <small>{correctionForm.attachmentName}</small>}
          </label>

          <label>
            <span>Emergency Comment</span>
            <input type="text" value={correctionForm.emergencyComment} onChange={(e) => setCorrectionForm((old) => ({ ...old, emergencyComment: e.target.value }))} />
          </label>
        </div>

        <div className="employee-correction-form-actions">
          <button type="button" onClick={submitCorrectionRequest} disabled={correctionSubmitting}>
            {correctionSubmitting ? 'Submitting...' : 'Submit Request'}
          </button>
          <button type="button" className="ghost" onClick={saveCorrectionFormDraft}>Save Draft</button>
        </div>
      </article>

      <article className="card employee-correction-history-card">
        <h3>Correction Request History</h3>
        <div className="employee-correction-table-wrap">
          <table className="employee-correction-table">
            <thead>
              <tr>
                <th>Request Date</th>
                <th>Issue Type</th>
                <th>Status</th>
                <th>Admin Remarks</th>
                <th>Approved By</th>
              </tr>
            </thead>
            <tbody>
              {correctionRows.map((row) => {
                const status = correctionStatusKey(row)
                return (
                  <tr key={String(row?.id || Math.random())}>
                    <td>{String(row?.date || row?.from_date || '-')}</td>
                    <td>{issueTypeLabel(row)}</td>
                    <td><span className={`employee-attendance-status-badge ${status}`}>{correctionStatusLabel(row)}</span></td>
                    <td>{String(row?.review_comment || row?.rejection_reason || row?.conflict_reason || '-')}</td>
                    <td>{String(row?.approved_by || row?.rejected_by || '-')}</td>
                  </tr>
                )
              })}
              {!correctionRows.length && (
                <tr>
                  <td colSpan={5}>No correction requests found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      {!!notice.text && (
        <p className={`employee-attendance-notice ${notice.type === 'error' ? 'error' : 'success'}`}>{notice.text}</p>
      )}
    </section>
  )
}
