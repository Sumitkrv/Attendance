import { useMemo } from 'react'

export default function ReimbursementsPanel() {
  const reimbursementRows = useMemo(() => (
    [
      { id: 'RB-1042', title: 'Client visit travel', amount: 1250, status: 'Approved', date: '2026-04-18' },
      { id: 'RB-1046', title: 'Team lunch', amount: 860, status: 'Pending', date: '2026-04-22' },
      { id: 'RB-1049', title: 'Internet reimbursement', amount: 1500, status: 'Paid', date: '2026-04-28' },
    ]
  ), [])

  return (
    <section className="employee-module-shell">
      <div className="employee-module-grid">
        <article className="card employee-module-card">
          <p className="muted small">Total Claims</p>
          <h3>{reimbursementRows.length}</h3>
          <p className="muted small">Last 30 days</p>
        </article>
        <article className="card employee-module-card">
          <p className="muted small">Pending Claims</p>
          <h3>{reimbursementRows.filter((row) => row.status === 'Pending').length}</h3>
          <p className="muted small">Awaiting approval</p>
        </article>
        <article className="card employee-module-card">
          <p className="muted small">Total Amount</p>
          <h3>₹{reimbursementRows.reduce((sum, row) => sum + row.amount, 0).toLocaleString()}</h3>
          <p className="muted small">Claimed</p>
        </article>
      </div>

      <article className="card employee-module-card">
        <div className="row between" style={{ marginBottom: 12 }}>
          <h4 style={{ margin: 0 }}>Recent Claims</h4>
          <button type="button" className="ghost">New Claim</button>
        </div>
        <div className="employee-performance-table-wrap">
          <table className="employee-performance-table">
            <thead>
              <tr>
                <th>Claim ID</th>
                <th>Title</th>
                <th>Date</th>
                <th>Amount</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {reimbursementRows.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.title}</td>
                  <td>{row.date}</td>
                  <td>₹{row.amount.toLocaleString()}</td>
                  <td>{row.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  )
}
