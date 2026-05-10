import { Navigate, useLocation } from 'react-router-dom'
import { readValidToken } from '../../utils/helpers'

export default function RoleRouteGuard({ storageKey, role, children }) {
  const location = useLocation()
  const rawToken = (() => {
    try {
      return localStorage.getItem(storageKey) || ''
    } catch {
      return ''
    }
  })()
  const validToken = readValidToken(storageKey, role)

  // If there's a raw token but it's expired/invalid, clear it
  if (rawToken && !validToken) {
    try {
      localStorage.removeItem(storageKey)
    } catch {
      // no-op
    }
  }

  // BLOCK: If no valid token, redirect to the appropriate login page
  if (!validToken) {
    const loginPath = role === 'admin' ? '/admin' : '/user'
    // Prevent infinite redirect loop if already on the login page
    if (location.pathname === loginPath) {
      return children
    }
    return <Navigate to={loginPath} replace />
  }

  return children
}
