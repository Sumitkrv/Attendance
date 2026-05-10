import { useState, useEffect } from 'react'
import { apiFetch } from '../../api'

export default function HolidayWidget({ token }) {
  const [holidays, setHolidays] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    if (!token) return
    async function load() {
      setLoading(true)
      try {
        const year = new Date().getFullYear()
        const data = await apiFetch(`/api/holidays?year=${year}`, {}, token)
        const list = Array.isArray(data?.holidays) ? data.holidays : Array.isArray(data) ? data : []
        // Show only upcoming
        const today = new Date().toISOString().slice(0, 10)
        setHolidays(list.filter((h) => (h.date || '') >= today).slice(0, 5))
      } catch { /* no-op */ }
      setLoading(false)
    }
    load()
  }, [token])

  if (loading) return <div className="emp-panel-card"><div className="emp-skeleton-block" style={{ height: 60 }} /></div>
  if (!holidays.length) return null

  return (
    <div className="emp-panel-card">
      <h3 className="emp-panel-title">🎉 Upcoming Holidays</h3>
      <div className="emp-holiday-list">
        {holidays.map((h, i) => {
          const d = new Date(h.date + 'T00:00:00')
          const dayName = d.toLocaleDateString('en-US', { weekday: 'short' })
          const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          return (
            <div key={h.date || i} className="emp-holiday-row">
              <div className="emp-holiday-date-box">
                <span className="emp-holiday-day">{dayName}</span>
                <strong className="emp-holiday-monthday">{monthDay}</strong>
              </div>
              <div className="emp-holiday-info">
                <strong>{h.name || 'Holiday'}</strong>
                {h.type && <span className="emp-holiday-type">{h.type}</span>}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
