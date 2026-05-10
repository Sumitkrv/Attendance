import { ChevronDown } from 'lucide-react'

export default function SidebarSection({
  icon: Icon,
  label,
  sectionId,
  expanded,
  onToggle,
  collapsed = false,
  active = false,
  children,
}) {
  return (
    <div className={`hrms-nav-section hrms-accordion ${active ? 'active' : ''} ${expanded ? 'expanded' : ''}`}>
      <button
        type="button"
        className={`sidebar-menu-btn hrms-parent-item ${active ? 'active' : ''}`}
        onClick={() => onToggle(sectionId)}
        title={collapsed ? label : undefined}
      >
        {!!Icon && <Icon size={16} className="hrms-nav-icon" />}
        {!collapsed && <span className="hrms-nav-label">{label}</span>}
        {!collapsed && <ChevronDown className="hrms-nav-caret" size={14} />}
        {collapsed && <span className="hrms-nav-tooltip">{label}</span>}
      </button>
      <div className={`hrms-submenu ${expanded && !collapsed ? 'open' : ''}`}>{children}</div>
    </div>
  )
}
