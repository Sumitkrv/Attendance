export default function SidebarItem({
  icon: Icon,
  label,
  active = false,
  onClick,
  collapsed = false,
  badge = 0,
  child = false,
}) {
  return (
    <button
      type="button"
      className={`sidebar-menu-btn hrms-nav-item ${child ? 'is-child' : ''} ${active ? 'active' : ''} ${collapsed ? 'is-collapsed' : ''}`}
      onClick={onClick}
      title={collapsed ? label : undefined}
    >
      {!!Icon && <Icon size={16} className="hrms-nav-icon" />}
      {!collapsed && <span className="hrms-nav-label">{label}</span>}
      {!collapsed && badge > 0 && <span className="hrms-nav-badge">{badge}</span>}
      {collapsed && <span className="hrms-nav-tooltip">{label}</span>}
    </button>
  )
}
