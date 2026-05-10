import { useState, useEffect, useCallback, useRef } from 'react'
import {
  TrendingUp, Users, DollarSign, Clock, AlertCircle, CheckCircle2,
  Download, RefreshCw, ChevronDown, ChevronUp, Search, Filter,
  Calendar, BarChart2, Award, Zap, FileText, ArrowUpRight, ArrowDownRight,
  Play, MoreHorizontal, Loader2, X, Check, Info,
} from 'lucide-react'
import { apiFetch } from '../../api'
import AnimatedCounter from '../common/AnimatedCounter'
import './PayrollDashboard.css'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n) {
  const num = Number(n || 0)
  if (num >= 100000) return `₹${(num / 100000).toFixed(1)}L`
  if (num >= 1000) return `₹${(num / 1000).toFixed(1)}K`
  return `₹${num.toLocaleString('en-IN')}`
}

function fmtFull(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

const STATUS_CONFIG = {
  draft:      { label: 'Draft',      cls: 'status-draft',      icon: Clock },
  processing: { label: 'Processing', cls: 'status-processing', icon: RefreshCw },
  paid:       { label: 'Paid',       cls: 'status-paid',       icon: CheckCircle2 },
  failed:     { label: 'Failed',     cls: 'status-failed',     icon: AlertCircle },
}

const ATT_STATUS_COLORS = {
  present:   '#10b981',
  late:      '#f59e0b',
  half_day:  '#06b6d4',
  absent:    '#ef4444',
  leave:     '#8b5cf6',
  holiday:   '#4f46e5',
  weekend:   '#9ca3af',
  early_out: '#fb923c',
}

function StatusChip({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.draft
  const Icon = cfg.icon
  return (
    <span className={`payroll-status-chip ${cfg.cls}`}>
      <Icon size={11} />
      {cfg.label}
    </span>
  )
}

function SkeletonRow() {
  return (
    <tr className="payroll-skeleton-row">
      {Array.from({ length: 14 }).map((_, i) => (
        <td key={i}><div className="payroll-skeleton-cell" /></td>
      ))}
    </tr>
  )
}

function Toast({ toast, onDismiss }) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onDismiss, 3500)
    return () => clearTimeout(t)
  }, [toast, onDismiss])
  if (!toast) return null
  return (
    <div className={`payroll-toast payroll-toast-${toast.type}`}>
      {toast.type === 'success' ? <Check size={15} /> : <AlertCircle size={15} />}
      <span>{toast.message}</span>
      <button onClick={onDismiss} className="payroll-toast-close"><X size={13} /></button>
    </div>
  )
}

// ─── Mini bar chart ───────────────────────────────────────────────────────────

function MiniBarChart({ entries = [] }) {
  if (!entries.length) return <div className="mini-chart-empty">No data</div>
  const max = Math.max(...entries.map(e => e.finalAmount || 0), 1)
  return (
    <div className="mini-bar-chart">
      {entries.map((e, i) => {
        const h = Math.max(4, Math.round((e.finalAmount / max) * 52))
        const color = ATT_STATUS_COLORS[e.attendanceStatus] || '#4f46e5'
        return (
          <div key={i} className="mini-bar-wrap" title={`${e.date}: ₹${e.finalAmount}`}>
            <div className="mini-bar" style={{ height: h, background: color }} />
          </div>
        )
      })}
    </div>
  )
}

// ─── Attendance breakdown pill ────────────────────────────────────────────────

function AttBreakdown({ breakdown = {} }) {
  const items = Object.entries(breakdown)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
  if (!items.length) return <span className="muted">—</span>
  return (
    <div className="att-breakdown">
      {items.map(([status, count]) => (
        <span key={status} className="att-pill" style={{ background: (ATT_STATUS_COLORS[status] || '#9ca3af') + '22', color: ATT_STATUS_COLORS[status] || '#6b7280' }}>
          {count} {status.replace('_', ' ')}
        </span>
      ))}
    </div>
  )
}

// ─── Salary Progress Bar ──────────────────────────────────────────────────────

function SalaryProgress({ earned, total, color = '#4f46e5' }) {
  const pct = total > 0 ? Math.min(100, Math.round((earned / total) * 100)) : 0
  return (
    <div className="salary-progress-wrap">
      <div className="salary-progress-bar">
        <div className="salary-progress-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="salary-progress-pct">{pct}%</span>
    </div>
  )
}

// ─── Employee Ledger Drawer ───────────────────────────────────────────────────

function LedgerDrawer({ employee, year, month, onClose, token }) {
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!employee) return
    setLoading(true)
    apiFetch(`/api/salary-ledger?employeeId=${employee.employeeId}&year=${year}&month=${month}`, {}, token)
      .then(d => setEntries(d.entries || []))
      .catch(() => setEntries([]))
      .finally(() => setLoading(false))
  }, [employee, year, month, token])

  if (!employee) return null

  const totalEarned = entries.reduce((s, e) => s + (e.earnedAmount || 0), 0)
  const totalFinal = entries.reduce((s, e) => s + (e.finalAmount || 0), 0)
  const totalOT = entries.reduce((s, e) => s + (e.overtimeAmount || 0), 0)

  return (
    <div className="ledger-drawer-backdrop" onClick={onClose}>
      <div className="ledger-drawer" onClick={e => e.stopPropagation()}>
        <div className="ledger-drawer-header">
          <div>
            <h3>{employee.employeeName}</h3>
            <p className="muted small">{MONTHS[month - 1]} {year} · Daily Salary Ledger</p>
          </div>
          <button className="ghost icon-btn" onClick={onClose}><X size={18} /></button>
        </div>

        <div className="ledger-summary-row">
          <div className="ledger-summary-card">
            <span className="muted small">Earned</span>
            <strong>{fmtFull(totalEarned)}</strong>
          </div>
          <div className="ledger-summary-card">
            <span className="muted small">Overtime</span>
            <strong className="text-success">{fmtFull(totalOT)}</strong>
          </div>
          <div className="ledger-summary-card">
            <span className="muted small">Final</span>
            <strong className="text-primary">{fmtFull(totalFinal)}</strong>
          </div>
        </div>

        {loading ? (
          <div className="ledger-loading"><Loader2 className="hrms-spin" size={24} /></div>
        ) : (
          <div className="ledger-table-wrap">
            <table className="ledger-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Status</th>
                  <th>Earned</th>
                  <th>Deduction</th>
                  <th>OT Hrs</th>
                  <th>OT Amt</th>
                  <th>Final</th>
                </tr>
              </thead>
              <tbody>
                {entries.map(e => (
                  <tr key={e.date}>
                    <td className="ledger-date">{e.date}</td>
                    <td>
                      <span className="att-pill" style={{
                        background: (ATT_STATUS_COLORS[e.attendanceStatus] || '#9ca3af') + '22',
                        color: ATT_STATUS_COLORS[e.attendanceStatus] || '#6b7280'
                      }}>
                        {e.attendanceStatus?.replace('_', ' ')}
                      </span>
                    </td>
                    <td>₹{(e.earnedAmount || 0).toFixed(0)}</td>
                    <td className={e.deductionAmount > 0 ? 'text-danger' : ''}>
                      {e.deductionAmount > 0 ? `-₹${e.deductionAmount.toFixed(0)}` : '—'}
                    </td>
                    <td>{e.overtimeHours > 0 ? `${e.overtimeHours}h` : '—'}</td>
                    <td className={e.overtimeAmount > 0 ? 'text-success' : ''}>
                      {e.overtimeAmount > 0 ? `+₹${e.overtimeAmount.toFixed(0)}` : '—'}
                    </td>
                    <td><strong>₹{(e.finalAmount || 0).toFixed(0)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Analytics Section ────────────────────────────────────────────────────────

function AttendanceAnalytics({ analytics, loading }) {
  if (loading) {
    return (
      <div className="analytics-grid">
        {Array.from({ length: 4 }).map((_, i) => <div key={i} className="analytics-card skeleton-card" />)}
      </div>
    )
  }
  if (!analytics) return null

  const stats = [
    { label: 'Present Rate', value: `${analytics.presentPct}%`, color: '#10b981', icon: CheckCircle2, trend: 'up' },
    { label: 'Late Rate',    value: `${analytics.latePct}%`,    color: '#f59e0b', icon: Clock,        trend: analytics.latePct > 10 ? 'down' : 'up' },
    { label: 'Absent Rate',  value: `${analytics.absentPct}%`,  color: '#ef4444', icon: AlertCircle,  trend: analytics.absentPct > 10 ? 'down' : 'up' },
    { label: 'Avg Work Hrs', value: `${analytics.avgWorkHours}h`, color: '#4f46e5', icon: BarChart2,  trend: 'up' },
  ]

  return (
    <div className="analytics-section">
      <div className="analytics-grid">
        {stats.map((s) => {
          const Icon = s.icon
          const TrendIcon = s.trend === 'up' ? ArrowUpRight : ArrowDownRight
          return (
            <div key={s.label} className="analytics-card" style={{ '--accent': s.color }}>
              <div className="analytics-card-icon" style={{ background: s.color + '18' }}>
                <Icon size={18} style={{ color: s.color }} />
              </div>
              <div className="analytics-card-content">
                <span className="analytics-card-label">{s.label}</span>
                <span className="analytics-card-value">{s.value}</span>
              </div>
              <TrendIcon size={14} className={s.trend === 'up' ? 'trend-up' : 'trend-down'} />
            </div>
          )
        })}
      </div>

      {(analytics.mostPunctual?.length > 0 || analytics.needAttention?.length > 0) && (
        <div className="analytics-lists">
          {analytics.mostPunctual?.length > 0 && (
            <div className="analytics-list-card">
              <div className="analytics-list-header">
                <Award size={15} style={{ color: '#10b981' }} />
                <span>Most Punctual</span>
              </div>
              {analytics.mostPunctual.map(e => (
                <div key={e.employeeId} className="analytics-list-item">
                  <div className="analytics-emp-avatar">{(e.name || 'U').charAt(0).toUpperCase()}</div>
                  <div className="analytics-emp-info">
                    <span className="analytics-emp-name">{e.name}</span>
                    <span className="analytics-emp-dept muted small">{e.department}</span>
                  </div>
                  <div className="analytics-att-badge success">{e.attendancePct}%</div>
                </div>
              ))}
            </div>
          )}
          {analytics.needAttention?.length > 0 && (
            <div className="analytics-list-card">
              <div className="analytics-list-header">
                <AlertCircle size={15} style={{ color: '#ef4444' }} />
                <span>Needs Attention</span>
              </div>
              {analytics.needAttention.map(e => (
                <div key={e.employeeId} className="analytics-list-item">
                  <div className="analytics-emp-avatar" style={{ background: '#fee2e2', color: '#ef4444' }}>{(e.name || 'U').charAt(0).toUpperCase()}</div>
                  <div className="analytics-emp-info">
                    <span className="analytics-emp-name">{e.name}</span>
                    <span className="analytics-emp-dept muted small">{e.department}</span>
                  </div>
                  <div className="analytics-att-badge danger">{e.attendancePct}%</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main Dashboard ───────────────────────────────────────────────────────────

export default function PayrollDashboard({ token }) {
  const today = new Date()
  const [year, setYear]   = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)

  const [summary, setSummary]         = useState(null)
  const [employees, setEmployees]     = useState([])
  const [analytics, setAnalytics]     = useState(null)
  const [loadingSummary, setLoadingS] = useState(true)
  const [loadingEmps, setLoadingE]    = useState(true)
  const [loadingAna, setLoadingA]     = useState(true)
  const [calculating, setCalculating] = useState(false)
  const [toast, setToast]             = useState(null)
  const [search, setSearch]           = useState('')
  const [sortKey, setSortKey]         = useState('name')
  const [sortDir, setSortDir]         = useState('asc')
  const [ledgerEmp, setLedgerEmp]     = useState(null)
  const [activeTab, setActiveTab]     = useState('overview')

  const showToast = useCallback((message, type = 'success') => {
    setToast({ message, type })
  }, [])

  const fetchSummary = useCallback(async () => {
    setLoadingS(true)
    try {
      const data = await apiFetch(`/api/payroll/summary?year=${year}&month=${month}`, {}, token)
      setSummary(data)
    } catch {
      setSummary(null)
    } finally {
      setLoadingS(false)
    }
  }, [year, month, token])

  const fetchEmployees = useCallback(async () => {
    setLoadingE(true)
    try {
      const data = await apiFetch(`/api/payroll/employees?year=${year}&month=${month}`, {}, token)
      setEmployees(data.employees || [])
    } catch {
      setEmployees([])
    } finally {
      setLoadingE(false)
    }
  }, [year, month, token])

  const fetchAnalytics = useCallback(async () => {
    setLoadingA(true)
    try {
      const data = await apiFetch(`/api/attendance/analytics?year=${year}&month=${month}`, {}, token)
      setAnalytics(data)
    } catch {
      setAnalytics(null)
    } finally {
      setLoadingA(false)
    }
  }, [year, month, token])

  useEffect(() => {
    fetchSummary()
    fetchEmployees()
    fetchAnalytics()
  }, [fetchSummary, fetchEmployees, fetchAnalytics])

  const handleCalculate = async () => {
    setCalculating(true)
    try {
      await apiFetch('/api/payroll/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ year, month }),
      }, token)
      showToast('Payroll recalculated successfully')
      await fetchSummary()
      await fetchEmployees()
    } catch (err) {
      showToast(err?.message || 'Calculation failed', 'error')
    } finally {
      setCalculating(false)
    }
  }

  const handleMarkPaid = async (emp) => {
    try {
      await apiFetch('/api/payroll/status', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: emp.employeeId, year, month, status: 'paid' }),
      }, token)
      showToast(`Marked ${emp.employeeName} as paid`)
      await fetchEmployees()
      await fetchSummary()
    } catch (err) {
      showToast(err?.message || 'Failed to update status', 'error')
    }
  }

  // Sort + filter employees
  const filtered = employees
    .filter(e => {
      const q = search.toLowerCase()
      return !q || e.employeeName?.toLowerCase().includes(q) || e.department?.toLowerCase().includes(q)
    })
    .sort((a, b) => {
      let va = a[sortKey] ?? ''
      let vb = b[sortKey] ?? ''
      if (typeof va === 'string') va = va.toLowerCase()
      if (typeof vb === 'string') vb = vb.toLowerCase()
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ? 1 : -1
      return 0
    })

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir('asc') }
  }

  const SortIcon = ({ k }) => {
    if (sortKey !== k) return <ChevronDown size={13} className="sort-neutral" />
    return sortDir === 'asc' ? <ChevronUp size={13} /> : <ChevronDown size={13} />
  }

  // ── Overview cards ──────────────────────────────────────────────────────────
  const overviewCards = [
    {
      label: 'Total Payroll',
      value: summary?.totalPayroll || 0,
      display: fmt(summary?.totalPayroll),
      icon: DollarSign,
      color: '#4f46e5',
      bg: 'rgba(79,70,229,0.08)',
      loading: loadingSummary,
    },
    {
      label: 'Total Deductions',
      value: summary?.totalDeductions || 0,
      display: fmt(summary?.totalDeductions),
      icon: ArrowDownRight,
      color: '#ef4444',
      bg: 'rgba(239,68,68,0.08)',
      loading: loadingSummary,
    },
    {
      label: 'Overtime Payouts',
      value: summary?.totalOvertime || 0,
      display: fmt(summary?.totalOvertime),
      icon: Zap,
      color: '#f59e0b',
      bg: 'rgba(245,158,11,0.08)',
      loading: loadingSummary,
    },
    {
      label: 'Final Payable',
      value: summary?.totalFinalPayable || 0,
      display: fmt(summary?.totalFinalPayable),
      icon: TrendingUp,
      color: '#10b981',
      bg: 'rgba(16,185,129,0.08)',
      loading: loadingSummary,
    },
    {
      label: 'Employees Paid',
      value: summary?.paidCount || 0,
      display: String(summary?.paidCount || 0),
      suffix: `/ ${summary?.totalEmployees || 0}`,
      icon: CheckCircle2,
      color: '#06b6d4',
      bg: 'rgba(6,182,212,0.08)',
      loading: loadingSummary,
    },
    {
      label: 'Avg Salary',
      value: summary?.averageSalary || 0,
      display: fmt(summary?.averageSalary),
      icon: Users,
      color: '#8b5cf6',
      bg: 'rgba(139,92,246,0.08)',
      loading: loadingSummary,
    },
  ]

  return (
    <div className="payroll-dashboard">
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* ── Header ── */}
      <div className="payroll-header card">
        <div className="payroll-header-left">
          <div className="payroll-header-icon">
            <DollarSign size={22} />
          </div>
          <div>
            <h2 className="payroll-header-title">Payroll Dashboard</h2>
            <p className="muted small">Real-time salary processing &amp; compliance</p>
          </div>
        </div>
        <div className="payroll-header-actions">
          <div className="payroll-month-picker">
            <select value={month} onChange={e => setMonth(Number(e.target.value))} className="payroll-select">
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <select value={year} onChange={e => setYear(Number(e.target.value))} className="payroll-select">
              {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button
            className="payroll-btn payroll-btn-primary"
            onClick={handleCalculate}
            disabled={calculating}
          >
            {calculating ? <Loader2 size={15} className="hrms-spin" /> : <RefreshCw size={15} />}
            {calculating ? 'Calculating…' : 'Recalculate'}
          </button>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="payroll-tabs">
        {['overview', 'employees', 'analytics'].map(tab => (
          <button
            key={tab}
            className={`payroll-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => setActiveTab(tab)}
          >
            {tab === 'overview' && <BarChart2 size={15} />}
            {tab === 'employees' && <Users size={15} />}
            {tab === 'analytics' && <TrendingUp size={15} />}
            <span>{tab.charAt(0).toUpperCase() + tab.slice(1)}</span>
          </button>
        ))}
      </div>

      {/* ── Overview Tab ── */}
      {activeTab === 'overview' && (
        <>
          {/* Overview Cards */}
          <div className="payroll-cards-grid">
            {overviewCards.map(card => {
              const Icon = card.icon
              return (
                <div key={card.label} className="payroll-metric-card">
                  <div className="payroll-metric-icon" style={{ background: card.bg }}>
                    <Icon size={20} style={{ color: card.color }} />
                  </div>
                  <div className="payroll-metric-content">
                    <span className="payroll-metric-label">{card.label}</span>
                    {card.loading ? (
                      <div className="payroll-skeleton-value" />
                    ) : (
                      <div className="payroll-metric-value">
                        <AnimatedCounter value={card.value} />
                        {card.suffix && <span className="payroll-metric-suffix">{card.suffix}</span>}
                      </div>
                    )}
                    {!card.loading && <span className="payroll-metric-display">{card.display}</span>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* Payroll Progress */}
          <div className="card payroll-progress-card">
            <div className="payroll-progress-header">
              <h4>Salary Disbursement Progress</h4>
              <span className="muted small">{MONTHS[month - 1]} {year}</span>
            </div>
            <div className="payroll-progress-items">
              <div className="payroll-progress-item">
                <span className="payroll-progress-label">Total Payroll Disbursed</span>
                <SalaryProgress earned={summary?.totalFinalPayable || 0} total={summary?.totalPayroll || 1} color="#4f46e5" />
              </div>
              <div className="payroll-progress-item">
                <span className="payroll-progress-label">Employees Paid</span>
                <SalaryProgress earned={summary?.paidCount || 0} total={summary?.totalEmployees || 1} color="#10b981" />
              </div>
            </div>

            <div className="payroll-status-summary">
              {[
                { label: 'Draft',      count: (summary?.totalEmployees || 0) - (summary?.paidCount || 0) - 0, color: '#9ca3af' },
                { label: 'Paid',       count: summary?.paidCount || 0,                                        color: '#10b981' },
                { label: 'Pending',    count: summary?.pendingCount || 0,                                     color: '#f59e0b' },
              ].map(s => (
                <div key={s.label} className="payroll-status-badge">
                  <span className="payroll-status-dot" style={{ background: s.color }} />
                  <span>{s.label}</span>
                  <strong>{s.count}</strong>
                </div>
              ))}
            </div>
          </div>

          {/* Top earners preview */}
          <div className="card">
            <div className="row between" style={{ marginBottom: 16 }}>
              <h4>Top Earners This Month</h4>
              <button className="ghost small" onClick={() => setActiveTab('employees')}>View All →</button>
            </div>
            {loadingEmps ? (
              <div className="payroll-skeleton-list">
                {Array.from({ length: 4 }).map((_, i) => <div key={i} className="payroll-skeleton-row-h" />)}
              </div>
            ) : (
              <div className="top-earners-list">
                {[...employees]
                  .sort((a, b) => (b.finalPayable || 0) - (a.finalPayable || 0))
                  .slice(0, 5)
                  .map((emp, i) => (
                    <div key={emp.employeeId} className="top-earner-item">
                      <div className="top-earner-rank">#{i + 1}</div>
                      <div className="top-earner-avatar">{(emp.employeeName || 'U').charAt(0).toUpperCase()}</div>
                      <div className="top-earner-info">
                        <span className="top-earner-name">{emp.employeeName}</span>
                        <span className="muted small">{emp.department}</span>
                      </div>
                      <div className="top-earner-salary">
                        <span className="top-earner-amount">{fmtFull(emp.finalPayable)}</span>
                        <SalaryProgress
                          earned={emp.earnedTillNow || 0}
                          total={emp.monthlySalary || 1}
                          color="#4f46e5"
                        />
                      </div>
                      <StatusChip status={emp.payrollStatus || 'draft'} />
                    </div>
                  ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Employees Tab ── */}
      {activeTab === 'employees' && (
        <div className="card payroll-table-card">
          <div className="payroll-table-toolbar">
            <div className="payroll-search-wrap">
              <Search size={15} />
              <input
                className="payroll-search"
                placeholder="Search employee or department…"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              {search && <button className="payroll-search-clear" onClick={() => setSearch('')}><X size={13} /></button>}
            </div>
            <div className="payroll-table-meta muted small">
              {filtered.length} employee{filtered.length !== 1 ? 's' : ''}
            </div>
          </div>

          <div className="payroll-table-wrap">
            <table className="payroll-table">
              <thead>
                <tr>
                  <th className="sortable" onClick={() => toggleSort('employeeName')}>
                    Employee <SortIcon k="employeeName" />
                  </th>
                  <th>Type</th>
                  <th>Department</th>
                  <th className="sortable" onClick={() => toggleSort('monthlySalary')}>
                    Monthly CTC <SortIcon k="monthlySalary" />
                  </th>
                  <th className="sortable" onClick={() => toggleSort('earnedTillNow')}>
                    Earned Till Today <SortIcon k="earnedTillNow" />
                  </th>
                  <th className="sortable" onClick={() => toggleSort('remainingSalary')}>
                    Remaining <SortIcon k="remainingSalary" />
                  </th>
                  <th className="sortable" onClick={() => toggleSort('todayEarnings')}>
                    Today&#39;s Earnings <SortIcon k="todayEarnings" />
                  </th>
                  <th>Progress</th>
                  <th className="sortable" onClick={() => toggleSort('totalDeductions')}>
                    Deductions <SortIcon k="totalDeductions" />
                  </th>
                  <th className="sortable" onClick={() => toggleSort('totalOvertime')}>
                    Overtime <SortIcon k="totalOvertime" />
                  </th>
                  <th className="sortable" onClick={() => toggleSort('finalPayable')}>
                    Final Payable <SortIcon k="finalPayable" />
                  </th>
                  <th>Attendance</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loadingEmps
                  ? Array.from({ length: 6 }).map((_, i) => <SkeletonRow key={i} />)
                  : filtered.length === 0
                    ? (
                      <tr>
                        <td colSpan={14} className="payroll-empty-row">
                          <div className="payroll-empty-state">
                            <Users size={32} className="muted" />
                            <p>{search ? 'No employees match your search.' : 'No payroll data for this month.'}</p>
                          </div>
                        </td>
                      </tr>
                    )
                    : filtered.map(emp => (
                      <tr key={emp.employeeId} className="payroll-emp-row">
                        <td>
                          <div className="payroll-emp-cell">
                            <div className="payroll-emp-avatar">{(emp.employeeName || 'U').charAt(0).toUpperCase()}</div>
                            <span className="payroll-emp-name">{emp.employeeName}</span>
                          </div>
                        </td>
                        <td>
                          {emp.salary_type === 'IN_HAND'
                            ? <span className="payroll-type-chip in-hand">💵 In-Hand</span>
                            : <span className="payroll-type-chip ctc">📊 CTC</span>
                          }
                        </td>
                        <td><span className="dept-chip">{emp.department || '—'}</span></td>
                        <td>{fmtFull(emp.monthlySalary)}</td>
                        <td>
                          <div className="earned-cell">
                            <strong>{fmtFull(emp.earnedTillNow)}</strong>
                          </div>
                        </td>
                        <td className="text-muted-val">{fmtFull(emp.remainingSalary)}</td>
                        <td>
                          {emp.todayEarnings > 0
                            ? <span className="today-earn-badge">+{fmtFull(emp.todayEarnings)}</span>
                            : <span className="muted">—</span>}
                        </td>
                        <td>
                          <SalaryProgress
                            earned={emp.earnedTillNow || 0}
                            total={emp.monthlySalary || 1}
                            color="#4f46e5"
                          />
                        </td>
                        <td className={emp.totalDeductions > 0 ? 'text-danger' : ''}>
                          {emp.totalDeductions > 0 ? `-${fmtFull(emp.totalDeductions)}` : '—'}
                        </td>
                        <td className={emp.totalOvertime > 0 ? 'text-success' : ''}>
                          {emp.totalOvertime > 0 ? `+${fmtFull(emp.totalOvertime)}` : '—'}
                        </td>
                        <td><strong>{fmtFull(emp.finalPayable)}</strong></td>
                        <td>
                          <div className="att-pct-wrap">
                            <span className={`att-pct ${emp.attendancePercentage >= 90 ? 'good' : emp.attendancePercentage >= 75 ? 'ok' : 'poor'}`}>
                              {(emp.attendancePercentage || 0).toFixed(1)}%
                            </span>
                          </div>
                        </td>
                        <td><StatusChip status={emp.payrollStatus || 'draft'} /></td>
                        <td>
                          <div className="payroll-row-actions">
                            <button
                              className="payroll-action-btn"
                              onClick={() => setLedgerEmp(emp)}
                              title="View Ledger"
                            >
                              <FileText size={13} />
                            </button>
                            {emp.payrollStatus !== 'paid' && (
                              <button
                                className="payroll-action-btn success"
                                onClick={() => handleMarkPaid(emp)}
                                title="Mark as Paid"
                              >
                                <Check size={13} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))
                }
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Analytics Tab ── */}
      {activeTab === 'analytics' && (
        <div className="payroll-analytics-tab">
          <AttendanceAnalytics analytics={analytics} loading={loadingAna} />
        </div>
      )}

      {/* ── Ledger Drawer ── */}
      {ledgerEmp && (
        <LedgerDrawer
          employee={ledgerEmp}
          year={year}
          month={month}
          onClose={() => setLedgerEmp(null)}
          token={token}
        />
      )}
    </div>
  )
}
