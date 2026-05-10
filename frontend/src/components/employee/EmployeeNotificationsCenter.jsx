import { useEffect, useMemo, useState } from 'react'
import { Archive, Bell, CheckCheck, Filter, Search } from 'lucide-react'
import { apiFetch } from '../../api'
import './EmployeeNotificationsCenter.css'

const TYPE_OPTIONS = [
  { value: 'all', label: 'All Types' },
  { value: 'leave', label: 'Leave' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'request', label: 'Request' },
  { value: 'employee', label: 'Employee' },
]

const CATEGORY_OPTIONS = [
  { value: 'all', label: 'All Categories' },
  { value: 'leave_approved_rejected', label: 'Leave Approved / Rejected' },
  { value: 'attendance_correction_approved', label: 'Attendance Correction Approved' },
  { value: 'salary_released', label: 'Salary Released' },
  { value: 'reimbursement_approved', label: 'Reimbursement Approved' },
  { value: 'asset_request_update', label: 'Asset Request Update' },
  { value: 'task_deadline_reminder', label: 'Task Deadline Reminder' },
  { value: 'late_attendance_warning', label: 'Late Attendance Warning' },
  { value: 'hr_announcement', label: 'HR Announcement' },
  { value: 'company_policy_update', label: 'Company Policy Update' },
  { value: 'upcoming_holiday', label: 'Upcoming Holiday' },
  { value: 'birthday_work_anniversary', label: 'Birthday / Work Anniversary' },
  { value: 'team_meeting_reminder', label: 'Team Meeting Reminder' },
  { value: 'wfh_approval', label: 'Work From Home Approval' },
  { value: 'helpdesk', label: 'Helpdesk' },
]

const PRIORITY_OPTIONS = [
  { value: 'all', label: 'All Priorities' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
]

function priorityClass(priority = '') {
  const key = String(priority || '').toLowerCase()
  if (key === 'high') return 'danger'
  if (key === 'low') return 'ok'
  return 'warn'
}

function normalizeNotification(row = {}, idx = 0) {
  const type = String(row.type || 'request').toLowerCase()
  const category = String(row.category || type || 'general').toLowerCase()
  const title = String(row.title || '').trim() || String(category || type || 'Notification').replace(/_/g, ' ')
  const message = String(row.message || '').trim() || '-'
  const priority = ['high', 'medium', 'low'].includes(String(row.priority || '').toLowerCase())
    ? String(row.priority).toLowerCase()
    : 'medium'
  return {
    id: String(row.id || `notif_${idx}`),
    title,
    message,
    type,
    category,
    priority,
    isRead: !!row.isRead,
    archived: !!row.archived,
    createdAt: String(row.createdAt || ''),
  }
}

export default function EmployeeNotificationsCenter() {
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [rows, setRows] = useState([])
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [priorityFilter, setPriorityFilter] = useState('all')
  const [showArchived, setShowArchived] = useState(false)
  const [unreadOnly, setUnreadOnly] = useState(false)

  async function loadNotifications() {
    setLoading(true)
    try {
      const params = new URLSearchParams()
      params.set('limit', '200')
      if (typeFilter !== 'all') params.set('type', typeFilter)
      if (categoryFilter !== 'all') params.set('category', categoryFilter)
      if (priorityFilter !== 'all') params.set('priority', priorityFilter)
      if (search.trim()) params.set('search', search.trim())
      if (unreadOnly) params.set('unread', '1')
      if (showArchived) params.set('archived', '1')
      const payload = await apiFetch(`/api/notifications?${params.toString()}`)
      const items = Array.isArray(payload?.items) ? payload.items : []
      setRows(items.map((row, idx) => normalizeNotification(row, idx)))
      setNotice({ type: '', text: '' })
    } catch (err) {
      setRows([])
      setNotice({ type: 'error', text: err?.message || 'Unable to load notifications.' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadNotifications()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, categoryFilter, priorityFilter, showArchived, unreadOnly])

  async function markAsRead(id) {
    try {
      await apiFetch(`/api/notifications/${encodeURIComponent(id)}/read`, { method: 'PUT' })
      setRows((old) => old.map((row) => (row.id === id ? { ...row, isRead: true } : row)))
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to mark notification as read.' })
    }
  }

  async function markAllAsRead() {
    try {
      await apiFetch('/api/notifications/read_all', { method: 'PUT' })
      setRows((old) => old.map((row) => ({ ...row, isRead: true })))
      setNotice({ type: 'success', text: 'All notifications marked as read.' })
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to mark all as read.' })
    }
  }

  async function archiveNotification(id) {
    try {
      await apiFetch(`/api/notifications/${encodeURIComponent(id)}/archive`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })
      setRows((old) => old.map((row) => (row.id === id ? { ...row, archived: true } : row)).filter((row) => showArchived || !row.archived))
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to archive notification.' })
    }
  }

  async function archiveOld() {
    const cutoff = Date.now() - (30 * 24 * 3600 * 1000)
    const target = rows.filter((row) => {
      const ts = new Date(row.createdAt || '').getTime()
      return Number.isFinite(ts) && ts < cutoff && !row.archived
    })
    if (!target.length) {
      setNotice({ type: 'success', text: 'No old notifications to archive.' })
      return
    }

    try {
      await Promise.all(target.map((row) => apiFetch(`/api/notifications/${encodeURIComponent(row.id)}/archive`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived: true }),
      })))
      setRows((old) => old.map((row) => (target.some((t) => t.id === row.id) ? { ...row, archived: true } : row)).filter((row) => showArchived || !row.archived))
      setNotice({ type: 'success', text: `${target.length} notifications archived.` })
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to archive old notifications.' })
    }
  }

  const summary = useMemo(() => {
    const unread = rows.filter((row) => !row.isRead).length
    const high = rows.filter((row) => row.priority === 'high').length
    const archived = rows.filter((row) => row.archived).length
    return { total: rows.length, unread, high, archived }
  }, [rows])

  return (
    <section className="employee-notif-shell">
      <section className="employee-notif-summary" id="employee-notifications-summary-section">
        <article className="card employee-notif-summary-card"><p>Total</p><strong>{summary.total}</strong></article>
        <article className="card employee-notif-summary-card"><p>Unread</p><strong>{summary.unread}</strong></article>
        <article className="card employee-notif-summary-card"><p>High Priority</p><strong>{summary.high}</strong></article>
        <article className="card employee-notif-summary-card"><p>Archived</p><strong>{summary.archived}</strong></article>
      </section>

      <article className="card employee-notif-toolbar">
        <div className="employee-notif-toolbar-row">
          <label className="employee-notif-search-wrap">
            <Search size={15} />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search notifications" />
          </label>
          <button type="button" className="ghost" onClick={loadNotifications}><Filter size={14} /> Apply</button>
          <button type="button" className="ghost" onClick={markAllAsRead}><CheckCheck size={14} /> Mark All Read</button>
          <button type="button" className="ghost" onClick={archiveOld}><Archive size={14} /> Archive Old</button>
        </div>

        <div className="employee-notif-toolbar-row">
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>{TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select>
          <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>{CATEGORY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select>
          <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value)}>{PRIORITY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}</select>
          <label className="employee-notif-check"><input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(!!e.target.checked)} />Unread only</label>
          <label className="employee-notif-check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(!!e.target.checked)} />Show archived</label>
        </div>
      </article>

      {notice.text && <p className={notice.type === 'error' ? 'error' : 'success'} style={{ margin: 0 }}>{notice.text}</p>}

      <section className="employee-notif-list" id="employee-notifications-list-section">
        {loading && <article className="card employee-notif-item"><p className="muted small" style={{ margin: 0 }}>Loading notifications...</p></article>}

        {!loading && rows.map((row) => (
          <article key={row.id} className={`card employee-notif-item ${row.isRead ? 'is-read' : 'is-unread'}`}>
            <div className="employee-notif-item-head">
              <h4>{row.title || 'Notification'}</h4>
              <div className="employee-notif-item-badges">
                <span className={`status-badge ${priorityClass(row.priority)}`}>{row.priority}</span>
                <span className="status-badge">{String(row.category || row.type || 'general').replace(/_/g, ' ')}</span>
                <span className={`status-badge ${row.isRead ? '' : 'warn'}`}>{row.isRead ? 'Read' : 'Unread'}</span>
              </div>
            </div>
            <p className="employee-notif-message">{row.message || '-'}</p>
            <div className="employee-notif-foot">
              <p className="muted small" style={{ margin: 0 }}>{row.createdAt ? new Date(row.createdAt).toLocaleString() : '-'}</p>
              <div className="employee-notif-actions">
                {!row.isRead && (
                  <button type="button" className="ghost" onClick={() => markAsRead(row.id)}>Mark as Read</button>
                )}
                {!row.archived && (
                  <button type="button" className="ghost" onClick={() => archiveNotification(row.id)}>Archive</button>
                )}
              </div>
            </div>
          </article>
        ))}

        {!loading && !rows.length && (
          <article className="card employee-notif-item">
            <Bell size={18} />
            <p className="muted small" style={{ margin: 0 }}>No notifications found for selected filters.</p>
          </article>
        )}
      </section>
    </section>
  )
}
