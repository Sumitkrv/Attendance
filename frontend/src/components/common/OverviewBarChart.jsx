import { BarChart3 } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import EmptyState from './EmptyState'

export default function OverviewBarChart({ items = [] }) {
  const safeItems = Array.isArray(items) ? items : []
  const hasAnyData = safeItems.some((row) => Number(row?.present || 0) > 0 || Number(row?.absent || 0) > 0)

  if (!hasAnyData) {
    return (
      <div className="hrms-chart-empty-state" role="status" aria-live="polite">
        <EmptyState icon={BarChart3} message="No attendance data available" />
      </div>
    )
  }

  return (
    <div className="hrms-chart-bars" role="img" aria-label="Weekly Attendance Trend Chart">
      <ResponsiveContainer width="100%" height={280}>
        <BarChart data={safeItems} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148, 163, 184, 0.35)" />
          <XAxis dataKey="label" tickLine={false} axisLine={false} />
          <YAxis allowDecimals={false} tickLine={false} axisLine={false} width={28} />
          <Tooltip
            cursor={{ fill: 'rgba(59, 130, 246, 0.06)' }}
            formatter={(value, key) => [value, key === 'present' ? 'Present' : 'Absent']}
            contentStyle={{ borderRadius: 10, borderColor: '#e2e8f0' }}
          />
          <Legend verticalAlign="top" align="right" height={24} />
          <Bar dataKey="present" name="Present" fill="#10b981" radius={[6, 6, 0, 0]} maxBarSize={26} />
          <Bar dataKey="absent" name="Absent" fill="#f97316" radius={[6, 6, 0, 0]} maxBarSize={26} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
