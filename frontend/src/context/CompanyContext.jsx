import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { apiFetch } from '../api'
import { ADMIN_KEY } from '../config/constants'
import { normalizeCompanyCatalog } from '../utils/companyCatalog'

const CompanyContext = createContext(null)

const STORAGE_KEY = 'hrms_selected_company_id'
const CATALOG_STORAGE_KEY = 'hrms_company_catalog_cache'

export function CompanyProvider({ children }) {
  const [companies, setCompaniesState] = useState(() => {
    try {
      const cached = localStorage.getItem(CATALOG_STORAGE_KEY)
      if (cached) {
        const parsed = JSON.parse(cached)
        if (Array.isArray(parsed) && parsed.length) return normalizeCompanyCatalog(parsed)
      }
    } catch { /* no-op */ }
    return []
  })
  const [selectedCompanyId, setSelectedCompanyId] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || '' } catch { return '' }
  })
  const [loading, setLoading] = useState(false)
  const catalogFetchInFlightRef = useRef(null)

  const setCompanies = useCallback((list) => {
    const normalized = normalizeCompanyCatalog(Array.isArray(list) ? list : [])
    setCompaniesState(normalized)
  }, [])

  const fetchCompanies = useCallback(async (token) => {
    if (!token) return
    if (catalogFetchInFlightRef.current) return catalogFetchInFlightRef.current
    const run = (async () => {
      try {
        const res = await apiFetch('/api/companies', { retries: 0 }, token)
        const raw = res?.companies
        const list = normalizeCompanyCatalog(Array.isArray(raw) ? raw : [])
        setCompaniesState(list)
        try { localStorage.setItem(CATALOG_STORAGE_KEY, JSON.stringify(list)) } catch { /* no-op */ }
        setSelectedCompanyId((currentId) => {
          if (!list.length) return currentId || ''
          const stillValid = list.some((c) => c.id === currentId)
          if (stillValid) return currentId
          const first = list[0]?.id || ''
          try { localStorage.setItem(STORAGE_KEY, first) } catch { /* no-op */ }
          return first
        })
      } catch (err) {
        try {
          // eslint-disable-next-line no-console
          console.warn('[CompanyContext] /api/companies failed', err?.message || err)
        } catch { /* no-op */ }
        // Only fall back to stubs if we don't have any companies loaded yet
        setCompaniesState((prev) => {
          if (prev && prev.length) return prev
          return normalizeCompanyCatalog([])
        })
      } finally {
        setLoading(false)
        catalogFetchInFlightRef.current = null
      }
    })()
    catalogFetchInFlightRef.current = run
    return run
  }, [])

  useEffect(() => {
    try {
      const admin = localStorage.getItem(ADMIN_KEY)
      if (admin) fetchCompanies(admin)
    } catch {
      /* no-op */
    }
  }, [fetchCompanies])

  const selectCompany = useCallback((id) => {
    setSelectedCompanyId(id)
    try { localStorage.setItem(STORAGE_KEY, id) } catch {}
  }, [])

  // Never fall back to companies[0] for scope — that steals tenant when catalog is incomplete (e.g. API error).
  const selectedCompany = companies.find(c => c.id === selectedCompanyId) || null
  // Prefer stored / explicit id for all API calls; only default to first catalog row when nothing selected yet.
  const resolvedSelectedId = selectedCompanyId || companies[0]?.id || ''

  return (
    <CompanyContext.Provider value={{
      companies,
      setCompanies,
      selectedCompanyId: resolvedSelectedId,
      selectedCompany,
      selectCompany,
      fetchCompanies,
      loading,
    }}>
      {children}
    </CompanyContext.Provider>
  )
}

export function useCompany() {
  const ctx = useContext(CompanyContext)
  if (!ctx) throw new Error('useCompany must be used within CompanyProvider')
  return ctx
}

export default CompanyContext
