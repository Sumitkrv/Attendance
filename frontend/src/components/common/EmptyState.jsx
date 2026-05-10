import { Activity } from 'lucide-react'

export default function EmptyState({ icon: Icon = Activity, message = 'No data available right now', detail = '' }) {
  return (
    <div className="hrms-empty-state" role="status" aria-live="polite">
      <div className="hrms-empty-state-icon" aria-hidden="true"><Icon size={18} /></div>
      <p className="hrms-empty-state-message">{message}</p>
      {!!detail && <p className="hrms-empty-state-detail muted small">{detail}</p>}
    </div>
  )
}
