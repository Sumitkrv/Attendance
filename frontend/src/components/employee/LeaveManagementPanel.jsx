import { useEffect, useMemo, useState } from 'react'
import { CalendarClock, FileText, ShieldCheck } from 'lucide-react'
import { apiFetch } from '../../api'

const LEAVE_DRAFT_KEY = 'employee_leave_form_draft_v1'

const LEAVE_TYPES = [
  { value: 'sick_leave', label: 'Sick Leave' },
  { value: 'casual_leave', label: 'Casual Leave' },
  { value: 'paid_leave', label: 'Paid Leave' },
  { value: 'emergency_leave', label: 'Emergency Leave' },
  { value: 'half_day', label: 'Half Day' },
  { value: 'work_from_home', label: 'Work From Home' },
]

function defaultFormState() {
  return {
    leaveType: 'casual_leave',
    fromDate: '',
    toDate: '',
    halfDay: false,
    reason: '',
    emergencyContact: '',
    attachment: null,
    attachmentName: '',
  }
}

function readDraft() {
  try {
    const raw = localStorage.getItem(LEAVE_DRAFT_KEY)
    if (!raw) return defaultFormState()
    const parsed = JSON.parse(raw)
    return {
      ...defaultFormState(),
      ...parsed,
      attachment: null,
      attachmentName: '',
    }
  } catch {
    return defaultFormState()
  }
}

function saveDraft(form) {
  try {
    localStorage.setItem(LEAVE_DRAFT_KEY, JSON.stringify({
      leaveType: form.leaveType,
      fromDate: form.fromDate,
      toDate: form.toDate,
      halfDay: !!form.halfDay,
      reason: form.reason,
      emergencyContact: form.emergencyContact,
    }))
  } catch {
    // no-op
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(LEAVE_DRAFT_KEY)
  } catch {
    // no-op
  }
}

function statusKey(row) {
  const raw = String(row?.status || '').trim().toLowerCase()
  if (!raw) return 'pending'
  if (raw.includes('approve')) return 'approved'
  if (raw.includes('reject') || raw.includes('decline') || raw.includes('conflict') || raw.includes('cancel')) return 'rejected'
  if (raw.includes('pending') || raw.includes('review')) return 'pending'
  return 'pending'
}

function statusLabel(row) {
  const key = statusKey(row)
  if (key === 'approved') return 'Approved'
  if (key === 'rejected') return 'Rejected'
  return 'Pending'
}

function requestTrackingLabel(row) {
  const key = statusKey(row)
  if (key === 'approved') return 'Approved by HR'
  if (key === 'rejected') return 'Rejected with Reason'
  return 'Pending Approval'
}

function leaveTypeLabel(row) {
  const key = String(row?.leave_type || '').trim().toLowerCase()
  const hit = LEAVE_TYPES.find((t) => t.value === key)
  if (hit) return hit.label
  if (String(row?.request_type || '').trim().toLowerCase() === 'wfh') return 'Work From Home'
  return 'Leave'
}

function formatDateShort(text) {
  const value = String(text || '').trim()
  if (!value) return '-'
  return value
}

function formatDateTime(text) {
  const raw = String(text || '').trim()
  if (!raw) return '-'
  const ms = Date.parse(raw)
  if (!Number.isFinite(ms)) return raw
  return new Date(ms).toLocaleString()
}

function requestDurationLabel(row) {
  const leaveType = String(row?.leave_type || '').trim().toLowerCase()
  if (leaveType === 'half_day' || !!row?.half_day) return '0.5 Day'
  const fromDate = String(row?.from_date || row?.date || '').trim()
  const toDate = String(row?.to_date || fromDate).trim()
  if (!fromDate) return '-'
  const startMs = Date.parse(`${fromDate}T00:00:00`)
  const endMs = Date.parse(`${toDate}T00:00:00`)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return '1 Day'
  const days = Math.floor((endMs - startMs) / (1000 * 60 * 60 * 24)) + 1
  return `${days} Day${days > 1 ? 's' : ''}`
}

function decimal(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '0'
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export default function LeaveManagementPanel() {
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [historyRows, setHistoryRows] = useState([])
  const [balance, setBalance] = useState({
    casual_leave_remaining: 0,
    sick_leave_remaining: 0,
    paid_leave_remaining: 0,
    work_from_home_remaining: 0,
    half_day_used: 0,
  })
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [form, setForm] = useState(readDraft)

  async function loadLeaveData() {
    setLoading(true)
    try {
      const data = await apiFetch('/user/leave_requests')
      const history = Array.isArray(data?.history)
        ? data.history
        : (Array.isArray(data?.items) ? data.items : (Array.isArray(data?.requests) ? data.requests : []))
      setHistoryRows(history)
      setBalance({
        casual_leave_remaining: Number(data?.balance?.casual_leave_remaining || 0),
        sick_leave_remaining: Number(data?.balance?.sick_leave_remaining || 0),
        paid_leave_remaining: Number(data?.balance?.paid_leave_remaining || 0),
        work_from_home_remaining: Number(data?.balance?.work_from_home_remaining || 0),
        half_day_used: Number(data?.balance?.half_day_used || 0),
      })
      setNotice({ type: '', text: '' })
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to load leave management data' })
      setHistoryRows([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadLeaveData()
  }, [])

  useEffect(() => {
    const onFocus = () => loadLeaveData()
    window.addEventListener('focus', onFocus)
    const id = setInterval(() => {
      loadLeaveData()
    }, 30000)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(id)
    }
  }, [])

  const summary = useMemo(() => {
    const rows = Array.isArray(historyRows) ? historyRows : []
    return {
      pending: rows.filter((r) => statusKey(r) === 'pending').length,
      approved: rows.filter((r) => statusKey(r) === 'approved').length,
      rejected: rows.filter((r) => statusKey(r) === 'rejected').length,
    }
  }, [historyRows])

  function onChangeField(key, value) {
    setForm((old) => ({ ...old, [key]: value }))
  }

  function onSaveDraft() {
    saveDraft(form)
    setNotice({ type: 'success', text: 'Draft saved successfully.' })
  }

  function onCancel() {
    clearDraft()
    setForm(defaultFormState())
    setNotice({ type: '', text: '' })
  }

  async function onSubmitLeaveRequest() {
    const leaveType = String(form.leaveType || '').trim().toLowerCase()
    const fromDate = String(form.fromDate || '').trim()
    const toDate = String(form.toDate || '').trim() || fromDate
    const reason = String(form.reason || '').trim()

    if (!leaveType) {
      setNotice({ type: 'error', text: 'Please select leave type.' })
      return
    }
    if (!fromDate || !toDate) {
      setNotice({ type: 'error', text: 'Please select from and to dates.' })
      return
    }
    if (!reason) {
      setNotice({ type: 'error', text: 'Reason is required.' })
      return
    }

    setSubmitting(true)
    try {
      const requestType = leaveType === 'work_from_home' ? 'wfh' : 'leave'
      const workMode = requestType === 'wfh' ? 'wfh' : 'office'

      const body = new FormData()
      body.append('request_type', requestType)
      body.append('work_mode', workMode)
      body.append('leave_type', leaveType)
      body.append('date', fromDate)
      body.append('from_date', fromDate)
      body.append('to_date', toDate)
      body.append('half_day', String(!!form.halfDay || leaveType === 'half_day'))
      body.append('reason', reason)
      if (form.emergencyContact) body.append('emergency_contact', form.emergencyContact)
      if (form.attachment) body.append('attachment', form.attachment)

      await apiFetch('/manual_attendance_request', {
        method: 'POST',
        body,
      })

      clearDraft()
      setForm(defaultFormState())
      setNotice({ type: 'success', text: 'Leave request submitted successfully and shared with HR/Admin attendance requests.' })
      await loadLeaveData()
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to submit leave request' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="employee-leave-shell">
      <div className="employee-leave-balance-grid">
        <article className="card employee-leave-balance-card">
          <p>Casual Leave Remaining</p>
          <strong>{decimal(balance.casual_leave_remaining)}</strong>
        </article>
        <article className="card employee-leave-balance-card">
          <p>Sick Leave Remaining</p>
          <strong>{decimal(balance.sick_leave_remaining)}</strong>
        </article>
        <article className="card employee-leave-balance-card">
          <p>Paid Leave Remaining</p>
          <strong>{decimal(balance.paid_leave_remaining)}</strong>
        </article>
        <article className="card employee-leave-balance-card">
          <p>Work From Home Remaining</p>
          <strong>{decimal(balance.work_from_home_remaining)}</strong>
        </article>
        <article className="card employee-leave-balance-card">
          <p>Half Day Used</p>
          <strong>{decimal(balance.half_day_used)}</strong>
        </article>
      </div>

      <article className="card employee-leave-form-card">
        <div className="employee-leave-section-title">
          <CalendarClock size={18} />
          <h3>Apply Leave</h3>
        </div>

        <div className="employee-leave-form-grid">
          <label>
            <span>Leave Type</span>
            <select value={form.leaveType} onChange={(e) => onChangeField('leaveType', e.target.value)}>
              {LEAVE_TYPES.map((type) => (
                <option key={type.value} value={type.value}>{type.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>From Date</span>
            <input type="date" value={form.fromDate} onChange={(e) => onChangeField('fromDate', e.target.value)} />
          </label>

          <label>
            <span>To Date</span>
            <input type="date" value={form.toDate} onChange={(e) => onChangeField('toDate', e.target.value)} />
          </label>

          <label className="employee-leave-checkbox-wrap">
            <input
              type="checkbox"
              checked={!!form.halfDay}
              onChange={(e) => onChangeField('halfDay', e.target.checked)}
            />
            <span>Half Day Option</span>
          </label>

          <label className="employee-leave-grid-full">
            <span>Reason</span>
            <textarea
              rows={3}
              placeholder="Please provide a clear leave reason"
              value={form.reason}
              onChange={(e) => onChangeField('reason', e.target.value)}
            />
          </label>

          <label>
            <span>Attachment (optional)</span>
            <input
              type="file"
              onChange={(e) => {
                const file = e.target?.files?.[0] || null
                onChangeField('attachment', file)
                onChangeField('attachmentName', file?.name || '')
              }}
            />
            {!!form.attachmentName && <small>{form.attachmentName}</small>}
          </label>

          <label>
            <span>Emergency Contact (optional)</span>
            <input
              type="text"
              placeholder="Phone number or contact name"
              value={form.emergencyContact}
              onChange={(e) => onChangeField('emergencyContact', e.target.value)}
            />
          </label>
        </div>

        <div className="employee-leave-form-actions">
          <button type="button" onClick={onSubmitLeaveRequest} disabled={submitting}>
            {submitting ? 'Submitting...' : 'Submit Request'}
          </button>
          <button type="button" className="ghost" onClick={onSaveDraft}>Save Draft</button>
          <button type="button" className="ghost" onClick={onCancel}>Cancel</button>
        </div>

        {!!notice.text && (
          <p className={`employee-leave-notice ${notice.type === 'error' ? 'error' : 'success'}`}>{notice.text}</p>
        )}
      </article>

      <article className="card employee-leave-tracker-card">
        <div className="employee-leave-section-title">
          <ShieldCheck size={18} />
          <h3>Leave Status Tracking</h3>
        </div>
        <div className="employee-leave-status-kpis">
          <span className="status-badge">Pending Approval: {summary.pending}</span>
          <span className="status-badge">Approved by HR: {summary.approved}</span>
          <span className="status-badge">Rejected with Reason: {summary.rejected}</span>
        </div>
      </article>

      <article className="card employee-leave-history-card">
        <div className="employee-leave-section-title">
          <FileText size={18} />
          <h3>Leave History</h3>
        </div>

        <div className="employee-leave-table-wrap">
          <table className="employee-leave-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Leave Type</th>
                <th>Duration</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Tracking</th>
                <th>HR Comments</th>
                <th>Approved By</th>
                <th>Applied On</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={9}>Loading leave history...</td>
                </tr>
              )}
              {!loading && historyRows.map((row) => {
                const status = statusKey(row)
                return (
                  <tr key={row.id}>
                    <td>{formatDateShort(row.from_date || row.date)}{row.to_date && row.to_date !== row.from_date ? ` → ${formatDateShort(row.to_date)}` : ''}</td>
                    <td>{leaveTypeLabel(row)}</td>
                    <td>{requestDurationLabel(row)}</td>
                    <td title={String(row.reason || '')}>{String(row.reason || '-')}</td>
                    <td>
                      <span className={`employee-leave-status-badge ${status}`}>{statusLabel(row)}</span>
                    </td>
                    <td>{requestTrackingLabel(row)}</td>
                    <td>{String(row.review_comment || row.rejection_reason || row.conflict_reason || '-')}</td>
                    <td>{String(row.approved_by || row.rejected_by || '-')}</td>
                    <td>{formatDateTime(row.created_at || row.requested_at)}</td>
                  </tr>
                )
              })}
              {!loading && !historyRows.length && (
                <tr>
                  <td colSpan={9}>No leave requests found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  )
}
