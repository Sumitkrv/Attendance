// ==========================================================================
// Item 2: Zustand Auth Store — centralized auth state management
// Replaces scattered localStorage reads/writes across components.
// ==========================================================================
import { create } from 'zustand'
import { ADMIN_KEY, USER_KEY } from '../config/constants'
import { readValidToken, decodeToken, tokenRemainingMs } from '../utils/helpers'

/**
 * Auth store for admin session.
 * Provides a single source of truth for the admin token, decoded claims,
 * and login/logout actions. Replaces scattered localStorage + useState usage.
 */
export const useAdminAuthStore = create((set, get) => ({
  token: readValidToken(ADMIN_KEY, 'admin'),
  claims: null,
  username: 'admin',
  isAuthenticated: false,
  sessionExpiringSoon: false,

  _init() {
    const token = readValidToken(ADMIN_KEY, 'admin')
    if (token) {
      const claims = decodeToken(token)
      set({
        token,
        claims,
        username: claims?.sub || 'admin',
        isAuthenticated: true,
        sessionExpiringSoon: (tokenRemainingMs(token) || Infinity) < 5 * 60 * 1000,
      })
    }
  },

  login(token) {
    try {
      localStorage.setItem(ADMIN_KEY, token)
    } catch { /* no-op */ }
    const claims = decodeToken(token)
    set({
      token,
      claims,
      username: claims?.sub || 'admin',
      isAuthenticated: true,
      sessionExpiringSoon: false,
    })
  },

  logout() {
    try {
      localStorage.removeItem(ADMIN_KEY)
    } catch { /* no-op */ }
    set({
      token: null,
      claims: null,
      username: 'admin',
      isAuthenticated: false,
      sessionExpiringSoon: false,
    })
  },

  refreshToken(newToken) {
    try {
      localStorage.setItem(ADMIN_KEY, newToken)
    } catch { /* no-op */ }
    const claims = decodeToken(newToken)
    set({
      token: newToken,
      claims,
      sessionExpiringSoon: false,
    })
  },

  checkExpiry() {
    const { token } = get()
    if (!token) return
    const remaining = tokenRemainingMs(token) || Infinity
    if (remaining <= 0) {
      get().logout()
    } else if (remaining < 5 * 60 * 1000) {
      set({ sessionExpiringSoon: true })
    }
  },
}))

/**
 * Auth store for user (employee) session.
 */
export const useUserAuthStore = create((set, get) => ({
  token: readValidToken(USER_KEY, 'user'),
  claims: null,
  employee: null,
  isAuthenticated: false,
  mustChangePassword: false,

  login(token, employee) {
    try {
      localStorage.setItem(USER_KEY, token)
    } catch { /* no-op */ }
    const claims = decodeToken(token)
    set({
      token,
      claims,
      employee: employee || null,
      isAuthenticated: true,
      mustChangePassword: Boolean(employee?.must_change_password || claims?.must_change_password),
    })
  },

  logout() {
    try {
      localStorage.removeItem(USER_KEY)
    } catch { /* no-op */ }
    set({
      token: null,
      claims: null,
      employee: null,
      isAuthenticated: false,
      mustChangePassword: false,
    })
  },

  refreshToken(newToken) {
    try {
      localStorage.setItem(USER_KEY, newToken)
    } catch { /* no-op */ }
    set({ token: newToken, claims: decodeToken(newToken) })
  },

  updateEmployee(employee) {
    set({
      employee,
      mustChangePassword: Boolean(employee?.must_change_password),
    })
  },
}))
