/**
 * Keeps multi-company UI in sync with backend defaults (e.g. "Other Companies").
 * If the API omits a row, we merge it so the switcher and forms still show it.
 */

/**
 * Default company rows kept in sync with backend `_DEFAULT_COMPANIES`.
 * Used as fallback so the switcher works even if /api/companies fails.
 */
export const DEFAULT_COMPANY_ROWS = Object.freeze([
  Object.freeze({ id: 'PR',       name: 'PR Technologies',  companyCode: 'PR',      tagline: 'Primary Company',               color: '#7c3aed' }),
  Object.freeze({ id: 'CD_IT',    name: 'CD_IT',            companyCode: 'CDIT',    tagline: 'Information Technology',         color: '#2563eb' }),
  Object.freeze({ id: 'CD-EV',    name: 'CD-EV',            companyCode: 'CDEV',    tagline: 'Electric Vehicles Division',     color: '#16a34a' }),
  Object.freeze({ id: 'CD-Hydro', name: 'CD-Hydro',         companyCode: 'CDHYD',   tagline: 'Hydro Energy Projects',         color: '#0891b2' }),
  Object.freeze({ id: 'CD-Infra', name: 'CD-Infra',         companyCode: 'CDINFRA', tagline: 'Infrastructure & Construction',  color: '#d97706' }),
  Object.freeze({ id: 'OTHER',    name: 'Other Companies',  companyCode: 'OTHER',   tagline: 'Miscellaneous / cross-unit',     color: '#64748b' }),
])

export const PRIMARY_COMPANY_ROW = DEFAULT_COMPANY_ROWS[0]
export const OTHER_COMPANY_ROW = DEFAULT_COMPANY_ROWS[DEFAULT_COMPANY_ROWS.length - 1]

export function mergeMissingDefaultCompanyRows(companies) {
  const fromApi = Array.isArray(companies) ? [...companies] : []
  for (const row of DEFAULT_COMPANY_ROWS) {
    const rid = row.id.toUpperCase()
    const rcode = row.companyCode.toUpperCase()
    const rname = row.name.toLowerCase()
    const alreadyPresent = fromApi.some((c) => {
      if (!c) return false
      const id = String(c.id || '').toUpperCase()
      const code = String(c.companyCode || '').toUpperCase()
      const name = String(c.name || '').trim().toLowerCase()
      return id === rid || code === rcode || name === rname
    })
    if (!alreadyPresent) {
      fromApi.push({ ...row })
    }
  }
  return fromApi
}

export function sortCompanyCatalogRows(companies) {
  const arr = Array.isArray(companies) ? [...companies] : []
  arr.sort((a, b) => {
    const ida = String(a?.id || '').toUpperCase()
    const idb = String(b?.id || '').toUpperCase()
    if (ida === 'PR' && idb !== 'PR') return -1
    if (idb === 'PR' && ida !== 'PR') return 1
    if (ida === 'OTHER' && idb !== 'OTHER') return 1
    if (idb === 'OTHER' && ida !== 'OTHER') return -1
    return String(a?.name || '').localeCompare(String(b?.name || ''), undefined, { sensitivity: 'base' })
  })
  return arr
}

export function normalizeCompanyCatalog(companies) {
  const fromApi = Array.isArray(companies) ? companies : []
  return sortCompanyCatalogRows(mergeMissingDefaultCompanyRows(fromApi))
}
