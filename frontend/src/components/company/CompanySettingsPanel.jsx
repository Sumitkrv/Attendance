import { useState, useEffect } from 'react'
import { apiFetch } from '../../api'
import { Building2, Save, Loader2 } from 'lucide-react'

const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'UTC',
]

export default function CompanySettingsPanel({ company, token, onSaved }) {
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [activeTab, setActiveTab] = useState('general')

  useEffect(() => {
    if (company) {
      setForm({ ...company })
    }
  }, [company?.id])

  if (!company) {
    return (
      <div className="card form settings-card" style={{ textAlign: 'center', padding: '40px 20px' }}>
        <Building2 size={40} style={{ color: '#94a3b8', margin: '0 auto 12px' }} />
        <h3 style={{ color: '#475569' }}>No Company Selected</h3>
        <p className="muted">Select a company from the top navbar switcher to manage its settings.</p>
      </div>
    )
  }

  function update(key, value) {
    setForm(f => ({ ...f, [key]: value }))
  }

  function updateNested(parentKey, key, value) {
    setForm(f => ({
      ...f,
      [parentKey]: { ...(f[parentKey] || {}), [key]: value },
    }))
  }

  async function handleSave(e) {
    e?.preventDefault()
    setSaving(true)
    setFeedback('')
    try {
      await apiFetch(`/api/companies/${encodeURIComponent(company.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      }, token)
      setFeedback('Settings saved successfully')
      if (onSaved) onSaved()
    } catch (err) {
      setFeedback(err.message || 'Failed to save')
    } finally {
      setSaving(false)
      setTimeout(() => setFeedback(''), 4000)
    }
  }

  const tabs = [
    { id: 'general', label: 'General' },
    { id: 'payroll', label: 'Payroll' },
    { id: 'attendance', label: 'Attendance' },
    { id: 'leave', label: 'Leave' },
    { id: 'holidays', label: 'Holidays' },
  ]

  const payroll = form.payrollSettings || {}
  const attendance = form.attendanceSettings || {}
  const leavePolicy = form.leavePolicy || {}
  const tzCurrent = form.timezone || 'Asia/Kolkata'
  const timezoneOptions = [...new Set([tzCurrent, ...TIMEZONES])]

  return (
    <form className="card form settings-card company-settings-panel" onSubmit={handleSave}>
      <div className="company-settings-header">
        <div>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="hrms-company-dot" style={{ background: form.color || '#6b7280', width: 14, height: 14 }} />
            {company.name} — Settings
          </h3>
          <p className="muted small">Configure this company only — nothing here applies to other companies.</p>
        </div>
        <button type="submit" disabled={saving} className="company-settings-save-btn">
          {saving ? <Loader2 size={15} className="hrms-spin" /> : <Save size={15} />}
          {saving ? 'Saving...' : 'Save Changes'}
        </button>
      </div>

      {feedback && <div className={feedback.includes('success') ? 'success' : 'error'} style={{ marginBottom: 12, padding: '8px 12px', borderRadius: 8, fontSize: '0.82rem' }}>{feedback}</div>}

      <div className="company-settings-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            type="button"
            className={`company-settings-tab ${activeTab === t.id ? 'active' : ''}`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="company-settings-body">
        {activeTab === 'general' && (
          <div className="company-settings-grid">
            <h4 className="company-settings-section-title" style={{ gridColumn: '1 / -1', margin: '0 0 8px', fontSize: '0.95rem' }}>General</h4>
            <label>Company Name<input value={form.name || ''} onChange={e => update('name', e.target.value)} /></label>
            <label>Company Code<input value={form.companyCode || ''} onChange={e => update('companyCode', e.target.value)} /></label>
            <label>Email<input type="email" value={form.email || ''} onChange={e => update('email', e.target.value)} /></label>
            <label>Phone<input value={form.phone || ''} onChange={e => update('phone', e.target.value)} /></label>
            <label style={{ gridColumn: '1 / -1' }}>Address<textarea rows={2} value={form.address || ''} onChange={e => update('address', e.target.value)} /></label>
            <label>Logo URL<input placeholder="https://…" value={form.logo || ''} onChange={e => update('logo', e.target.value)} /></label>
            <label>Timezone
              <select value={tzCurrent} onChange={e => update('timezone', e.target.value)}>
                {timezoneOptions.map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {activeTab === 'payroll' && (
          <div className="company-settings-grid">
            <h4 className="company-settings-section-title" style={{ gridColumn: '1 / -1', margin: '0 0 8px', fontSize: '0.95rem' }}>Payroll</h4>
            <label>Payroll Cycle
              <select value={payroll.payrollCycle || 'monthly'} onChange={e => updateNested('payrollSettings', 'payrollCycle', e.target.value)}>
                <option value="monthly">Monthly</option>
                <option value="biweekly">Bi-Weekly</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
            <label className="row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={!!payroll.pfEnabled} onChange={e => updateNested('payrollSettings', 'pfEnabled', e.target.checked)} />
              PF
            </label>
            <label>PF %<input type="number" step="0.01" value={payroll.pfPercent ?? ''} onChange={e => updateNested('payrollSettings', 'pfPercent', parseFloat(e.target.value) || 0)} /></label>
            <label className="row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={!!payroll.esicEnabled} onChange={e => updateNested('payrollSettings', 'esicEnabled', e.target.checked)} />
              ESIC
            </label>
            <label>ESIC %<input type="number" step="0.01" value={payroll.esicPercent ?? ''} onChange={e => updateNested('payrollSettings', 'esicPercent', parseFloat(e.target.value) || 0)} /></label>
            <label className="row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input type="checkbox" checked={!!payroll.tdsEnabled} onChange={e => updateNested('payrollSettings', 'tdsEnabled', e.target.checked)} />
              TDS
            </label>
            <label>Salary Pay Date
              <select value={String(payroll.salaryPayDate ?? 'last')} onChange={e => updateNested('payrollSettings', 'salaryPayDate', e.target.value)}>
                <option value="last">Last day of month</option>
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={String(d)}>{d}{d === 1 ? 'st' : d === 2 ? 'nd' : d === 3 ? 'rd' : 'th'} of month</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {activeTab === 'attendance' && (
          <div className="company-settings-grid">
            <h4 className="company-settings-section-title" style={{ gridColumn: '1 / -1', margin: '0 0 8px', fontSize: '0.95rem' }}>Attendance</h4>
            <label>Shift Start<input type="time" value={attendance.shiftStart || '09:00'} onChange={e => updateNested('attendanceSettings', 'shiftStart', e.target.value)} /></label>
            <label>Shift End<input type="time" value={attendance.shiftEnd || '18:00'} onChange={e => updateNested('attendanceSettings', 'shiftEnd', e.target.value)} /></label>
            <label>Grace Minutes<input type="number" value={attendance.graceMinutes ?? 15} onChange={e => updateNested('attendanceSettings', 'graceMinutes', parseInt(e.target.value, 10) || 0)} /></label>
            <label>Work Mode
              <select value={attendance.workMode || 'office'} onChange={e => updateNested('attendanceSettings', 'workMode', e.target.value)}>
                <option value="office">Office</option>
                <option value="remote">Remote</option>
                <option value="hybrid">Hybrid</option>
              </select>
            </label>
            <label className="row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, gridColumn: '1 / -1' }}>
              <input
                type="checkbox"
                checked={!!attendance.geofenceEnabled}
                onChange={e => updateNested('attendanceSettings', 'geofenceEnabled', e.target.checked)}
              />
              Geofence (office boundary)
            </label>
            <label>Office Latitude
              <input type="number" step="0.000001" value={attendance.officeLat ?? ''} onChange={e => updateNested('attendanceSettings', 'officeLat', e.target.value)} placeholder="e.g. 28.6139" />
            </label>
            <label>Office Longitude
              <input type="number" step="0.000001" value={attendance.officeLng ?? ''} onChange={e => updateNested('attendanceSettings', 'officeLng', e.target.value)} placeholder="e.g. 77.2090" />
            </label>
            <label>Geofence Radius (meters)
              <input type="number" min="50" max="5000" value={attendance.officeRadiusMeters ?? 500} onChange={e => updateNested('attendanceSettings', 'officeRadiusMeters', parseInt(e.target.value, 10) || 500)} />
            </label>
          </div>
        )}

        {activeTab === 'leave' && (
          <div className="company-settings-grid">
            <h4 className="company-settings-section-title" style={{ gridColumn: '1 / -1', margin: '0 0 8px', fontSize: '0.95rem' }}>Leave</h4>
            <label>CL (days/year)<input type="number" value={leavePolicy.casualLeave ?? 12} onChange={e => updateNested('leavePolicy', 'casualLeave', parseInt(e.target.value, 10) || 0)} /></label>
            <label>SL (days/year)<input type="number" value={leavePolicy.sickLeave ?? 6} onChange={e => updateNested('leavePolicy', 'sickLeave', parseInt(e.target.value, 10) || 0)} /></label>
            <label>EL (days/year)<input type="number" value={leavePolicy.earnedLeave ?? 15} onChange={e => updateNested('leavePolicy', 'earnedLeave', parseInt(e.target.value, 10) || 0)} /></label>
            <label className="row" style={{ flexDirection: 'row', alignItems: 'center', gap: 8, gridColumn: '1 / -1' }}>
              <input
                type="checkbox"
                checked={leavePolicy.approvalRequired !== false}
                onChange={e => updateNested('leavePolicy', 'approvalRequired', e.target.checked)}
              />
              Approval required for leave
            </label>
          </div>
        )}

        {activeTab === 'holidays' && (
          <div className="company-settings-holidays">
            <h4 className="company-settings-section-title" style={{ margin: '0 0 12px', fontSize: '0.95rem' }}>Holidays</h4>
            <HolidayManager holidays={form.holidays || []} onChange={(h) => update('holidays', h)} />
          </div>
        )}
      </div>
    </form>
  )
}

function HolidayManager({ holidays, onChange }) {
  const [newDate, setNewDate] = useState('')
  const [newName, setNewName] = useState('')

  function addHoliday() {
    if (!newDate || !newName.trim()) return
    onChange([...holidays, { date: newDate, name: newName.trim() }])
    setNewDate('')
    setNewName('')
  }

  function removeHoliday(idx) {
    onChange(holidays.filter((_, i) => i !== idx))
  }

  return (
    <div>
      <p className="muted small" style={{ marginBottom: 12 }}>Add holidays for this company. Optional: sync with payroll / attendance calendars downstream.</p>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <input type="date" value={newDate} onChange={e => setNewDate(e.target.value)} style={{ flex: '0 0 160px' }} aria-label="Holiday date" />
        <input placeholder="Holiday name" value={newName} onChange={e => setNewName(e.target.value)} style={{ flex: 1, minWidth: 140 }} />
        <button type="button" onClick={addHoliday} disabled={!newDate || !newName.trim()} style={{ padding: '6px 14px', borderRadius: 8, background: '#16a34a', color: '#fff', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem' }}>Add Holiday</button>
      </div>

      <div className="company-holiday-table-wrap" style={{ overflowX: 'auto', borderRadius: 8, border: '1px solid #e2e8f0' }}>
        <table className="company-holiday-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
          <thead>
            <tr style={{ background: '#f8fafc', textAlign: 'left' }}>
              <th style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>Date</th>
              <th style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0' }}>Name</th>
              <th style={{ padding: '10px 12px', borderBottom: '1px solid #e2e8f0', width: 100 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {holidays.length === 0 && (
              <tr>
                <td colSpan={3} style={{ padding: '16px 12px', color: '#64748b' }}>No holidays yet. Add one above.</td>
              </tr>
            )}
            {holidays.map((h, i) => (
              <tr key={`${h.date}-${i}`} style={{ borderBottom: '1px solid #f1f5f9' }}>
                <td style={{ padding: '10px 12px', fontWeight: 600 }}>{h.date}</td>
                <td style={{ padding: '10px 12px' }}>{h.name}</td>
                <td style={{ padding: '10px 12px' }}>
                  <button type="button" onClick={() => removeHoliday(i)} style={{ background: 'none', border: 'none', color: '#ef4444', cursor: 'pointer', fontWeight: 600, fontSize: '0.8rem' }}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
