import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Save, RefreshCw, Loader2, AlertTriangle, CheckCircle2,
  Printer, ChevronDown, ChevronUp, Info, TrendingUp, X,
  DollarSign, Percent, Calculator, FileText, BarChart3, Zap,
} from 'lucide-react'
import { apiFetch } from '../../api'
import './EmployeePayrollCalculator.css'

// ─── Constants ────────────────────────────────────────────────────────────────

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December']
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const DEFAULT_STRUCTURE = {
  basicPercent:      50,
  hraPercent:        20,
  allowancePercent:  15,
  bonusPercent:       5,
  pfPercent:         12,
  taxPercent:         5,
  otherDeductionPct:  0,
  manualBonus:        0,
  manualIncentive:    0,
  manualPenalty:      0,
  manualDeduction:    0,
}

const EARNING_FIELDS  = ['basicPercent','hraPercent','allowancePercent','bonusPercent']
const DEDUCTION_FIELDS = ['pfPercent','taxPercent','otherDeductionPct']

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmtINR(n, abs = false) {
  const v = abs ? Math.abs(Number(n || 0)) : Number(n || 0)
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function clamp(v, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Number(v) || 0))
}

function formatPctDisplay(value) {
  if (value === '—') return '—'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return '0%'
  const rounded = Math.abs(numeric % 1) < 0.001 ? numeric.toFixed(0) : numeric.toFixed(1)
  return `${rounded}%`
}

// ─── Inline % slider row ─────────────────────────────────────────────────────

function PercentRow({ label, fieldKey, value, onChange, color, tooltip, maxVal = 100 }) {
  const pct = clamp(value, 0, maxVal)
  return (
    <div className="prc-row">
      <div className="prc-row-label">
        <span>{label}</span>
        {tooltip && (
          <span className="prc-tooltip" title={tooltip}>
            <Info size={12} />
          </span>
        )}
      </div>
      <div className="prc-row-controls">
        <input
          type="range"
          min={0}
          max={maxVal}
          step={0.5}
          value={pct}
          onChange={e => onChange(fieldKey, parseFloat(e.target.value))}
          className="prc-slider"
          style={{ '--slider-color': color }}
        />
        <div className="prc-input-wrap">
          <input
            type="number"
            min={0}
            max={maxVal}
            step={0.5}
            value={pct}
            onChange={e => onChange(fieldKey, parseFloat(e.target.value) || 0)}
            className="prc-pct-input"
          />
          <span className="prc-pct-symbol">%</span>
        </div>
      </div>
    </div>
  )
}

// ─── Amount row (manual adjustments) ─────────────────────────────────────────

function AmountRow({ label, fieldKey, value, onChange, color, placeholder = '0' }) {
  return (
    <div className="prc-row">
      <div className="prc-row-label">
        <span>{label}</span>
      </div>
      <div className="prc-amount-input-wrap">
        <span className="prc-rupee">₹</span>
        <input
          type="number"
          min={0}
          step={1}
          value={value || ''}
          placeholder={placeholder}
          onChange={e => onChange(fieldKey, parseFloat(e.target.value) || 0)}
          className="prc-amount-input"
          style={{ borderColor: color }}
        />
      </div>
    </div>
  )
}

// ─── Progress bar ─────────────────────────────────────────────────────────────

function PctBar({ value, max = 100, color, warn = false }) {
  const pct = Math.min(100, (value / max) * 100)
  return (
    <div className="prc-pct-bar-bg">
      <div
        className="prc-pct-bar-fill"
        style={{ width: `${pct}%`, background: warn ? '#ef4444' : color }}
      />
    </div>
  )
}

// ─── Animated money counter ───────────────────────────────────────────────────

function FlipAmount({ value, prefix = '₹', className = '' }) {
  const [display, setDisplay] = useState(value)
  const prev = useRef(value)
  useEffect(() => {
    const start = prev.current
    const diff = value - start
    if (Math.abs(diff) < 1) { setDisplay(value); return }
    let frame
    const dur = 500
    const t0 = performance.now()
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / dur)
      const ease = 1 - Math.pow(1 - p, 3)
      setDisplay(Math.round(start + diff * ease))
      if (p < 1) frame = requestAnimationFrame(tick)
      else prev.current = value
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value])
  return (
    <span className={`flip-amount ${className}`}>
      {prefix}{display.toLocaleString('en-IN')}
    </span>
  )
}

// ─── Payslip Modal ────────────────────────────────────────────────────────────

function PayslipModal({ preview, employee, year, month, onClose }) {
  const now = new Date()
  const handlePrint = () => window.print()

  if (!preview) return null
  const { earnings = {}, deductions = {}, grossSalary, totalDeductions, netSalary, structure = {} } = preview

  return (
    <div className="payslip-backdrop" onClick={onClose}>
      <div className="payslip-modal" onClick={e => e.stopPropagation()}>
        <div className="payslip-modal-header no-print">
          <h3>Payslip Preview</h3>
          <div className="payslip-modal-actions">
            <button className="prc-btn primary" onClick={handlePrint}>
              <Printer size={14} /> Print / Save PDF
            </button>
            <button className="prc-icon-btn" onClick={onClose}><X size={16} /></button>
          </div>
        </div>

        <div className="payslip-body" id="payslip-print-area">
          {/* Header */}
          <div className="payslip-header">
            <div className="payslip-company">
              <div className="payslip-company-logo">HR</div>
              <div>
                <h2 className="payslip-company-name">HRM Enterprise</h2>
                <p className="payslip-company-sub">Payroll Department</p>
              </div>
            </div>
            <div className="payslip-title-block">
              <h3>SALARY SLIP</h3>
              <p>{MONTHS[month - 1]} {year}</p>
            </div>
          </div>

          <div className="payslip-divider" />

          {/* Employee info */}
          <div className="payslip-emp-grid">
            <div><span>Employee Name</span><strong>{employee?.name || '—'}</strong></div>
            <div><span>Department</span><strong>{employee?.department || 'General'}</strong></div>
            <div><span>Designation</span><strong>{employee?.role || 'Staff'}</strong></div>
            <div><span>Month</span><strong>{MONTHS[month - 1]} {year}</strong></div>
            <div><span>Monthly CTC</span><strong>{fmtINR(preview.monthlySalary)}</strong></div>
            <div><span>Days Worked</span><strong>{preview.presentDays} / {preview.workingDaysInMonth}</strong></div>
          </div>

          <div className="payslip-divider" />

          {/* Attendance summary */}
          <div className="payslip-att-row">
            <div className="payslip-att-chip present">
              <span>{preview.presentDays}</span> Present
            </div>
            <div className="payslip-att-chip absent">
              <span>{preview.absentDays || 0}</span> Absent
            </div>
            <div className="payslip-att-chip halfday">
              <span>{preview.halfDayCount || 0}</span> Half Day
            </div>
            <div className="payslip-att-chip overtime">
              <span>{fmtINR(preview.overtimeEarnings)}</span> Overtime
            </div>
            <div className="payslip-att-chip earned">
              <span>{fmtINR(preview.earnedSalary)}</span> Earned Base
            </div>
          </div>

          <div className="payslip-divider" />

          {/* Earnings vs Deductions */}
          <div className="payslip-table-grid">
            <div className="payslip-col">
              <div className="payslip-col-header earn">Earnings</div>
              <div className="payslip-col-body">
                {[
                  { label: `Basic (${structure.basicPercent || 0}%)`,         value: earnings.basic },
                  { label: `HRA (${structure.hraPercent || 0}%)`,             value: earnings.hra },
                  { label: `Allowance (${structure.allowancePercent || 0}%)`, value: earnings.allowance },
                  { label: `Bonus (${structure.bonusPercent || 0}%)`,         value: earnings.bonus },
                  { label: 'Manual Bonus',                                    value: earnings.manualBonus },
                  { label: 'Incentive',                                       value: earnings.manualIncentive },
                  { label: 'Overtime',                                        value: preview.overtimeEarnings },
                ].filter(r => r.value > 0).map(r => (
                  <div key={r.label} className="payslip-line">
                    <span>{r.label}</span><span>{fmtINR(r.value)}</span>
                  </div>
                ))}
              </div>
              <div className="payslip-col-total earn">
                <span>Gross Earnings</span><strong>{fmtINR(grossSalary)}</strong>
              </div>
            </div>

            <div className="payslip-col">
              <div className="payslip-col-header ded">Deductions</div>
              <div className="payslip-col-body">
                {[
                  { label: `PF (${structure.pfPercent || 0}% of Basic)`,       value: deductions.pf },
                  { label: `Tax (${structure.taxPercent || 0}% of Gross)`,      value: deductions.tax },
                  { label: `Other (${structure.otherDeductionPct || 0}%)`,      value: deductions.otherDeduction },
                  { label: 'Penalty',                                            value: deductions.manualPenalty },
                  { label: 'Manual Deduction',                                   value: deductions.manualDeduction },
                ].filter(r => r.value > 0).map(r => (
                  <div key={r.label} className="payslip-line">
                    <span>{r.label}</span><span className="ded">-{fmtINR(r.value)}</span>
                  </div>
                ))}
              </div>
              <div className="payslip-col-total ded">
                <span>Total Deductions</span><strong className="ded">-{fmtINR(totalDeductions)}</strong>
              </div>
            </div>
          </div>

          <div className="payslip-divider" />

          {/* Net Pay */}
          <div className="payslip-net-row">
            <span>NET PAY</span>
            <strong className="payslip-net-amount">{fmtINR(netSalary)}</strong>
          </div>

          <div className="payslip-divider" />

          <div className="payslip-footer">
            <div className="payslip-sign-block">
              <div className="payslip-sign-line" />
              <span>HR Signature</span>
            </div>
            <p className="payslip-note">This is a computer-generated payslip.</p>
            <div className="payslip-sign-block">
              <div className="payslip-sign-line" />
              <span>Employee Signature</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EmployeePayrollCalculator({ employee, token }) {
  const today = new Date()
  const [year, setYear]   = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)

  const [salaryType, setSalaryType]   = useState('CTC_BASED')
  const [netTarget, setNetTarget]     = useState(0)
  const [structure, setStructure]     = useState(DEFAULT_STRUCTURE)
  const [monthlySalary, setMonthlySalary] = useState(0)
  const [preview, setPreview]         = useState(null)
  const [loading, setLoading]         = useState(true)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [saving, setSaving]           = useState(false)
  const [toast, setToast]             = useState(null)
  const [showPayslip, setShowPayslip] = useState(false)
  const [activeSection, setActiveSection] = useState('structure')
  const debounceRef = useRef(null)

  const empId = employee?.id || employee?._id || ''
  const isInHand = salaryType === 'IN_HAND'

  const showToast = useCallback((msg, type = 'success') => {
    setToast({ msg, type })
    setTimeout(() => setToast(null), 3500)
  }, [])

  // ── Load structure from backend ──────────────────────────────────────────
  const loadStructure = useCallback(async () => {
    if (!empId) return
    setLoading(true)
    try {
      const data = await apiFetch(`/api/employees/${empId}/salary-structure`, {}, token)
      setMonthlySalary(data.monthlySalary || 0)
      setSalaryType(data.salaryType || 'CTC_BASED')
      setNetTarget(data.netTargetMonthly || 0)
      setStructure(prev => ({ ...prev, ...(data.structure || {}) }))
    } catch {
      showToast('Could not load salary structure', 'error')
    } finally {
      setLoading(false)
    }
  }, [empId, token, showToast])

  useEffect(() => { loadStructure() }, [loadStructure])

  // ── Live preview (debounced) ─────────────────────────────────────────────
  const fetchPreview = useCallback(async (str, ms, nt, st, yr, mo) => {
    if (!empId) return
    setPreviewLoading(true)
    try {
      const data = await apiFetch(
        `/api/employees/${empId}/payroll-preview?year=${yr}&month=${mo}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...str, monthlySalary: ms }),
        },
        token,
      )
      setPreview(data)
    } catch { /* silent */ }
    setPreviewLoading(false)
  }, [empId, token])

  // Debounce preview on every structure/salary/period change
  useEffect(() => {
    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      fetchPreview(structure, monthlySalary, year, month)
    }, 320)
    return () => clearTimeout(debounceRef.current)
  }, [structure, monthlySalary, year, month, fetchPreview])

  // ── Field change handler ──────────────────────────────────────────────────
  const handleChange = useCallback((field, value) => {
    setStructure(prev => ({ ...prev, [field]: value }))
  }, [])

  // ── Save ──────────────────────────────────────────────────────────────────
  const handleSave = async () => {
    setSaving(true)
    try {
      await apiFetch(`/api/employees/${empId}/salary-structure`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...structure, monthlySalary, salary_type: salaryType, net_target_monthly: netTarget }),
      }, token)
      showToast('Salary structure saved successfully')
    } catch (err) {
      showToast(err?.message || 'Save failed', 'error')
    } finally {
      setSaving(false)
    }
  }

  // ── Validation ────────────────────────────────────────────────────────────
  const earningPctTotal = useMemo(() =>
    EARNING_FIELDS.reduce((s, k) => s + (structure[k] || 0), 0),
  [structure])

  const earnPctOk = earningPctTotal <= 100

  // ── Preview values (fallback if API not loaded yet) ───────────────────────
  const earned     = preview?.earnedSalary   ?? 0
  const gross      = preview?.grossSalary    ?? 0
  const net        = preview?.netSalary      ?? 0
  const totalDed   = preview?.totalDeductions ?? 0

  const sections = [
    { key: 'structure', icon: Percent,    label: 'Structure' },
    { key: 'adjustments', icon: Calculator, label: 'Adjustments' },
    { key: 'preview',   icon: BarChart3,  label: 'Live Preview' },
  ]

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="prc-root">
      {/* Toast */}
      {toast && (
        <div className={`prc-toast prc-toast-${toast.type}`}>
          {toast.type === 'success' ? <CheckCircle2 size={14} /> : <AlertTriangle size={14} />}
          <span>{toast.msg}</span>
          <button onClick={() => setToast(null)}><X size={12} /></button>
        </div>
      )}

      {/* Header */}
      <div className="prc-header">
        <div className="prc-header-left">
          <div className="prc-header-icon">
            <Calculator size={18} />
          </div>
          <div>
            <h3>Payroll Calculator</h3>
            <p className="prc-subtitle">Percentage-based salary structure · {employee?.name}</p>
          </div>
        </div>
        <div className="prc-header-right">
          <div className="prc-period-picker">
            <select value={month} onChange={e => setMonth(Number(e.target.value))} className="prc-select">
              {MONTHS_SHORT.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <select value={year} onChange={e => setYear(Number(e.target.value))} className="prc-select">
              {[2024, 2025, 2026].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button className="prc-btn primary" onClick={handleSave} disabled={saving || !earnPctOk}>
            {saving ? <Loader2 size={14} className="hrms-spin" /> : <Save size={14} />}
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="prc-btn ghost" onClick={() => setShowPayslip(true)} disabled={!preview}>
            <FileText size={14} /> Payslip
          </button>
        </div>
      </div>

      {/* Salary Type Toggle */}
      <div className="prc-salary-type-row">
        <span className="prc-salary-type-label">Salary Type</span>
        <div className="prc-type-toggle">
          {[
            { val: 'CTC_BASED', label: '📊 Standard CTC', desc: 'Deductions cut from gross' },
            { val: 'IN_HAND',   label: '💵 Full In-Hand',  desc: 'Company absorbs deductions' },
          ].map(opt => (
            <button
              key={opt.val}
              type="button"
              title={opt.desc}
              className={`prc-type-btn ${salaryType === opt.val ? 'active' : ''}`}
              onClick={() => setSalaryType(opt.val)}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {isInHand && (
          <span className="prc-type-badge in-hand">TYPE A – Gross-Up Active</span>
        )}
      </div>

      {/* Monthly Salary input */}
      <div className="prc-salary-input-card">
        <div className="prc-salary-label">
          <DollarSign size={15} />
          <span>{isInHand ? 'Net In-Hand Target (₹)' : 'Monthly Gross CTC (₹)'}</span>
        </div>
        {isInHand ? (
          <>
            <input
              type="number"
              min={0}
              step={1000}
              value={netTarget || ''}
              placeholder="Guaranteed bank credit"
              onChange={e => setNetTarget(parseFloat(e.target.value) || 0)}
              className="prc-salary-field"
            />
            <div className="prc-inhand-info">
              <Info size={13} />
              <span>Employee receives exactly this amount. Company pays all PF, Tax, PT on top.</span>
            </div>
            {preview?.grossUpResult && (
              <div className="prc-grossup-strip">
                <span>Computed Gross: <strong>{fmtINR(preview.grossUpResult.gross)}</strong></span>
                <span>DRA (absorbed): <strong className="text-danger">{fmtINR(preview.grossUpResult.dra)}</strong></span>
                {!preview.grossUpResult.converged && (
                  <span className="prc-warn-small">⚠ Gross-up did not converge</span>
                )}
              </div>
            )}
          </>
        ) : (
          <>
            <input
              type="number"
              min={0}
              step={1000}
              value={monthlySalary || ''}
              placeholder="Enter monthly gross salary"
              onChange={e => setMonthlySalary(parseFloat(e.target.value) || 0)}
              className="prc-salary-field"
            />
          </>
        )}
        <div className="prc-salary-meta">
          <span>Per day: <strong>{fmtINR((isInHand ? netTarget : monthlySalary) / Math.max(1, preview?.workingDaysInMonth || 25))}</strong></span>
          <span>Working days: <strong>{preview?.workingDaysInMonth || 25}</strong></span>
          <span>Earned: <strong className="text-success">{fmtINR(earned)}</strong></span>
        </div>
      </div>

      {/* Net Pay hero */}
      <div className="prc-net-hero">
        <div className="prc-net-hero-item">
          <span>Earned Salary</span>
          <FlipAmount value={Math.round(earned)} className="earned" />
        </div>
        <div className="prc-net-hero-arrow">→</div>
        <div className="prc-net-hero-item">
          <span>Gross Pay</span>
          <FlipAmount value={Math.round(gross)} className="gross" />
        </div>
        <div className="prc-net-hero-arrow">–</div>
        <div className="prc-net-hero-item">
          <span>Deductions</span>
          <FlipAmount value={Math.round(totalDed)} className="ded" />
        </div>
        <div className="prc-net-hero-arrow">=</div>
        <div className="prc-net-hero-item net">
          <span>Net Pay</span>
          <FlipAmount value={Math.round(net)} className="net" />
          {previewLoading && <Loader2 size={12} className="hrms-spin prc-refresh-spin" />}
        </div>
      </div>

      {/* Validation warning */}
      {!earnPctOk && (
        <div className="prc-warn-banner">
          <AlertTriangle size={15} />
          <span>Earning percentages total <strong>{earningPctTotal.toFixed(1)}%</strong> — exceeds 100%. Please adjust before saving.</span>
        </div>
      )}
      {(preview?.warnings || []).filter(w => !w.includes('exceed')).map(w => (
        <div key={w} className="prc-warn-banner info"><Info size={14} /><span>{w}</span></div>
      ))}

      {/* Section Tabs */}
      <div className="prc-tabs">
        {sections.map(s => {
          const Icon = s.icon
          return (
            <button
              key={s.key}
              className={`prc-tab ${activeSection === s.key ? 'active' : ''}`}
              onClick={() => setActiveSection(s.key)}
            >
              <Icon size={14} />
              {s.label}
            </button>
          )
        })}
      </div>

      {loading ? (
        <div className="prc-loading"><Loader2 size={24} className="hrms-spin" /><p>Loading structure…</p></div>
      ) : (
        <>
          {/* ── Structure Tab ── */}
          {activeSection === 'structure' && (
            <div className="prc-two-col">
              {/* Earnings */}
              <div className="prc-section-card">
                <div className="prc-section-header earn">
                  <TrendingUp size={15} />
                  <span>Earnings</span>
                  <span className={`prc-total-badge ${earnPctOk ? 'ok' : 'warn'}`}>
                    {earningPctTotal.toFixed(1)}% / 100%
                  </span>
                </div>
                <PctBar value={earningPctTotal} max={100} color="#4f46e5" warn={!earnPctOk} />
                <div className="prc-rows">
                  <PercentRow label="Basic Salary" fieldKey="basicPercent"     value={structure.basicPercent}     onChange={handleChange} color="#4f46e5" tooltip="Usually 40–50% of CTC" />
                  <PercentRow label="HRA"           fieldKey="hraPercent"       value={structure.hraPercent}       onChange={handleChange} color="#7c3aed" tooltip="House Rent Allowance" />
                  <PercentRow label="Allowances"    fieldKey="allowancePercent" value={structure.allowancePercent} onChange={handleChange} color="#06b6d4" tooltip="Special + other allowances" />
                  <PercentRow label="Bonus"         fieldKey="bonusPercent"     value={structure.bonusPercent}     onChange={handleChange} color="#10b981" tooltip="Performance bonus %" />
                </div>

                {/* Earnings breakdown preview */}
                {preview && (
                  <div className="prc-breakdown">
                    {[
                      { label: 'Basic',       value: preview.earnings?.basic,      color: '#4f46e5' },
                      { label: 'HRA',         value: preview.earnings?.hra,        color: '#7c3aed' },
                      { label: 'Allowances',  value: preview.earnings?.allowance,  color: '#06b6d4' },
                      { label: 'Bonus',       value: preview.earnings?.bonus,      color: '#10b981' },
                    ].map(item => (
                      <div key={item.label} className="prc-breakdown-row">
                        <span className="prc-breakdown-dot" style={{ background: item.color }} />
                        <span>{item.label}</span>
                        <strong>{fmtINR(item.value)}</strong>
                      </div>
                    ))}
                    <div className="prc-breakdown-total">
                      <span>Gross Pay</span>
                      <strong>{fmtINR(gross)}</strong>
                    </div>
                  </div>
                )}
              </div>

              {/* Deductions */}
              <div className="prc-section-card">
                <div className="prc-section-header ded">
                  <ChevronDown size={15} />
                  <span>Deductions</span>
                </div>
                <div className="prc-rows">
                  <PercentRow label="Provident Fund (PF)" fieldKey="pfPercent"       value={structure.pfPercent}       onChange={handleChange} color="#ef4444" tooltip="Applied on Basic salary" maxVal={30} />
                  <PercentRow label="Income Tax (TDS)"    fieldKey="taxPercent"       value={structure.taxPercent}      onChange={handleChange} color="#f59e0b" tooltip="Applied on Gross salary" maxVal={40} />
                  <PercentRow label="Other Deductions"    fieldKey="otherDeductionPct" value={structure.otherDeductionPct} onChange={handleChange} color="#9ca3af" tooltip="Any other % deduction" />
                </div>

                {preview && (
                  <div className="prc-breakdown">
                    {[
                      { label: `PF (on Basic)`,  value: preview.deductions?.pf,             color: '#ef4444' },
                      { label: `Tax (on Gross)`, value: preview.deductions?.tax,             color: '#f59e0b' },
                      { label: 'Other Ded.',     value: preview.deductions?.otherDeduction,  color: '#9ca3af' },
                    ].map(item => (
                      <div key={item.label} className="prc-breakdown-row">
                        <span className="prc-breakdown-dot" style={{ background: item.color }} />
                        <span>{item.label}</span>
                        <strong className="text-danger">-{fmtINR(item.value)}</strong>
                      </div>
                    ))}
                    <div className="prc-breakdown-total ded">
                      <span>Total Deductions</span>
                      <strong className="text-danger">-{fmtINR(totalDed)}</strong>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Adjustments Tab ── */}
          {activeSection === 'adjustments' && (
            <div className="prc-two-col">
              <div className="prc-section-card">
                <div className="prc-section-header earn">
                  <Zap size={15} />
                  <span>Manual Additions</span>
                </div>
                <div className="prc-rows">
                  <AmountRow label="Bonus (Fixed ₹)"      fieldKey="manualBonus"     value={structure.manualBonus}     onChange={handleChange} color="#10b981" />
                  <AmountRow label="Incentive / Reward"   fieldKey="manualIncentive" value={structure.manualIncentive} onChange={handleChange} color="#06b6d4" />
                </div>
                {preview && (
                  <div className="prc-breakdown">
                    <div className="prc-breakdown-row">
                      <span className="prc-breakdown-dot" style={{ background: '#10b981' }} />
                      <span>Fixed Bonus</span>
                      <strong>{fmtINR(preview.earnings?.manualBonus)}</strong>
                    </div>
                    <div className="prc-breakdown-row">
                      <span className="prc-breakdown-dot" style={{ background: '#06b6d4' }} />
                      <span>Incentive</span>
                      <strong>{fmtINR(preview.earnings?.manualIncentive)}</strong>
                    </div>
                    {preview.overtimeEarnings > 0 && (
                      <div className="prc-breakdown-row">
                        <span className="prc-breakdown-dot" style={{ background: '#f59e0b' }} />
                        <span>Overtime</span>
                        <strong>{fmtINR(preview.overtimeEarnings)}</strong>
                      </div>
                    )}
                  </div>
                )}
              </div>

              <div className="prc-section-card">
                <div className="prc-section-header ded">
                  <ChevronDown size={15} />
                  <span>Manual Deductions</span>
                </div>
                <div className="prc-rows">
                  <AmountRow label="Penalty"              fieldKey="manualPenalty"   value={structure.manualPenalty}   onChange={handleChange} color="#ef4444" />
                  <AmountRow label="Custom Deduction"     fieldKey="manualDeduction" value={structure.manualDeduction} onChange={handleChange} color="#f59e0b" />
                </div>
                {preview && (
                  <div className="prc-breakdown">
                    <div className="prc-breakdown-row">
                      <span className="prc-breakdown-dot" style={{ background: '#ef4444' }} />
                      <span>Penalty</span>
                      <strong className="text-danger">-{fmtINR(preview.deductions?.manualPenalty)}</strong>
                    </div>
                    <div className="prc-breakdown-row">
                      <span className="prc-breakdown-dot" style={{ background: '#f59e0b' }} />
                      <span>Custom</span>
                      <strong className="text-danger">-{fmtINR(preview.deductions?.manualDeduction)}</strong>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Live Preview Tab ── */}
          {activeSection === 'preview' && preview && (
            <div className="prc-preview-tab">
              {/* Attendance summary bar */}
              <div className="prc-att-summary">
                {[
                  { label: 'Working Days',  value: preview.workingDaysInMonth, color: '#6b7280' },
                  { label: 'Present',       value: preview.presentDays,        color: '#10b981' },
                  { label: 'Absent',        value: preview.absentDays || 0,    color: '#ef4444' },
                  { label: 'Half Day',      value: preview.halfDayCount || 0,  color: '#f59e0b' },
                  { label: 'Overtime',      value: fmtINR(preview.overtimeEarnings), color: '#4f46e5', isAmt: true },
                  { label: 'Attendance %',  value: `${preview.attendancePct}%`, color: preview.attendancePct >= 90 ? '#10b981' : preview.attendancePct >= 75 ? '#f59e0b' : '#ef4444', isStr: true },
                ].map(item => (
                  <div key={item.label} className="prc-att-chip">
                    <span className="prc-att-chip-val" style={{ color: item.color }}>
                      {item.isStr || item.isAmt ? item.value : item.value}
                    </span>
                    <span className="prc-att-chip-label">{item.label}</span>
                  </div>
                ))}
              </div>

              {/* IN_HAND gross-up explanation card */}
              {isInHand && preview?.grossUpResult && (
                <div className="prc-grossup-card">
                  <div className="prc-grossup-title">💵 Gross-Up Calculation (TYPE A)</div>
                  <div className="prc-grossup-body">
                    <div className="prc-gu-row"><span>Net Target (Bank Credit)</span><strong>{fmtINR(preview.netTarget ?? netTarget)}</strong></div>
                    {preview.proratedNet !== preview.netTarget && (
                      <div className="prc-gu-row"><span>Pro-rated Net (Attendance)</span><strong>{fmtINR(preview.proratedNet)}</strong></div>
                    )}
                    <div className="prc-gu-row gross"><span>Computed Gross (by gross-up)</span><strong>{fmtINR(preview.grossUpResult.gross)}</strong></div>
                    <div className="prc-gu-row"><span>PF (absorbed by company)</span><strong className="text-danger">-{fmtINR(preview.grossUpResult.pf)}</strong></div>
                    <div className="prc-gu-row"><span>Income Tax (absorbed)</span><strong className="text-danger">-{fmtINR(preview.grossUpResult.tax)}</strong></div>
                    <div className="prc-gu-row"><span>Prof. Tax (absorbed)</span><strong className="text-danger">-{fmtINR(preview.grossUpResult.pt)}</strong></div>
                    {preview.grossUpResult.other > 0 && (
                      <div className="prc-gu-row"><span>Other (absorbed)</span><strong className="text-danger">-{fmtINR(preview.grossUpResult.other)}</strong></div>
                    )}
                    <div className="prc-gu-row dra"><span>DRA (Deduction Reimb. Allowance)</span><strong className="text-danger">{fmtINR(preview.grossUpResult.dra)}</strong></div>
                    <div className="prc-gu-row net"><span>Employee Receives (Net)</span><strong className="text-success">{fmtINR(preview.netSalary)}</strong></div>
                    <div className="prc-gu-note">The DRA is added to salary slip for transparency. Company absorbs PF+Tax+PT as per IT Act §17(2)(iv).</div>
                  </div>
                </div>
              )}

              {/* Full breakdown table */}
              <div className="prc-full-table">
                <div className="prc-full-table-header">
                  Earnings Breakdown
                  {isInHand && <span className="prc-type-chip">TYPE A – In-Hand</span>}
                </div>
                <table className="prc-table">
                  <thead>
                    <tr><th>Component</th><th>Basis</th><th>%</th><th>Amount</th></tr>
                  </thead>
                  <tbody>
                    {isInHand ? [
                      { name: 'Basic Salary',  basis: 'Gross',  pct: structure.basicPercent,  amt: preview.earnings?.basic },
                      { name: 'HRA',           basis: 'Gross',  pct: structure.hraPercent,    amt: preview.earnings?.hra },
                      { name: 'Special Allow.',basis: 'Gross',  pct: '—',                     amt: preview.earnings?.special },
                      { name: 'DRA (Absorbed)',basis: 'Gross',  pct: '—',                     amt: preview.earnings?.dra },
                    ].filter(r => r.amt > 0).map(r => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="muted">{r.basis}</td>
                        <td className="prc-pct-cell">{formatPctDisplay(r.pct)}</td>
                        <td className="text-success"><strong>{fmtINR(r.amt)}</strong></td>
                      </tr>
                    )) : [
                      { name: 'Basic Salary',  basis: 'Earned',  pct: structure.basicPercent,     amt: preview.earnings?.basic },
                      { name: 'HRA',           basis: 'Earned',  pct: structure.hraPercent,        amt: preview.earnings?.hra },
                      { name: 'Allowances',    basis: 'Earned',  pct: structure.allowancePercent,  amt: preview.earnings?.allowance },
                      { name: 'Bonus',         basis: 'Earned',  pct: structure.bonusPercent,      amt: preview.earnings?.bonus },
                      { name: 'Manual Bonus',  basis: 'Fixed',   pct: '—',                         amt: preview.earnings?.manualBonus },
                      { name: 'Incentive',     basis: 'Fixed',   pct: '—',                         amt: preview.earnings?.manualIncentive },
                      { name: 'Overtime',      basis: 'Policy',  pct: '—',                         amt: preview.overtimeEarnings },
                    ].filter(r => r.amt > 0).map(r => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="muted">{r.basis}</td>
                        <td className="prc-pct-cell">{formatPctDisplay(r.pct)}</td>
                        <td className="text-success"><strong>{fmtINR(r.amt)}</strong></td>
                      </tr>
                    ))}
                    <tr className="prc-table-subtotal">
                      <td colSpan={3}><strong>Gross Earnings</strong></td>
                      <td><strong>{fmtINR(gross)}</strong></td>
                    </tr>
                  </tbody>
                </table>

                <div className="prc-full-table-header ded" style={{ marginTop: 16 }}>
                  Deductions Breakdown
                  {isInHand && <span className="prc-type-chip warn">Absorbed by Company</span>}
                </div>
                <table className="prc-table">
                  <thead>
                    <tr><th>Component</th><th>Basis</th><th>%</th><th>Amount</th></tr>
                  </thead>
                  <tbody>
                    {isInHand ? [
                      { name: 'PF (company-absorbed)',   basis: 'Basic', pct: structure.pfPercent,  amt: preview.deductions?.pf },
                      { name: 'Income Tax (absorbed)',   basis: 'Gross', pct: structure.taxPercent, amt: preview.deductions?.tax },
                      { name: 'Prof. Tax (absorbed)',    basis: 'Slab',  pct: '—',                  amt: preview.deductions?.pt },
                      { name: 'Penalty',                 basis: 'Fixed', pct: '—',                  amt: preview.deductions?.manualPenalty },
                      { name: 'Custom Deduct.',          basis: 'Fixed', pct: '—',                  amt: preview.deductions?.manualDeduction },
                    ].filter(r => r.amt > 0).map(r => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="muted">{r.basis}</td>
                        <td className="prc-pct-cell">{formatPctDisplay(r.pct)}</td>
                        <td className="text-danger">-<strong>{fmtINR(r.amt)}</strong></td>
                      </tr>
                    )) : [
                      { name: 'PF',              basis: 'Basic',  pct: structure.pfPercent,         amt: preview.deductions?.pf },
                      { name: 'Income Tax',      basis: 'Gross',  pct: structure.taxPercent,        amt: preview.deductions?.tax },
                      { name: 'Other',           basis: 'Gross',  pct: structure.otherDeductionPct, amt: preview.deductions?.otherDeduction },
                      { name: 'Penalty',         basis: 'Fixed',  pct: '—',                         amt: preview.deductions?.manualPenalty },
                      { name: 'Custom Deduct.',  basis: 'Fixed',  pct: '—',                         amt: preview.deductions?.manualDeduction },
                    ].filter(r => r.amt > 0).map(r => (
                      <tr key={r.name}>
                        <td>{r.name}</td>
                        <td className="muted">{r.basis}</td>
                        <td className="prc-pct-cell">{formatPctDisplay(r.pct)}</td>
                        <td className="text-danger">-<strong>{fmtINR(r.amt)}</strong></td>
                      </tr>
                    ))}
                    <tr className="prc-table-subtotal ded">
                      <td colSpan={3}><strong>Total Deductions</strong></td>
                      <td className="text-danger"><strong>-{fmtINR(totalDed)}</strong></td>
                    </tr>
                  </tbody>
                </table>

                <div className="prc-net-final">
                  <div>
                    <span>Gross Earnings</span>
                    <strong>{fmtINR(gross)}</strong>
                  </div>
                  <span className="prc-minus">−</span>
                  <div>
                    <span>Total Deductions</span>
                    <strong className="text-danger">{fmtINR(totalDed)}</strong>
                  </div>
                  <span className="prc-equals">=</span>
                  <div className="prc-net-box">
                    <span>NET SALARY</span>
                    <FlipAmount value={Math.round(net)} className="net-final" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeSection === 'preview' && !preview && (
            <div className="prc-loading"><Loader2 size={20} className="hrms-spin" /><p>Calculating…</p></div>
          )}
        </>
      )}

      {/* Payslip Modal */}
      {showPayslip && (
        <PayslipModal
          preview={preview}
          employee={employee}
          year={year}
          month={month}
          onClose={() => setShowPayslip(false)}
        />
      )}
    </div>
  )
}
