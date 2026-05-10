import { useState, useEffect } from 'react'
import { apiFetch } from '../../api'

export default function PayslipPanel({ token, employeeId }) {
  const [structure, setStructure] = useState(null)
  const [payslips, setPayslips] = useState([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!token) return
    async function load() {
      setLoading(true)
      try {
        const id = employeeId || 'me'
        const [struc, slips] = await Promise.all([
          apiFetch(`/api/payroll/employee/${id}/structure`, {}, token).catch(() => null),
          apiFetch('/api/payroll/payslips?page=1&per_page=3', {}, token).catch(() => ({ items: [] })),
        ])
        if (struc) setStructure(struc)
        const items = Array.isArray(slips?.items) ? slips.items : Array.isArray(slips) ? slips.slice(0, 3) : []
        setPayslips(items)
      } catch { /* no-op */ }
      setLoading(false)
    }
    load()
  }, [token, employeeId])

  const fmt = (n) => {
    const v = Number(n || 0)
    return v >= 100000 ? `₹${(v / 100000).toFixed(1)}L` : `₹${v.toLocaleString('en-IN')}`
  }

  return (
    <div className="emp-panel-card">
      <div className="emp-panel-header">
        <h3 className="emp-panel-title">💰 Salary & Payslips</h3>
        {structure && (
          <button className="emp-small-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? 'Collapse' : 'Details'}
          </button>
        )}
      </div>

      {loading ? (
        <div className="emp-skeleton-block" />
      ) : structure ? (
        <>
          <div className="emp-pay-summary">
            <div className="emp-pay-card gross">
              <span>Gross</span>
              <strong>{fmt(structure.gross || structure.total_earnings)}</strong>
            </div>
            <div className="emp-pay-card deductions">
              <span>Deductions</span>
              <strong>{fmt(structure.total_deductions)}</strong>
            </div>
            <div className="emp-pay-card net">
              <span>Net Pay</span>
              <strong>{fmt(structure.net_salary || structure.net)}</strong>
            </div>
          </div>

          {expanded && (
            <div className="emp-pay-details">
              <div className="emp-pay-col">
                <h4 className="emp-pay-col-title earn">Earnings</h4>
                {Object.entries(structure.earnings || {}).map(([k, v]) => (
                  <div key={k} className="emp-pay-line">
                    <span>{k.replace(/_/g, ' ')}</span>
                    <span>{fmt(v)}</span>
                  </div>
                ))}
              </div>
              <div className="emp-pay-col">
                <h4 className="emp-pay-col-title ded">Deductions</h4>
                {Object.entries(structure.deductions || {}).map(([k, v]) => (
                  <div key={k} className="emp-pay-line">
                    <span>{k.replace(/_/g, ' ')}</span>
                    <span>-{fmt(v)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {payslips.length > 0 && (
            <div className="emp-payslip-list">
              <h4>Recent Payslips</h4>
              {payslips.map((p, i) => (
                <div key={p._id || i} className="emp-payslip-row">
                  <span>{p.month}/{p.year}</span>
                  <span>{fmt(p.net_salary || p.net)}</span>
                  <span className={`emp-payslip-status ${p.status || 'generated'}`}>{p.status || 'generated'}</span>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="emp-empty-text">Salary structure not configured yet.</p>
      )}
    </div>
  )
}
