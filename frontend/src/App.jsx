import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { ADMIN_KEY, USER_KEY } from './config/constants'
import RoleRouteGuard from './components/auth/RoleRouteGuard'

// ---------- Item 1: React.lazy + Suspense for code splitting ----------
// Heavy pages are loaded on-demand, reducing initial bundle size significantly.
const AdminPage = lazy(() => import('./pages/AdminPage'))
const UserPage = lazy(() => import('./pages/UserPage'))

function PageLoader() {
  return (
    <div className="page-loader-container" style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'var(--bg-primary, #f4f7fe)',
      fontFamily: 'Inter, system-ui, sans-serif',
    }}>
      <div style={{ textAlign: 'center' }}>
        <div className="page-loader-spinner" style={{
          width: 40, height: 40, margin: '0 auto 16px',
          border: '3px solid #e2e8f0',
          borderTopColor: '#4f6ef7',
          borderRadius: '50%',
          animation: 'spin 0.8s linear infinite',
        }} />
        <p style={{ color: '#64748b', fontSize: 14 }}>Loading workspace…</p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  )
}

function AdminGuard({ children }) {
  return (
    <RoleRouteGuard storageKey={ADMIN_KEY} role="admin">
      {children}
    </RoleRouteGuard>
  )
}

export default function App() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/" element={<Navigate to="/admin" replace />} />
        <Route
          path="/admin"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/admin/assets"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/admin/tasks"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/employees"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
          <Route
            path="/admin/employee-payroll"
            element={(
              <AdminGuard><AdminPage /></AdminGuard>
            )}
          />
        <Route
          path="/admin/employees/add"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/admin/settings/company"
          element={<AdminGuard><Navigate to="/admin/settings/general" replace /></AdminGuard>}
        />
        <Route
          path="/admin/settings/general"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/employees/:employeeId"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/account/profile"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/account/change-password"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/account/security"
          element={<AdminGuard><AdminPage /></AdminGuard>}
        />
        <Route
          path="/user"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/dashboard"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/attendance"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/leave"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/payroll"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/reimbursements"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/performance"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/team-directory"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/holidays"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/assets"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/profile"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/support"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route
          path="/user/notifications"
          element={(
            <RoleRouteGuard storageKey={USER_KEY} role="user">
              <UserPage />
            </RoleRouteGuard>
          )}
        />
        <Route path="*" element={<Navigate to="/admin" replace />} />
      </Routes>
    </Suspense>
  )
}
