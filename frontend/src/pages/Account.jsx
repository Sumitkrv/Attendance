import { NavLink } from 'react-router-dom'
import { User, KeyRound, Shield } from 'lucide-react'
import Profile from '../components/account/Profile'
import ChangePassword from '../components/account/ChangePassword'
import Security from '../components/account/Security'

const NAV = [
  { to: '/account/profile', label: 'Profile', icon: User },
  { to: '/account/change-password', label: 'Password', icon: KeyRound },
  { to: '/account/security', label: 'Security', icon: Shield },
]

export default function AccountPage({ token, section = 'profile', onProfileNameUpdated, onAdminTokenRefresh, onFlash }) {
  const active = String(section || 'profile').toLowerCase()

  return (
    <div className="hrms-account-shell">
      <div className="hrms-account-layout">
        <nav className="hrms-account-nav" aria-label="Account settings">
          <p className="hrms-account-nav-label">Account center</p>
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `hrms-account-nav-link${isActive ? ' active' : ''}`
              }
              end={to === '/account/profile'}
            >
              <Icon className="hrms-account-nav-icon" size={18} strokeWidth={1.85} aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>

        <div className="hrms-account-main">
          {active === 'profile' && (
            <Profile token={token} onProfileNameUpdated={onProfileNameUpdated} onFlash={onFlash} />
          )}
          {active === 'change-password' && (
            <ChangePassword token={token} onTokenRefresh={onAdminTokenRefresh} onFlash={onFlash} />
          )}
          {active === 'security' && <Security token={token} onFlash={onFlash} />}
        </div>
      </div>
    </div>
  )
}
