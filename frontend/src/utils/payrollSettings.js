/**
 * Company-scoped payroll configuration (merged with API company.payrollSettings).
 */

export const PAYROLL_CALCULATION_MODES = Object.freeze({
  CALENDAR_DAYS: 'calendar_days',
  WORKING_DAYS: 'working_days',
  FIXED_30_DAYS: 'fixed_30_days',
})

export const DEFAULT_PAYROLL_SETTINGS = Object.freeze({
  payrollCycle: 'monthly',
  pfEnabled: true,
  pfPercent: 12,
  tdsEnabled: true,
  esicEnabled: false,
  esicPercent: 0.75,
  salaryPayDate: 'last',
  /** When true, weekend days count toward payable-day denominator (calendar/working modes). */
  includeWeekendsInPayroll: true,
  /** When true, company holidays count toward payable-day denominator. */
  includeHolidaysInPayroll: true,
  /**
   * calendar_days — use month length with optional exclusion of weekends/holidays per flags.
   * working_days — denominator = Mon–Fri-style count: days − weekends − holidays (HRMS “working days”).
   * fixed_30_days — always 30 (common Indian payroll convention).
   */
  payrollCalculationMode: PAYROLL_CALCULATION_MODES.CALENDAR_DAYS,
  /** Per-cycle registry: key "YYYY-MM" → { status, lockedAt?, finalizedAt? } */
  monthlyPayrollRegistry: {},
})

/**
 * @param {Record<string, unknown> | null | undefined} company
 * @returns {typeof DEFAULT_PAYROLL_SETTINGS}
 */
export function mergeCompanyPayrollSettings(company) {
  const raw = company?.payrollSettings
  const patch = raw && typeof raw === 'object' ? raw : {}
  return {
    ...DEFAULT_PAYROLL_SETTINGS,
    ...patch,
    includeWeekendsInPayroll:
      patch.includeWeekendsInPayroll !== undefined
        ? Boolean(patch.includeWeekendsInPayroll)
        : DEFAULT_PAYROLL_SETTINGS.includeWeekendsInPayroll,
    includeHolidaysInPayroll:
      patch.includeHolidaysInPayroll !== undefined
        ? Boolean(patch.includeHolidaysInPayroll)
        : DEFAULT_PAYROLL_SETTINGS.includeHolidaysInPayroll,
    monthlyPayrollRegistry:
      patch.monthlyPayrollRegistry != null && typeof patch.monthlyPayrollRegistry === 'object'
        ? patch.monthlyPayrollRegistry
        : DEFAULT_PAYROLL_SETTINGS.monthlyPayrollRegistry,
  }
}

/**
 * Human-readable label for payroll mode (UI).
 * @param {string} mode
 */
export function payrollModeLabel(mode) {
  const m = String(mode || '').toLowerCase()
  if (m === PAYROLL_CALCULATION_MODES.FIXED_30_DAYS) return 'Fixed 30 days'
  if (m === PAYROLL_CALCULATION_MODES.WORKING_DAYS) return 'Working days (month)'
  if (m === PAYROLL_CALCULATION_MODES.CALENDAR_DAYS) return 'Calendar days'
  return mode || '—'
}
