// ==========================================================================
// Item 3: React Query — server state + caching layer
// Provides automatic caching, background refetching, deduplication,
// and stale-while-revalidate patterns for all API calls.
// ==========================================================================
import { QueryClient, QueryClientProvider, useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '../api'
import { BASE_URL } from '../config/apiConfig'
import { ADMIN_KEY } from '../config/constants'

// ---------- Query Client (singleton) ----------
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30 * 1000,       // Data is fresh for 30s
      gcTime: 5 * 60 * 1000,      // Cache lives for 5 min
      retry: 1,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
    },
    mutations: {
      retry: 0,
    },
  },
})

export { QueryClientProvider }

// ---------- Shared fetch helper ----------
function adminFetch(path, options = {}) {
  return apiFetch(path, {
    tokenKey: ADMIN_KEY,
    ...options,
  })
}

// ---------- Dashboard ----------
export function useDashboardSummary(date) {
  return useQuery({
    queryKey: ['dashboard', 'summary', date],
    queryFn: () => adminFetch(`/api/dashboard/summary${date ? `?date=${date}` : ''}`),
    staleTime: 20 * 1000,
  })
}

// ---------- Employees ----------
export function useEmployees() {
  return useQuery({
    queryKey: ['employees'],
    queryFn: () => adminFetch('/employees'),
  })
}

export function useEmployee(id) {
  return useQuery({
    queryKey: ['employees', id],
    queryFn: () => adminFetch(`/api/employees/${id}`),
    enabled: Boolean(id),
  })
}

export function useCreateEmployee() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data) => adminFetch('/register_employee', {
      method: 'POST',
      body: data instanceof FormData ? data : JSON.stringify(data),
      headers: data instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

export function useUpdateEmployee() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }) => adminFetch(`/employees/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] })
    },
  })
}

export function useDeleteEmployee() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id) => adminFetch(`/employees/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employees'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })
}

// ---------- Attendance ----------
export function useAttendance(date) {
  return useQuery({
    queryKey: ['attendance', date],
    queryFn: () => adminFetch(`/attendance${date ? `?date=${date}` : ''}`),
    staleTime: 15 * 1000,
  })
}

export function useAttendanceAnalytics(params = {}) {
  const search = new URLSearchParams(params).toString()
  return useQuery({
    queryKey: ['attendance', 'analytics', params],
    queryFn: () => adminFetch(`/api/analytics/attendance?${search}`),
    staleTime: 60 * 1000,
  })
}

// ---------- Tasks ----------
export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => adminFetch('/tasks'),
  })
}

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (data) => adminFetch('/tasks', {
      method: 'POST',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

export function useUpdateTaskStatus() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ taskId, data }) => adminFetch(`/tasks/${taskId}/status`, {
      method: 'PATCH',
      body: JSON.stringify(data),
      headers: { 'Content-Type': 'application/json' },
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
    },
  })
}

// ---------- Leave Requests ----------
export function useLeaveRequests() {
  return useQuery({
    queryKey: ['leaveRequests'],
    queryFn: () => adminFetch('/api/leave_requests'),
  })
}

// ---------- Manual Requests ----------
export function useManualRequests() {
  return useQuery({
    queryKey: ['manualRequests'],
    queryFn: () => adminFetch('/manual_requests'),
  })
}

// ---------- Notifications ----------
export function useNotifications() {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => adminFetch('/api/notifications'),
    staleTime: 10 * 1000,
    refetchInterval: 30 * 1000,
  })
}

// ---------- Training Status ----------
export function useTrainStatus() {
  return useQuery({
    queryKey: ['trainStatus'],
    queryFn: () => adminFetch('/train_model/status'),
    staleTime: 5 * 1000,
  })
}

// ---------- Settings ----------
export function useGeofenceSettings() {
  return useQuery({
    queryKey: ['settings', 'geofence'],
    queryFn: () => adminFetch('/geofence_settings'),
  })
}

export function useRecognitionSettings() {
  return useQuery({
    queryKey: ['settings', 'recognition'],
    queryFn: () => adminFetch('/recognition_settings'),
  })
}

// ---------- Reports ----------
export function useReportsAttendance(params = {}) {
  const search = new URLSearchParams(params).toString()
  return useQuery({
    queryKey: ['reports', 'attendance', params],
    queryFn: () => adminFetch(`/api/reports/attendance?${search}`),
    staleTime: 2 * 60 * 1000,
    enabled: Boolean(params.from_date && params.to_date),
  })
}

// ---------- Alerts ----------
export function useAlerts(date) {
  return useQuery({
    queryKey: ['alerts', date],
    queryFn: () => adminFetch(`/api/alerts${date ? `?date=${date}` : ''}`),
    staleTime: 30 * 1000,
  })
}

// ---------- Audit Logs ----------
export function useAuditLogs(limit = 50) {
  return useQuery({
    queryKey: ['auditLogs', limit],
    queryFn: () => adminFetch(`/audit_logs?limit=${limit}`),
    staleTime: 30 * 1000,
  })
}
