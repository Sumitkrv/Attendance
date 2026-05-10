import { useEffect, useMemo, useState } from 'react'
import {
  AlarmClock,
  Briefcase,
  CalendarDays,
  CheckCircle2,
  Clock3,
  FileClock,
  FlaskConical,
  FolderKanban,
  Layers3,
  ShieldAlert,
  Sparkles,
  UserCog,
} from 'lucide-react'
import { apiFetch } from '../../api'
import './AttendancePolicyEngine.css'

const DEFAULT_FORM = {
  name: '',
  shiftType: 'general',
  shiftStart: '09:00',
  lateGraceMinutes: 15,
  halfDayHours: 4,
  fullDayHours: 8,
  absentCutoffHour: 10,
  weekendAllowed: false,
  weekendDays: ['sat', 'sun'],
  effectiveFrom: new Date().toISOString().slice(0, 10),
}

function toMinutes(value = '00:00') {
  const [h, m] = String(value || '').split(':').map((x) => Number(x || 0))
  return (h * 60) + m
}

export default function AttendancePolicyEngine() {
  const [activeTab, setActiveTab] = useState('create')
  const [policies, setPolicies] = useState([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState(DEFAULT_FORM)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState({ type: '', text: '' })

  const [testInput, setTestInput] = useState({ checkIn: '09:20', checkOut: '18:10' })
  const [testResult, setTestResult] = useState(null)
  const [testLoading, setTestLoading] = useState(false)

  const [assignment, setAssignment] = useState({
    policyId: '',
    scopeType: 'company',
    scopeValue: '',
    effectiveFrom: new Date().toISOString().slice(0, 10),
  })
  const [employeeLookupId, setEmployeeLookupId] = useState('')
  const [resolvedPolicy, setResolvedPolicy] = useState(null)

  async function loadPolicies() {
    setLoading(true)
    try {
      const payload = await apiFetch('/policies')
      const rows = Array.isArray(payload?.items) ? payload.items : []
      setPolicies(rows)
      if (!assignment.policyId && rows[0]?.id) {
        setAssignment((old) => ({ ...old, policyId: rows[0].id }))
      }
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to load policies' })
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPolicies()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const errors = useMemo(() => {
    const halfDay = Number(form.halfDayHours || 0)
    const fullDay = Number(form.fullDayHours || 0)
    const shiftStart = toMinutes(form.shiftStart)
    const cutoff = Number(form.absentCutoffHour || 0) * 60

    return {
      name: !String(form.name || '').trim() ? 'Policy name is required' : '',
      halfDayHours: halfDay <= 0 ? 'Half-day must be > 0' : '',
      fullDayHours: fullDay <= halfDay ? 'Full-day must be greater than half-day' : '',
      absentCutoffHour: cutoff <= shiftStart ? 'Absent cutoff must be after shift start' : '',
    }
  }, [form])

  const canSave = useMemo(() => !Object.values(errors).some(Boolean), [errors])

  const summary = useMemo(() => {
    const lateAtMinutes = toMinutes(form.shiftStart) + Number(form.lateGraceMinutes || 0)
    const h = Math.floor(lateAtMinutes / 60)
    const m = lateAtMinutes % 60
    return {
      lateAfter: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`,
      halfDay: `${Number(form.halfDayHours || 0).toFixed(1)}h`,
      fullDay: `${Number(form.fullDayHours || 0).toFixed(1)}h`,
      absentCutoff: `${String(Number(form.absentCutoffHour || 0)).padStart(2, '0')}:00`,
    }
  }, [form])

  const weekendSet = useMemo(() => new Set(Array.isArray(form.weekendDays) ? form.weekendDays : []), [form.weekendDays])

  const tabItems = [
    { id: 'create', label: 'Create Policy', icon: FolderKanban },
    { id: 'test', label: 'Test Policy', icon: FlaskConical },
    { id: 'assign', label: 'Assign Policy', icon: UserCog },
    { id: 'versions', label: 'Versions', icon: Layers3 },
  ]

  const iconByShiftType = {
    general: Briefcase,
    night: AlarmClock,
    custom: Sparkles,
  }

  async function handleSavePolicy(e) {
    e.preventDefault()
    if (!canSave || saving) return
    setSaving(true)
    setFeedback({ type: '', text: '' })
    try {
      const payload = await apiFetch('/policies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          lateGraceMinutes: Number(form.lateGraceMinutes || 0),
          halfDayHours: Number(form.halfDayHours || 0),
          fullDayHours: Number(form.fullDayHours || 0),
          absentCutoffHour: Number(form.absentCutoffHour || 0),
          weekendDays: Array.from(new Set(Array.isArray(form.weekendDays) ? form.weekendDays : [])).slice(0, 7),
        }),
      })
      setFeedback({ type: 'success', text: payload?.message || 'Policy created' })
      setForm(DEFAULT_FORM)
      await loadPolicies()
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Failed to save policy' })
    } finally {
      setSaving(false)
    }
  }

  async function handleTestPolicy() {
    setTestLoading(true)
    try {
      const payload = await apiFetch('/policies/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          policy: form,
          checkIn: testInput.checkIn,
          checkOut: testInput.checkOut,
        }),
      })
      setTestResult(payload?.result || null)
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Policy test failed' })
    } finally {
      setTestLoading(false)
    }
  }

  async function handleAssignPolicy() {
    try {
      const payload = await apiFetch('/policies/assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assignment),
      })
      setFeedback({ type: 'success', text: payload?.message || 'Policy assigned' })
    } catch (err) {
      setFeedback({ type: 'error', text: err.message || 'Assignment failed' })
    }
  }

  async function handleResolveEmployeePolicy() {
    if (!employeeLookupId.trim()) return
    try {
      const payload = await apiFetch(`/policies/employee/${encodeURIComponent(employeeLookupId.trim())}`)
      setResolvedPolicy(payload || null)
    } catch (err) {
      setResolvedPolicy(null)
      setFeedback({ type: 'error', text: err.message || 'Unable to resolve employee policy' })
    }
  }

  function toggleWeekendDay(dayKey) {
    const key = String(dayKey || '').trim().toLowerCase()
    if (!key) return
    setForm((old) => {
      const set = new Set(Array.isArray(old.weekendDays) ? old.weekendDays : [])
      if (set.has(key)) set.delete(key)
      else set.add(key)
      return { ...old, weekendDays: Array.from(set) }
    })
  }

  const sectionCard = (title, subtitle, children, icon) => (
    <section className="apx-policy-section-card">
      <div className="apx-policy-section-head">
        <span className="apx-policy-section-icon">{icon}</span>
        <div>
          <h4>{title}</h4>
          <p>{subtitle}</p>
        </div>
      </div>
      <div className="apx-policy-fields-grid">{children}</div>
    </section>
  )

  return (
    <div className="apx-policy card form settings-card">
      <header className="apx-policy-header">
        <div>
          <h3>Attendance Policies</h3>
          <p>Design flexible attendance rules with enterprise-grade controls and live simulation.</p>
        </div>
      </header>

      {!!feedback.text && <div className={`apx-policy-alert ${feedback.type === 'success' ? 'success' : 'error'}`}>{feedback.text}</div>}

      <nav className="apx-policy-tabs" role="tablist" aria-label="Attendance policy tabs">
        {tabItems.map((tab) => {
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              className={`apx-policy-tab ${activeTab === tab.id ? 'active' : ''}`}
              onClick={() => setActiveTab(tab.id)}
            >
              <Icon size={15} />
              {tab.label}
            </button>
          )
        })}
      </nav>

      {activeTab === 'create' && (
        <div className="apx-policy-grid">
          <form className="apx-policy-left" onSubmit={handleSavePolicy}>
            {sectionCard(
              'Shift Setup',
              'Define shift profile, timing baseline and effective start date.',
              <>
                <label className="apx-field">
                  <span>Policy Name</span>
                  <div className="apx-input-wrap">
                    <FolderKanban size={16} />
                    <input value={form.name} onChange={(e) => setForm((old) => ({ ...old, name: e.target.value }))} placeholder="e.g. General Office Policy" />
                  </div>
                  {!!errors.name && <p className="field-error">{errors.name}</p>}
                </label>

                <label className="apx-field">
                  <span>Shift Type</span>
                  <div className="apx-input-wrap">
                    <Sparkles size={16} />
                    <select value={form.shiftType} onChange={(e) => setForm((old) => ({ ...old, shiftType: e.target.value }))}>
                      <option value="general">General</option>
                      <option value="night">Night</option>
                      <option value="custom">Custom</option>
                    </select>
                  </div>
                </label>

                <label className="apx-field">
                  <span>Shift Start</span>
                  <div className="apx-input-wrap">
                    <Clock3 size={16} />
                    <input type="time" value={form.shiftStart} onChange={(e) => setForm((old) => ({ ...old, shiftStart: e.target.value }))} />
                  </div>
                </label>

                <label className="apx-field">
                  <span>Effective From</span>
                  <div className="apx-input-wrap">
                    <CalendarDays size={16} />
                    <input type="date" value={form.effectiveFrom} onChange={(e) => setForm((old) => ({ ...old, effectiveFrom: e.target.value }))} />
                  </div>
                </label>
              </>,
              <Briefcase size={18} />,
            )}

            {sectionCard(
              'Work Rules',
              'Set present thresholds and expected minimum effort.',
              <>
                <label className="apx-field">
                  <span>Half-day Hours</span>
                  <div className="apx-input-wrap">
                    <Clock3 size={16} />
                    <input type="number" step="0.5" value={form.halfDayHours} onChange={(e) => setForm((old) => ({ ...old, halfDayHours: e.target.value }))} />
                  </div>
                  {!!errors.halfDayHours && <p className="field-error">{errors.halfDayHours}</p>}
                </label>

                <label className="apx-field">
                  <span>Full-day Hours</span>
                  <div className="apx-input-wrap">
                    <CheckCircle2 size={16} />
                    <input type="number" step="0.5" value={form.fullDayHours} onChange={(e) => setForm((old) => ({ ...old, fullDayHours: e.target.value }))} />
                  </div>
                  {!!errors.fullDayHours && <p className="field-error">{errors.fullDayHours}</p>}
                </label>
              </>,
              <Clock3 size={18} />,
            )}

            {sectionCard(
              'Absence Rules',
              'Late grace and auto-absent boundaries.',
              <>
                <label className="apx-field">
                  <span>Late Grace Minutes</span>
                  <div className="apx-input-wrap">
                    <AlarmClock size={16} />
                    <input type="number" value={form.lateGraceMinutes} onChange={(e) => setForm((old) => ({ ...old, lateGraceMinutes: e.target.value }))} />
                  </div>
                </label>

                <label className="apx-field">
                  <span>Absent Cutoff Hour</span>
                  <div className="apx-input-wrap">
                    <ShieldAlert size={16} />
                    <input type="number" value={form.absentCutoffHour} onChange={(e) => setForm((old) => ({ ...old, absentCutoffHour: e.target.value }))} />
                  </div>
                  {!!errors.absentCutoffHour && <p className="field-error">{errors.absentCutoffHour}</p>}
                </label>
              </>,
              <ShieldAlert size={18} />,
            )}

            {sectionCard(
              'Special Rules',
              'Weekend controls and non-standard workday handling.',
              <>
                <label className="apx-field apx-switch-field">
                  <span>Weekend Attendance</span>
                  <button
                    type="button"
                    className={`apx-switch ${form.weekendAllowed ? 'active' : ''}`}
                    onClick={() => setForm((old) => ({ ...old, weekendAllowed: !old.weekendAllowed }))}
                  >
                    <span />
                  </button>
                </label>

                <div className="apx-weekend-days">
                  {[
                    { key: 'sat', label: 'Sat' },
                    { key: 'sun', label: 'Sun' },
                    { key: 'mon', label: 'Mon' },
                    { key: 'tue', label: 'Tue' },
                    { key: 'wed', label: 'Wed' },
                    { key: 'thu', label: 'Thu' },
                    { key: 'fri', label: 'Fri' },
                  ].map((day) => (
                    <button
                      key={day.key}
                      type="button"
                      className={`apx-day-chip ${weekendSet.has(day.key) ? 'active' : ''}`}
                      onClick={() => toggleWeekendDay(day.key)}
                    >
                      {day.label}
                    </button>
                  ))}
                </div>
              </>,
              <Sparkles size={18} />,
            )}
          </form>

          <aside className="apx-policy-right">
            <div className="apx-summary-card">
              <div className="apx-summary-head">
                <h4>Live Policy Summary</h4>
                <span className="apx-badge">{form.shiftType}</span>
              </div>
              <div className="apx-summary-grid">
                <div>
                  <p>Shift Start</p>
                  <strong>{form.shiftStart}</strong>
                </div>
                <div>
                  <p>Late After</p>
                  <strong>{summary.lateAfter}</strong>
                </div>
                <div>
                  <p>Half Day</p>
                  <strong>{summary.halfDay}</strong>
                </div>
                <div>
                  <p>Full Day</p>
                  <strong>{summary.fullDay}</strong>
                </div>
                <div>
                  <p>Absent Cutoff</p>
                  <strong>{summary.absentCutoff}</strong>
                </div>
                <div>
                  <p>Weekend</p>
                  <strong>{form.weekendAllowed ? 'Allowed' : 'Blocked'}</strong>
                </div>
              </div>
              <div className="apx-policy-actions">
                <button type="submit" className="apx-btn apx-btn-primary" disabled={!canSave || saving} onClick={handleSavePolicy}>
                  {saving ? 'Saving...' : 'Create Policy'}
                </button>
                <button type="button" className="apx-btn apx-btn-secondary" onClick={() => setForm(DEFAULT_FORM)}>
                  Reset Draft
                </button>
              </div>
            </div>

            <div className="apx-quick-card">
              <h4>Policy Health</h4>
              <p><strong>Name:</strong> {errors.name ? 'Missing' : 'Ready'}</p>
              <p><strong>Thresholds:</strong> {errors.fullDayHours || errors.halfDayHours ? 'Needs correction' : 'Valid'}</p>
              <p><strong>Absence Rule:</strong> {errors.absentCutoffHour ? 'Invalid' : 'Valid'}</p>
              <p><strong>Shift Profile:</strong> {form.shiftType}</p>
            </div>
          </aside>
        </div>
      )}

      {activeTab === 'test' && (
        <div className="apx-policy-grid">
          <div className="apx-policy-left">
            <section className="apx-policy-section-card">
              <div className="apx-policy-section-head">
                <span className="apx-policy-section-icon"><FlaskConical size={18} /></span>
                <div>
                  <h4>Test Policy</h4>
                  <p>Run simulation using current draft policy values.</p>
                </div>
              </div>
              <div className="apx-policy-fields-grid">
                <label className="apx-field">
                  <span>Check-in</span>
                  <div className="apx-input-wrap">
                    <Clock3 size={16} />
                    <input type="time" value={testInput.checkIn} onChange={(e) => setTestInput((old) => ({ ...old, checkIn: e.target.value }))} />
                  </div>
                </label>
                <label className="apx-field">
                  <span>Check-out</span>
                  <div className="apx-input-wrap">
                    <Clock3 size={16} />
                    <input type="time" value={testInput.checkOut} onChange={(e) => setTestInput((old) => ({ ...old, checkOut: e.target.value }))} />
                  </div>
                </label>
              </div>
              <div className="apx-policy-actions">
                <button type="button" className="apx-btn apx-btn-primary" onClick={handleTestPolicy} disabled={testLoading}>
                  {testLoading ? 'Testing...' : 'Run Test'}
                </button>
              </div>
            </section>
          </div>

          <aside className="apx-policy-right">
            <div className="apx-summary-card">
              <div className="apx-summary-head">
                <h4>Simulation Result</h4>
                <FlaskConical size={16} />
              </div>
              {!testResult && <p className="muted small">No simulation result yet. Run a test to view status predictions.</p>}
              {!!testResult && (
                <div className="apx-summary-grid">
                  <div><p>Status</p><strong>{testResult.status}</strong></div>
                  <div><p>Late</p><strong>{testResult.isLate ? 'Yes' : 'No'}</strong></div>
                  <div><p>Working Hours</p><strong>{testResult.workingHours}</strong></div>
                  <div><p>Overtime</p><strong>{testResult.overtimeHours}</strong></div>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {activeTab === 'assign' && (
        <div className="apx-policy-grid">
          <div className="apx-policy-left">
            <section className="apx-policy-section-card">
              <div className="apx-policy-section-head">
                <span className="apx-policy-section-icon"><UserCog size={18} /></span>
                <div>
                  <h4>Assign Policy</h4>
                  <p>Attach policy to company, department, role, or employee scope.</p>
                </div>
              </div>
              <div className="apx-policy-fields-grid">
                <label className="apx-field">
                  <span>Policy</span>
                  <div className="apx-input-wrap">
                    <Layers3 size={16} />
                    <select value={assignment.policyId} onChange={(e) => setAssignment((old) => ({ ...old, policyId: e.target.value }))}>
                      <option value="">Select policy</option>
                      {policies.map((p) => <option key={p.id} value={p.id}>{p.name} (v{p.version})</option>)}
                    </select>
                  </div>
                </label>

                <label className="apx-field">
                  <span>Scope Type</span>
                  <div className="apx-input-wrap">
                    <UserCog size={16} />
                    <select value={assignment.scopeType} onChange={(e) => setAssignment((old) => ({ ...old, scopeType: e.target.value }))}>
                      <option value="company">Company (default)</option>
                      <option value="department">Department</option>
                      <option value="role">Role</option>
                      <option value="employee">Employee</option>
                    </select>
                  </div>
                </label>

                {assignment.scopeType !== 'company' && (
                  <label className="apx-field">
                    <span>Scope Value</span>
                    <div className="apx-input-wrap">
                      <Briefcase size={16} />
                      <input
                        placeholder={assignment.scopeType === 'employee' ? 'Employee ID' : assignment.scopeType === 'department' ? 'Department name' : 'Role name'}
                        value={assignment.scopeValue}
                        onChange={(e) => setAssignment((old) => ({ ...old, scopeValue: e.target.value }))}
                      />
                    </div>
                  </label>
                )}

                <label className="apx-field">
                  <span>Effective From</span>
                  <div className="apx-input-wrap">
                    <CalendarDays size={16} />
                    <input type="date" value={assignment.effectiveFrom} onChange={(e) => setAssignment((old) => ({ ...old, effectiveFrom: e.target.value }))} />
                  </div>
                </label>
              </div>
              <div className="apx-policy-actions">
                <button type="button" className="apx-btn apx-btn-primary" onClick={handleAssignPolicy}>Assign Policy</button>
              </div>
            </section>
          </div>

          <aside className="apx-policy-right">
            <div className="apx-summary-card">
              <div className="apx-summary-head">
                <h4>Resolve Employee Policy</h4>
                <FileClock size={16} />
              </div>
              <label className="apx-field">
                <span>Employee ID</span>
                <div className="apx-input-wrap">
                  <UserCog size={16} />
                  <input value={employeeLookupId} onChange={(e) => setEmployeeLookupId(e.target.value)} placeholder="Mongo employee id" />
                </div>
              </label>
              <div className="apx-policy-actions">
                <button type="button" className="apx-btn apx-btn-outline" onClick={handleResolveEmployeePolicy}>Resolve</button>
              </div>
              {!!resolvedPolicy?.policy && (
                <div className="apx-summary-grid">
                  <div><p>Resolved By</p><strong>{resolvedPolicy.resolvedBy}</strong></div>
                  <div><p>Policy</p><strong>{resolvedPolicy.policy.name}</strong></div>
                  <div><p>Version</p><strong>v{resolvedPolicy.policy.version}</strong></div>
                  <div><p>Shift</p><strong>{resolvedPolicy.policy.shiftStart}</strong></div>
                </div>
              )}
            </div>
          </aside>
        </div>
      )}

      {activeTab === 'versions' && (
        <section className="apx-versions-card">
          <div className="apx-policy-section-head">
            <span className="apx-policy-section-icon"><Layers3 size={18} /></span>
            <div>
              <h4>Policy Versions Timeline</h4>
              <p>Track policy iterations with effective dates and key thresholds.</p>
            </div>
          </div>
          {loading && <p className="muted small">Loading policies...</p>}
          {!loading && !policies.length && <p className="muted small">No policies found.</p>}
          <div className="apx-version-timeline">
            {policies.map((policy) => {
              const ShiftIcon = iconByShiftType[String(policy?.shiftType || 'general').toLowerCase()] || Briefcase
              return (
                <article key={policy.id} className="apx-version-item">
                  <div className="apx-version-dot" />
                  <div className="apx-version-body">
                    <header>
                      <h5>{policy.name}</h5>
                      <span className="apx-badge">v{policy.version}</span>
                    </header>
                    <p><ShiftIcon size={14} /> Shift {policy.shiftStart} · Half {policy.halfDayHours}h · Full {policy.fullDayHours}h</p>
                    <p><CalendarDays size={14} /> Effective {policy.effectiveFrom} · {policy.weekendAllowed ? 'Weekend Allowed' : 'Weekend Blocked'}</p>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
