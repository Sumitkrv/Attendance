import { ChevronLeft, ChevronRight } from 'lucide-react'

export default function SidebarToggle({ collapsed, onToggle }) {
  return (
    <button
      type="button"
      className="hrms-collapse-btn"
      onClick={onToggle}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {collapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
    </button>
  )
}
