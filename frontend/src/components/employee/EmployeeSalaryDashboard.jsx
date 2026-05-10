import { useState, useEffect, useCallback, useRef } from 'react'
import {
  TrendingUp, AlertCircle, CheckCircle2, Clock, Zap, Calendar,
  Award, ArrowUpRight, ArrowDownRight, Loader2, RefreshCw,
  ChevronDown, Download, Wallet, FileText, X,
} from 'lucide-react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { apiFetch } from '../../api'
import './EmployeeSalaryDashboard.css'

// ─── Helpers ─────────────────────────────────────────────────────────────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

function fmtINR(n, compact = false) {
  const v = Number(n || 0)
  if (compact) {
    if (v >= 100000) return `₹${(v / 100000).toFixed(1)}L`
    if (v >= 1000)   return `₹${(v / 1000).toFixed(1)}K`
  }
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

function pct(a, b) {
  if (!b) return 0
  return Math.min(100, Math.max(0, Math.round((a / b) * 100)))
}

const STATUS_META = {
  present:   { label: 'Present',    color: '#10b981', bg: '#d1fae5', icon: CheckCircle2 },
  late:      { label: 'Late',       color: '#f59e0b', bg: '#fef3c7', icon: Clock },
  half_day:  { label: 'Half Day',   color: '#06b6d4', bg: '#cffafe', icon: Clock },
  absent:    { label: 'Absent',     color: '#ef4444', bg: '#fee2e2', icon: AlertCircle },
  leave:     { label: 'Leave',      color: '#8b5cf6', bg: '#ede9fe', icon: Calendar },
  holiday:   { label: 'Holiday',    color: '#4f46e5', bg: '#e0e7ff', icon: Award },
  weekend:   { label: 'Weekend',    color: '#9ca3af', bg: '#f3f4f6', icon: Award },
  early_out: { label: 'Early Out',  color: '#fb923c', bg: '#ffedd5', icon: Clock },
}

// ─── Animated value counter ───────────────────────────────────────────────────

function AnimatedValue({ target, prefix = '', suffix = '', duration = 900, decimals = 0 }) {
  const [display, setDisplay] = useState(0)
  const raf = useRef(null)

  useEffect(() => {
    const start = performance.now()
    const from = 0

    const tick = (now) => {
      const progress = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - progress, 3)
      const value = from + (target - from) * eased
      setDisplay(parseFloat(value.toFixed(decimals)))
      if (progress < 1) raf.current = requestAnimationFrame(tick)
    }

    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [target, duration, decimals])

  return <>{prefix}{display.toLocaleString('en-IN')}{suffix}</>
}

// ─── Circular progress ring ───────────────────────────────────────────────────

function CircleRing({ pct: value, size = 100, stroke = 8, color = '#4f46e5', children }) {
  const r = (size - stroke) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (value / 100) * circ
  return (
    <div className="salary-ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle
          cx={size/2} cy={size/2} r={r} fill="none"
          stroke={color} strokeWidth={stroke}
          strokeDasharray={circ}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1s cubic-bezier(0.4,0,0.2,1)' }}
        />
      </svg>
      <div className="salary-ring-inner">{children}</div>
    </div>
  )
}

// ─── Custom Recharts tooltip ──────────────────────────────────────────────────

function SalaryTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload || {}
  return (
    <div className="salary-chart-tooltip">
      <div className="sct-date">{label}</div>
      <div className="sct-row">
        <span className="sct-dot" style={{ background: '#4f46e5' }} />
        <span>Cumulative</span>
        <strong>{fmtINR(d.cumulative)}</strong>
      </div>
      <div className="sct-row">
        <span className="sct-dot" style={{ background: '#10b981' }} />
        <span>Today Earned</span>
        <strong>{fmtINR(d.earned)}</strong>
      </div>
      {d.status && (
        <div className="sct-status" style={{ color: STATUS_META[d.status]?.color || '#6b7280' }}>
          {STATUS_META[d.status]?.label || d.status}
        </div>
      )}
    </div>
  )
}

// ─── Attendance Impact Row ────────────────────────────────────────────────────

function ImpactRow({ icon: Icon, label, days, amount, color, bg, positive = true, unit = 'days', neutralPay = false }) {
  return (
    <div className="impact-row">
      <div className="impact-icon" style={{ background: bg }}>
        <Icon size={14} style={{ color }} />
      </div>
      <div className="impact-info">
        <span className="impact-label">{label}</span>
        <span className="impact-days">{days} {unit}</span>
      </div>
      <div className={`impact-amount ${neutralPay ? 'neutral' : positive ? 'earn' : 'deduct'}`}>
        {neutralPay ? '—' : (<>{positive ? '+' : ''}{fmtINR(Math.abs(amount))}</>)}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function EmployeeSalaryDashboard({ token }) {
  const today = new Date()
  const [year, setYear]   = useState(today.getFullYear())
  const [month, setMonth] = useState(today.getMonth() + 1)

  const [accrual,  setAccrual]  = useState(null)
  const [ledger,   setLedger]   = useState([])
  const [impact,   setImpact]   = useState(null)
  const [loadingA, setLoadingA] = useState(true)
  const [loadingL, setLoadingL] = useState(true)
  const [loadingI, setLoadingI] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) { setLoadingA(true); setLoadingL(true); setLoadingI(true) }
    const params = `year=${year}&month=${month}`
    try {
      const [a, l, i] = await Promise.all([
        apiFetch(`/user/payroll/accrual?year=${year}&month=${month}`, {}, token).catch(() => null),
        apiFetch(`/user/payroll/ledger?${params}`, {}, token).catch(() => ({ entries: [] })),
        apiFetch(`/user/payroll/attendance-impact?${params}`, {}, token).catch(() => null),
      ])
      setAccrual(a)
      setLedger(l?.entries || [])
      setImpact(i)
    } catch { /* no-op */ }
    setLoadingA(false); setLoadingL(false); setLoadingI(false)
  }, [year, month, token])

  useEffect(() => { fetchAll() }, [fetchAll])

  const handleRefresh = async () => {
    setRefreshing(true)
    await fetchAll(true)
    setRefreshing(false)
  }

  // Build chart data from ledger entries
  const chartData = (() => {
    let cumulative = 0
    return ledger.map(entry => {
      cumulative += entry.finalAmount || 0
      const dateObj = new Date(entry.date + 'T00:00:00')
      return {
        day: dateObj.getDate(),
        label: `${dateObj.getDate()} ${MONTHS[dateObj.getMonth()].slice(0,3)}`,
        earned: entry.finalAmount || 0,
        deduction: entry.deductionAmount || 0,
        cumulative: parseFloat(cumulative.toFixed(2)),
        status: entry.attendanceStatus,
      }
    })
  })()

  const earnedPct  = accrual ? pct(accrual.earnedTillNow, accrual.monthlySalary) : 0
  const attPct     = accrual ? Math.round(accrual.attendancePct || 0) : 0
  const isLoading  = loadingA && loadingL && loadingI

  const isCurrentMonth = year === today.getFullYear() && month === (today.getMonth() + 1)

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="emp-salary-dashboard">

      {/* ── Month Selector ── */}
      <div className="emp-salary-header">
        <div className="emp-salary-header-title">
          <div className="emp-salary-header-icon">
            <TrendingUp size={18} />
          </div>
          <div>
            <h3>Salary Accrual</h3>
            <p className="emp-salary-subtitle">Live earnings based on attendance</p>
          </div>
        </div>
        <div className="emp-salary-header-right">
          <div className="emp-month-picker">
            <select value={month} onChange={e => { setMonth(Number(e.target.value)) }} className="emp-salary-select">
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
            <select value={year} onChange={e => { setYear(Number(e.target.value)) }} className="emp-salary-select">
              {[2024, 2025, 2026, 2027].map(y => <option key={y} value={y}>{y}</option>)}
            </select>
          </div>
          <button className="emp-salary-refresh" onClick={handleRefresh} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'hrms-spin' : ''} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="emp-salary-skeleton-grid">
          {Array.from({ length: 4 }).map((_, i) => <div key={i} className="emp-salary-skeleton-card" />)}
        </div>
      ) : (
        <>
          {/* ── Hero Progress Card ── */}
          <div className="emp-salary-hero">
            <div className="emp-salary-hero-ring">
              <CircleRing pct={earnedPct} size={120} stroke={9} color="#4f46e5">
                <span className="ring-pct">{earnedPct}%</span>
                <span className="ring-label">earned</span>
              </CircleRing>
            </div>

            <div className="emp-salary-hero-stats">
              <div className="emp-salary-hero-main">
                <div className="esp-metric">
                  <span className="esp-label">Monthly CTC</span>
                  <span className="esp-value primary">{fmtINR(accrual?.monthlySalary)}</span>
                </div>
                <div className="esp-divider" />
                <div className="esp-metric">
                  <span className="esp-label">Earned Till Today</span>
                  <span className="esp-value success">
                    {loadingA ? '—' : <AnimatedValue target={accrual?.earnedTillNow || 0} prefix="₹" />}
                  </span>
                </div>
                <div className="esp-divider" />
                <div className="esp-metric">
                  <span className="esp-label">Remaining</span>
                  <span className="esp-value muted">{fmtINR(accrual?.remainingSalary)}</span>
                </div>
              </div>

              <div className="emp-salary-progress-bar-wrap">
                <div className="esp-bar-bg">
                  <div className="esp-bar-fill" style={{ width: `${earnedPct}%` }}>
                    <div className="esp-bar-shine" />
                  </div>
                </div>
                <div className="esp-bar-labels">
                  <span>₹0</span>
                  <span className="esp-bar-mid">₹{Math.round((accrual?.monthlySalary || 0) / 2).toLocaleString('en-IN')}</span>
                  <span>{fmtINR(accrual?.monthlySalary, true)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── 4 Quick Metric Cards ── */}
          <div className="emp-salary-cards">
            {[
              {
                label: isCurrentMonth ? "Today's Earnings" : 'Daily Rate',
                value: accrual?.todayEarnings ?? accrual?.dailyRate ?? 0,
                icon: Zap,
                color: '#f59e0b',
                bg: '#fef3c7',
                prefix: '₹',
              },
              {
                label: 'Attendance',
                value: attPct,
                icon: CheckCircle2,
                color: attPct >= 90 ? '#10b981' : attPct >= 75 ? '#f59e0b' : '#ef4444',
                bg: attPct >= 90 ? '#d1fae5' : attPct >= 75 ? '#fef3c7' : '#fee2e2',
                suffix: '%',
                sub: `${accrual?.presentDays || 0} / ${accrual?.workingDaysInMonth || 0} days`,
              },
              {
                label: 'Total Deductions',
                value: accrual?.totalDeductions ?? 0,
                icon: ArrowDownRight,
                color: '#ef4444',
                bg: '#fee2e2',
                prefix: '₹',
                negative: true,
              },
              {
                label: 'Overtime Earned',
                value: accrual?.totalOvertime ?? 0,
                icon: TrendingUp,
                color: '#10b981',
                bg: '#d1fae5',
                prefix: '₹',
                sub: accrual?.totalOvertimeHours ? `${accrual.totalOvertimeHours}h` : null,
              },
            ].map(card => {
              const Icon = card.icon
              return (
                <div key={card.label} className="emp-salary-card">
                  <div className="esc-icon" style={{ background: card.bg }}>
                    <Icon size={16} style={{ color: card.color }} />
                  </div>
                  <div className="esc-content">
                    <span className="esc-label">{card.label}</span>
                    <span className="esc-value" style={{ color: card.color }}>
                      {card.prefix || ''}<AnimatedValue target={Number(card.value || 0)} duration={700} />{card.suffix || ''}
                    </span>
                    {card.sub && <span className="esc-sub">{card.sub}</span>}
                  </div>
                </div>
              )
            })}
          </div>

          {/* ── Salary Timeline Chart ── */}
          {chartData.length > 0 && (
            <div className="emp-salary-chart-card">
              <div className="emp-chart-header">
                <div>
                  <h4>Salary Growth Timeline</h4>
                  <p className="muted small">Cumulative accrual — {MONTHS[month - 1]} {year}</p>
                </div>
                <div className="emp-chart-legend">
                  <span><span className="legend-dot" style={{ background: '#4f46e5' }} />Cumulative</span>
                  <span><span className="legend-dot" style={{ background: '#10b981' }} />Daily</span>
                </div>
              </div>
              <div className="emp-chart-wrap">
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={chartData} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="gradCumulative" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#4f46e5" stopOpacity={0.25} />
                        <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="gradEarned" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                        <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border-1)" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--text-muted)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                    <YAxis
                      tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                      axisLine={false} tickLine={false}
                      tickFormatter={v => v >= 1000 ? `₹${(v/1000).toFixed(0)}K` : `₹${v}`}
                      width={52}
                    />
                    <Tooltip content={<SalaryTooltip />} />
                    {accrual?.monthlySalary > 0 && (
                      <ReferenceLine
                        y={accrual.monthlySalary}
                        stroke="#4f46e5"
                        strokeDasharray="5 3"
                        strokeOpacity={0.4}
                        label={{ value: 'Target', position: 'right', fontSize: 10, fill: '#4f46e5' }}
                      />
                    )}
                    <Area type="monotone" dataKey="cumulative" stroke="#4f46e5" strokeWidth={2.5} fill="url(#gradCumulative)" dot={false} activeDot={{ r: 4, strokeWidth: 0 }} />
                    <Area type="monotone" dataKey="earned"     stroke="#10b981" strokeWidth={1.5} fill="url(#gradEarned)"     dot={false} activeDot={{ r: 3, strokeWidth: 0 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* ── Attendance Impact ── */}
          {impact && (
            <div className="emp-impact-card">
              <h4>Attendance Impact</h4>
              <p className="muted small">How your attendance affects this month's salary</p>
              <div className="emp-impact-grid">
                {[
                  { key: 'present',   positive: true },
                  { key: 'holiday',   positive: true },
                  { key: 'weekend',   positive: true },
                  { key: 'paidLeave', positive: true },
                  { key: 'halfDay',   positive: true },
                  { key: 'absent',    positive: false },
                  { key: 'overtime',  positive: true  },
                ].map(({ key, positive }) => {
                  const imp = impact.impact[key]
                  if (!imp) return null
                  const days  = imp.days  || 0
                  const hours = imp.hours || 0
                  const amount = imp.amount || 0
                  if (days === 0 && hours === 0) return null
                  const meta = key === 'paidLeave' ? STATUS_META.leave : (STATUS_META[key] || STATUS_META.present)
                  const Icon = meta.icon
                  const label = key === 'paidLeave' ? 'Paid Leave' : key === 'halfDay' ? 'Half Day' : meta.label
                  const neutralPay = key === 'weekend'
                  return (
                    <ImpactRow
                      key={key}
                      icon={Icon}
                      label={label}
                      days={key === 'overtime' ? `${hours}h` : days}
                      amount={amount}
                      color={meta.color}
                      bg={meta.bg}
                      positive={positive}
                      unit={key === 'overtime' ? '' : 'days'}
                      neutralPay={neutralPay}
                    />
                  )
                })}
              </div>

              <div className="emp-impact-net">
                <div>
                  <span>Estimated net (full month)</span>
                  <p className="muted small" style={{ margin: '4px 0 0', fontWeight: 400 }}>
                    Salary structure + attendance through this period ({MONTHS[month - 1]} {year}).
                  </p>
                </div>
                <strong className="text-success">{fmtINR(accrual?.projectedNetSalary ?? impact?.projectedNetSalary ?? 0)}</strong>
              </div>
              <div className="emp-impact-net emp-impact-net--secondary">
                <span>Accrued so far (MTD)</span>
                <strong>{fmtINR(accrual?.earnedTillNow)}</strong>
              </div>
            </div>
          )}

          {/* ── Status Breakdown Chips ── */}
          {accrual?.statusBreakdown && Object.keys(accrual.statusBreakdown).length > 0 && (
            <div className="emp-status-breakdown">
              {Object.entries(accrual.statusBreakdown)
                .filter(([, v]) => v > 0)
                .map(([status, count]) => {
                  const meta = STATUS_META[status] || { label: status, color: '#6b7280', bg: '#f3f4f6', icon: Clock }
                  const Icon = meta.icon
                  return (
                    <div key={status} className="emp-status-chip" style={{ background: meta.bg, color: meta.color }}>
                      <Icon size={12} />
                      <span>{count} {meta.label}</span>
                    </div>
                  )
                })}
              {accrual.saturdayPolicy && (
                <div className="emp-status-chip saturday-policy">
                  <Calendar size={12} />
                  <span>Saturday: {accrual.saturdayPolicy}</span>
                </div>
              )}
            </div>
          )}

          {/* ── No salary configured ── */}
          {!accrual?.monthlySalary && (
            <div className="emp-salary-empty">
              <Wallet size={32} />
              <p>Salary not configured yet.</p>
              <span className="muted small">Please ask your HR to set up your salary structure.</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}
