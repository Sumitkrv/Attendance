import { useState, useEffect, useMemo } from 'react'
import { apiFetch } from '../../api'
import {
  Play, Loader2, CheckCircle2, AlertCircle, Download,
  Calendar, Users, IndianRupee, FileText, RefreshCw, ChevronDown,
} from 'lucide-react'

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']

function fmtMoney(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

export default function BulkPayrollRun({ token, companies = [], selectedCompanyId, employees = [] }) {
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [department, setDepartment] = useState('')
  const [companyId, setCompanyId] = useState(selectedCompanyId || '')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')
  const [runs, setRuns] = useState([])
  const [runsLoading, setRunsLoading] = useState(false)
  const [payslips, setPayslips] = useState([])
  const [payslipsLoading, setPayslipsLoading] = useState(false)
  const [viewingRun, setViewingRun] = useState(null)
  const [expandedPayslip, setExpandedPayslip] = useState(null)

  useEffect(() => { setCompanyId(selectedCompanyId || '') }, [selectedCompanyId])

  const departments = useMemo(() => {
    const set = new Set()
    for (const emp of employees) {
      const dept = String(emp?.department || '').trim()
      if (dept) set.add(dept)
    }
    return Array.from(set).sort()
  }, [employees])

  const eligibleCount = useMemo(() => {
    return employees.filter(emp => {
      const status = String(emp?.status || 'active').toLowerCase()
      if (status !== 'active' && status !== 'probation') return false
      if (department && String(emp?.department || '').toLowerCase() !== department.toLowerCase()) return false
      return true
    }).length
  }, [employees, department])

  useEffect(() => { loadRuns() }, [token])

  async function loadRuns() {
    setRunsLoading(true)
    try {
      const data = await apiFetch('/api/payroll/runs', {}, token)
      setRuns(Array.isArray(data) ? data : [])
    } catch { setRuns([]) }
    finally { setRunsLoading(false) }
  }

  async function handleRunPayroll() {
    setRunning(true)
    setError('')
    setResult(null)
    try {
      const payload = { year, month }
      if (department) payload.department = department
      if (companyId) payload.company_id = companyId
      const res = await apiFetch('/api/payroll/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }, token)
      setResult(res)
      loadRuns()
    } catch (err) {
      setError(err.message || 'Payroll run failed')
    } finally {
      setRunning(false)
    }
  }

  async function viewRunPayslips(run) {
    setViewingRun(run)
    setPayslipsLoading(true)
    try {
      const data = await apiFetch(`/api/payroll/payslips?year=${run.year}&month=${run.month}`, {}, token)
      setPayslips(Array.isArray(data) ? data : [])
    } catch { setPayslips([]) }
    finally { setPayslipsLoading(false) }
  }

  function exportPayslipsCSV() {
    if (!payslips.length) return
    const headers = ['Employee', 'Department', 'CTC (Annual)', 'Working Days', 'Present Days', 'LOP Days', 'Gross', 'Deductions', 'Net Salary', 'Status']
    const lines = [
      headers.join(','),
      ...payslips.map(p => [
        `"${p.employee_name || ''}"`,
        `"${p.department || ''}"`,
        p.ctc_annual || 0,
        p.working_days || 0,
        p.present_days || 0,
        p.loss_of_pay_days || 0,
        p.gross_salary || 0,
        p.total_deductions || 0,
        p.net_salary || 0,
        p.status || 'generated',
      ].join(','))
    ]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `payroll_${viewingRun?.year || year}-${String(viewingRun?.month || month).padStart(2,'0')}.csv`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const companyName = useMemo(() => {
    if (!companyId) return 'All Companies'
    const c = companies.find(co => co.id === companyId)
    return c?.name || companyId
  }, [companyId, companies])

  return (
    <div className="bulk-payroll-run">
      <div className="bulk-payroll-header">
        <div>
          <h3>Bulk Payroll Run</h3>
          <p className="muted small">Run monthly payroll for all eligible employees in one click</p>
        </div>
        <button type="button" className="ghost" onClick={loadRuns} disabled={runsLoading}>
          <RefreshCw size={14} className={runsLoading ? 'hrms-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="bulk-payroll-config">
        <div className="bulk-payroll-config-grid">
          <div className="bulk-payroll-field">
            <label><Calendar size={14} /> Month</label>
            <select value={month} onChange={e => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
            </select>
          </div>
          <div className="bulk-payroll-field">
            <label><Calendar size={14} /> Year</label>
            <select value={year} onChange={e => setYear(Number(e.target.value))}>
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map(y => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div className="bulk-payroll-field">
            <label><Users size={14} /> Company</label>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)}>
              <option value="">All Companies</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="bulk-payroll-field">
            <label><Users size={14} /> Department</label>
            <select value={department} onChange={e => setDepartment(e.target.value)}>
              <option value="">All Departments</option>
              {departments.map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        <div className="bulk-payroll-summary-bar">
          <div className="bulk-payroll-stat">
            <Users size={16} />
            <div>
              <strong>{eligibleCount}</strong>
              <span>Eligible Employees</span>
            </div>
          </div>
          <div className="bulk-payroll-stat">
            <Calendar size={16} />
            <div>
              <strong>{MONTHS[month - 1]} {year}</strong>
              <span>Payroll Period</span>
            </div>
          </div>
          <div className="bulk-payroll-stat">
            <IndianRupee size={16} />
            <div>
              <strong>{companyName}</strong>
              <span>Scope</span>
            </div>
          </div>
        </div>

        <div className="bulk-payroll-actions">
          <button
            type="button"
            className="bulk-payroll-run-btn"
            onClick={handleRunPayroll}
            disabled={running || eligibleCount === 0}
          >
            {running ? <Loader2 size={16} className="hrms-spin" /> : <Play size={16} />}
            {running ? 'Processing Payroll...' : `Run Payroll for ${eligibleCount} Employee${eligibleCount !== 1 ? 's' : ''}`}
          </button>
        </div>

        {error && (
          <div className="bulk-payroll-feedback error">
            <AlertCircle size={15} />
            <span>{error}</span>
          </div>
        )}
        {result && (
          <div className="bulk-payroll-feedback success">
            <CheckCircle2 size={15} />
            <div>
              <strong>{result.message}</strong>
              <p className="muted small">
                {result.payslip_count} payslip(s) generated · Total Net: {fmtMoney(result.summary?.total_net)} · Total Gross: {fmtMoney(result.summary?.total_gross)}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="bulk-payroll-history">
        <h4>Payroll Run History</h4>
        {runsLoading && <div className="table-loading-state"><Loader2 size={16} className="hrms-spin" /><p>Loading...</p></div>}
        {!runsLoading && !runs.length && <p className="muted small">No payroll runs found yet.</p>}
        {!runsLoading && runs.length > 0 && (
          <table className="directory-table">
            <thead>
              <tr>
                <th>Period</th>
                <th>Employees</th>
                <th>Total Gross</th>
                <th>Total Deductions</th>
                <th>Total Net</th>
                <th>Status</th>
                <th>Run By</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.slice(0, 20).map((run, idx) => (
                <tr key={run._id || idx}>
                  <td><strong>{MONTHS[(run.month || 1) - 1]} {run.year}</strong></td>
                  <td>{run.employee_count || 0}</td>
                  <td>{fmtMoney(run.total_gross)}</td>
                  <td>{fmtMoney(run.total_deductions)}</td>
                  <td className="text-bold">{fmtMoney(run.total_net)}</td>
                  <td><span className={`task-chip priority ${run.status === 'completed' ? 'low' : 'medium'}`}>{run.status || 'completed'}</span></td>
                  <td>{run.run_by || 'admin'}</td>
                  <td>
                    <button type="button" className="ghost small" onClick={() => viewRunPayslips(run)}>
                      <FileText size={13} /> View Payslips
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {viewingRun && (
        <div className="modal-overlay" onClick={() => { setViewingRun(null); setPayslips([]) }}>
          <div className="modal-card" style={{ maxWidth: 960, maxHeight: '85vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div className="row between">
              <div>
                <h3>Payslips — {MONTHS[(viewingRun.month || 1) - 1]} {viewingRun.year}</h3>
                <p className="muted small">{payslips.length} payslip(s) generated</p>
              </div>
              <div className="row compact">
                <button type="button" className="ghost" onClick={exportPayslipsCSV} disabled={!payslips.length}>
                  <Download size={14} /> Export CSV
                </button>
                <button type="button" className="ghost" onClick={() => { setViewingRun(null); setPayslips([]) }}>Close</button>
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', marginTop: 12 }}>
              {payslipsLoading && <div className="table-loading-state"><Loader2 size={16} className="hrms-spin" /><p>Loading payslips...</p></div>}
              {!payslipsLoading && !payslips.length && <p className="muted">No payslips found for this run.</p>}
              {!payslipsLoading && payslips.length > 0 && (
                <table className="directory-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Department</th>
                      <th>Working Days</th>
                      <th>Present</th>
                      <th>LOP</th>
                      <th>Gross</th>
                      <th>Deductions</th>
                      <th>Net Salary</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payslips.map((p, idx) => (
                      <>
                        <tr key={p._id || idx}>
                          <td><strong>{p.employee_name || '-'}</strong></td>
                          <td>{p.department || 'General'}</td>
                          <td>{p.working_days || 0}</td>
                          <td>{p.present_days || 0}</td>
                          <td className={p.loss_of_pay_days > 0 ? 'text-danger' : ''}>{p.loss_of_pay_days || 0}</td>
                          <td>{fmtMoney(p.gross_salary)}</td>
                          <td>{fmtMoney(p.total_deductions)}</td>
                          <td className="text-bold">{fmtMoney(p.net_salary)}</td>
                          <td>
                            <button type="button" className="ghost small" onClick={() => setExpandedPayslip(expandedPayslip === p._id ? null : p._id)}>
                              <ChevronDown size={13} className={expandedPayslip === p._id ? 'hrms-rotate-180' : ''} />
                            </button>
                          </td>
                        </tr>
                        {expandedPayslip === p._id && (
                          <tr key={`detail-${p._id}`}>
                            <td colSpan={9}>
                              <div className="payslip-detail-expand">
                                <div className="payslip-detail-section">
                                  <h5>Earnings</h5>
                                  {(p.earnings || []).map(e => (
                                    <div key={e.code} className="payslip-detail-row">
                                      <span>{e.name}</span>
                                      <strong>{fmtMoney(e.amount)}</strong>
                                    </div>
                                  ))}
                                </div>
                                <div className="payslip-detail-section">
                                  <h5>Deductions</h5>
                                  {(p.deductions || []).map(d => (
                                    <div key={d.code} className="payslip-detail-row">
                                      <span>{d.name}</span>
                                      <strong className="text-danger">{fmtMoney(d.amount)}</strong>
                                    </div>
                                  ))}
                                  {p.lop_deduction > 0 && (
                                    <div className="payslip-detail-row">
                                      <span>LOP Deduction ({p.loss_of_pay_days} days)</span>
                                      <strong className="text-danger">{fmtMoney(p.lop_deduction)}</strong>
                                    </div>
                                  )}
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
