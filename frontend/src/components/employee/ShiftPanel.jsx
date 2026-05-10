import { useState, useEffect } from 'react'
import { apiFetch } from '../../api'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function getWeekDates() {
  const today = new Date()
  const day = today.getDay()
  const start = new Date(today)
  start.setDate(today.getDate() - day + 1) // Monday
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(start)
    d.setDate(start.getDate() + i)
    return {
      date: d.toISOString().slice(0, 10),
      dayName: DAYS[d.getDay()],
      dayNum: d.getDate(),
      isToday: d.toDateString() === today.toDateString(),
      isWeekend: d.getDay() === 0 || d.getDay() === 6,
    }
  })
}

export default function ShiftPanel({ token }) {
  const [shifts, setShifts] = useState([])
  const [myShift, setMyShift] = useState(null)
  const [loading, setLoading] = useState(true)
  const week = getWeekDates()

  useEffect(() => {
    if (!token) return
    async function load() {
      setLoading(true)
      try {
        const [shiftData, assignData] = await Promise.all([
          apiFetch('/api/shifts', {}, token).catch(() => ({ items: [] })),
          apiFetch('/api/shift-assignments?page=1&per_page=10', {}, token).catch(() => ({ items: [] })),
        ])
        const items = Array.isArray(shiftData?.items) ? shiftData.items : Array.isArray(shiftData) ? shiftData : []
        setShifts(items)
        const assigns = Array.isArray(assignData?.items) ? assignData.items : Array.isArray(assignData) ? assignData : []
        if (assigns.length > 0) setMyShift(assigns[0])
      } catch { /* no-op */ }
      setLoading(false)
    }
    load()
  }, [token])

  const currentShift = myShift?.shift_name || shifts[0]?.name || 'General'
  const shiftStart = myShift?.start_time || shifts[0]?.start_time || '09:00'
  const shiftEnd = myShift?.end_time || shifts[0]?.end_time || '18:00'

  return (
    <div className="emp-panel-card">
      <div className="emp-panel-header">
        <h3 className="emp-panel-title">🕐 My Shift Schedule</h3>
        <span className="emp-shift-badge">{currentShift}</span>
      </div>

      {loading ? (
        <div className="emp-skeleton-block" />
      ) : (
        <>
          <div className="emp-shift-time-row">
            <div className="emp-shift-time-card">
              <span>Start</span>
              <strong>{shiftStart}</strong>
            </div>
            <div className="emp-shift-arrow">→</div>
            <div className="emp-shift-time-card">
              <span>End</span>
              <strong>{shiftEnd}</strong>
            </div>
          </div>

          <div className="emp-week-grid">
            {week.map((d) => (
              <div
                key={d.date}
                className={`emp-week-day ${d.isToday ? 'today' : ''} ${d.isWeekend ? 'weekend' : ''}`}
              >
                <span className="emp-week-day-name">{d.dayName}</span>
                <strong className="emp-week-day-num">{d.dayNum}</strong>
                <span className="emp-week-day-shift">
                  {d.isWeekend ? 'Off' : currentShift}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
