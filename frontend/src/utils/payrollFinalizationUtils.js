/**
 * Company-scoped payroll cycle status + finalized vs live UI mode.
 */

import { mergeCompanyPayrollSettings } from './payrollSettings'

export const PAYROLL_STATUSES = Object.freeze({
  DRAFT: 'draft',
  RUNNING: 'running',
  FINALIZED: 'finalized',
  LOCKED: 'locked',
  PAID: 'paid',
})

export function monthRegistryKey(year, month) {
  return `${Number(year)}-${String(Number(month)).padStart(2, '0')}`
}

/**
 * @param {ReturnType<typeof mergeCompanyPayrollSettings>} payrollSettingsMerged
 */
export function getMonthlyPayrollRecord(payrollSettingsMerged, year, month) {
  const reg = payrollSettingsMerged?.monthlyPayrollRegistry
  if (!reg || typeof reg !== 'object') return null
  const key = monthRegistryKey(year, month)
  const rec = reg[key]
  return rec && typeof rec === 'object' ? rec : null
}

/**
 * @returns {{ uiMode: 'live' | 'finalized', readOnly: boolean, record: object | null, payrollStatus: string, monthKey: string }}
 */
export function resolvePayrollRunContext({ year, month, company, now = new Date() }) {
  const y = Number(year)
  const m = Number(month)
  const payrollSettingsMerged = mergeCompanyPayrollSettings(company)
  const record = getMonthlyPayrollRecord(payrollSettingsMerged, y, m)
  const st = String(record?.status || '').toLowerCase()

  const cy = now.getFullYear()
  const cm = now.getMonth() + 1
  const monthKey = monthRegistryKey(y, m)

  const isPastMonth = y < cy || (y === cy && m < cm)
  const isCurrentMonth = y === cy && m === cm
  const isFutureMonth = y > cy || (y === cy && m > cm)

  const isHardLocked = st === PAYROLL_STATUSES.LOCKED || st === PAYROLL_STATUSES.PAID

  let payrollStatus = st || PAYROLL_STATUSES.RUNNING
  if (!st) {
    if (isFutureMonth) payrollStatus = PAYROLL_STATUSES.DRAFT
    else if (isCurrentMonth) payrollStatus = PAYROLL_STATUSES.RUNNING
    else payrollStatus = PAYROLL_STATUSES.FINALIZED
  }

  let uiMode = 'live'
  let readOnly = false

  if (isHardLocked) {
    uiMode = 'finalized'
    readOnly = true
  } else if (st === PAYROLL_STATUSES.FINALIZED) {
    uiMode = 'finalized'
    readOnly = true
  } else if (isPastMonth) {
    if (st === PAYROLL_STATUSES.RUNNING || st === PAYROLL_STATUSES.DRAFT) {
      uiMode = 'live'
      readOnly = false
    } else {
      uiMode = 'finalized'
      readOnly = true
    }
  } else if (isCurrentMonth) {
    uiMode = 'live'
    readOnly = false
  } else {
    uiMode = 'live'
    readOnly = false
  }

  return { uiMode, readOnly, record, payrollStatus, monthKey, isPastMonth, isCurrentMonth, isFutureMonth }
}

export function payrollStatusLabel(status) {
  const s = String(status || '').toLowerCase()
  if (s === PAYROLL_STATUSES.DRAFT) return 'Draft'
  if (s === PAYROLL_STATUSES.RUNNING) return 'Running'
  if (s === PAYROLL_STATUSES.FINALIZED) return 'Finalized'
  if (s === PAYROLL_STATUSES.LOCKED) return 'Locked'
  if (s === PAYROLL_STATUSES.PAID) return 'Paid'
  return status || '—'
}
