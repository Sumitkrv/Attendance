import { useState, useEffect } from 'react'
import { apiFetch } from '../../api'

export default function LeavePanel({ token }) {
  const [balances, setBalances] = useState(null)
  const [requests, setRequests] = useState([])
  const [loading, setLoading] = useState(true)
  const [showApply, setShowApply] = useState(false)
  const [form, setForm] = useState({ leave_type: 'CL', from_date: '', to_date: '', reason: '' })
  const [submitting, setSubmitting] = useState(false)
  const [msg, setMsg] = useState('')

  async function load() {
    setLoading(true)
    try {
      const [bal, req] = await Promise.all([
        apiFetch('/api/leave/balance', {}, token).catch(() => null),
        apiFetch('/api/leave/requests?page=1&per_page=5', {}, token).catch(() => ({ items: [] })),
      ])
      if (bal) setBalances(bal)
      setRequests(Array.isArray(req?.items) ? req.items : Array.isArray(req) ? req.slice(0, 5) : [])
    } catch { /* no-op */ }
    setLoading(false)
  }

  useEffect(() => { if (token) load() }, [token])

  async function handleApply(e) {
    e.preventDefault()
    if (!form.from_date || !form.to_date || !form.reason.trim()) {
      setMsg('All fields are required'); return
    }
    setSubmitting(true); setMsg('')
    try {
      await apiFetch('/api/leave/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }, token)
      setMsg('Leave applied successfully!')
      setShowApply(false)
      setForm({ leave_type: 'CL', from_date: '', to_date: '', reason: '' })
      load()
    } catch (err) { setMsg(err.message || 'Failed') }
    setSubmitting(false)
  }

  const leaveTypes = [
    { code: 'CL', label: 'Casual', color: '#3b82f6' },
    { code: 'SL', label: 'Sick', color: '#ef4444' },
    { code: 'EL', label: 'Earned', color: '#22c55e' },
    { code: 'PL', label: 'Personal', color: '#8b5cf6' },
  ]

  const statusColor = (s) => {
    if (s === 'approved') return '#22c55e'
    if (s === 'rejected') return '#ef4444'
    return '#f59e0b'
  }

  return (
    <div className="emp-panel-card">
      <div className="emp-panel-header">
        <h3 className="emp-panel-title">🗓️ Leave Management</h3>
        <button className="emp-small-btn" onClick={() => setShowApply(!showApply)}>
          {showApply ? 'Cancel' : '+ Apply Leave'}
        </button>
      </div>

      {loading ? (
        <div className="emp-skeleton-block" />
      ) : (
        <>
          {balances && (
            <div className="emp-leave-balance-grid">
              {leaveTypes.map((lt) => (
                <div key={lt.code} className="emp-leave-balance-card" style={{ borderLeftColor: lt.color }}>
                  <span className="emp-leave-type">{lt.label}</span>
                  <strong className="emp-leave-count">
                    {balances[lt.code]?.remaining ?? balances[lt.code.toLowerCase()]?.remaining ?? '-'}
                  </strong>
                  <span className="emp-leave-sub">
                    of {balances[lt.code]?.total ?? balances[lt.code.toLowerCase()]?.total ?? '-'}
                  </span>
                </div>
              ))}
            </div>
          )}

          {showApply && (
            <form className="emp-leave-form" onSubmit={handleApply}>
              <select value={form.leave_type} onChange={(e) => setForm({ ...form, leave_type: e.target.value })}>
                {leaveTypes.map((lt) => <option key={lt.code} value={lt.code}>{lt.label} Leave</option>)}
              </select>
              <div className="emp-leave-dates">
                <input type="date" value={form.from_date} onChange={(e) => setForm({ ...form, from_date: e.target.value })} />
                <input type="date" value={form.to_date} onChange={(e) => setForm({ ...form, to_date: e.target.value })} />
              </div>
              <textarea rows={2} placeholder="Reason..." value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
              <button type="submit" disabled={submitting}>{submitting ? 'Applying...' : 'Submit Application'}</button>
            </form>
          )}

          {msg && <p className="emp-msg">{msg}</p>}

          {requests.length > 0 && (
            <div className="emp-leave-history">
              <h4>Recent Requests</h4>
              {requests.map((r, i) => (
                <div key={r._id || i} className="emp-leave-row">
                  <span className="emp-leave-row-type">{r.leave_type || 'Leave'}</span>
                  <span>{String(r.from_date || '').slice(0, 10)} → {String(r.to_date || '').slice(0, 10)}</span>
                  <span className="emp-leave-status-dot" style={{ background: statusColor(r.status) }}>
                    {r.status || 'pending'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
