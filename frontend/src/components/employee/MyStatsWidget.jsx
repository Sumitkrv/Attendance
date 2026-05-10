import { useState, useEffect } from 'react'
import { apiFetch } from '../../api'

export default function MyStatsWidget({ token, employeeId }) {
  const [stats, setStats] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    async function load() {
      setLoading(true)
      try {
        const id = employeeId || 'me'
        const data = await apiFetch(`/api/analytics/employee-performance?employee_id=${id}`, {}, token)
        setStats(data)
      } catch { /* no-op */ }
      setLoading(false)
    }
    load()
  }, [token, employeeId])

  if (loading) return <div className="emp-panel-card"><div className="emp-skeleton-block" /></div>
  if (!stats) return null

  const att = stats.attendance || {}
  const tasks = stats.tasks || {}
  const hours = stats.working_hours || {}

  const items = [
    { label: 'Attendance', value: `${att.attendance_rate || 0}%`, color: '#3b82f6', icon: '📊' },
    { label: 'Punctuality', value: `${att.punctuality_rate || 0}%`, color: '#22c55e', icon: '⏰' },
    { label: 'Tasks Done', value: `${tasks.completed || 0}/${tasks.total || 0}`, color: '#8b5cf6', icon: '✅' },
    { label: 'Avg Hours', value: `${hours.average_daily || 0}h`, color: '#f59e0b', icon: '🕐' },
  ]

  return (
    <div className="emp-panel-card">
      <h3 className="emp-panel-title">📈 My Performance</h3>
      <div className="emp-perf-grid">
        {items.map((item) => (
          <div key={item.label} className="emp-perf-card" style={{ '--perf-color': item.color }}>
            <span className="emp-perf-icon">{item.icon}</span>
            <strong className="emp-perf-value">{item.value}</strong>
            <span className="emp-perf-label">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
