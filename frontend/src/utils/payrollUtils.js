import { PAYROLL_CALCULATION_MODES } from './payrollSettings'

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

export function getDaysInMonth(year, month) {
  return new Date(year, month, 0).getDate()
}

export function countSundays(year, month) {
  let c = 0
  const days = getDaysInMonth(year, month)
  for (let d = 1; d <= days; d++) {
    if (new Date(year, month - 1, d).getDay() === 0) c++
  }
  return c
}

export function countSaturdays(year, month) {
  let c = 0
  const days = getDaysInMonth(year, month)
  for (let d = 1; d <= days; d++) {
    if (new Date(year, month - 1, d).getDay() === 6) c++
  }
  return c
}

/**
 * @param {unknown} holidays — company.holidays array from API
 * @param {number} year
 * @param {number} month 1–12
 */
export function countHolidaysInMonth(holidays, year, month) {
  if (!Array.isArray(holidays)) return 0
  const ym = `${year}-${String(month).padStart(2, '0')}`
  let n = 0
  for (const h of holidays) {
    const d = h && typeof h === 'object' ? h.date : h
    if (d == null) continue
    const s = String(d).slice(0, 7)
    if (s === ym) n++
  }
  return n
}

/**
 * Payable days in the payroll cycle (denominator for per-day salary).
 * Must NOT use attendance-period “working days” (MTD); use full-month calendar composition
 * plus company payroll rules.
 *
 * @param {ReturnType<import('./payrollSettings').mergeCompanyPayrollSettings>} settings
 * @param {{ totalDaysInMonth: number, sundayCount: number, saturdayCount: number, holidayCount: number }} fullMonth
 */
export function resolvePayableDays(settings, fullMonth) {
  const mode = String(settings.payrollCalculationMode || PAYROLL_CALCULATION_MODES.FIXED_30_DAYS).toLowerCase()
  const includeW = settings.includeWeekendsInPayroll !== false
  const includeH = settings.includeHolidaysInPayroll !== false

  const total = Math.max(1, Number(fullMonth.totalDaysInMonth) || 1)
  const sun = Math.max(0, Number(fullMonth.sundayCount) || 0)
  const sat = Math.max(0, Number(fullMonth.saturdayCount) || 0)
  const hol = Math.max(0, Number(fullMonth.holidayCount) || 0)

  if (mode === PAYROLL_CALCULATION_MODES.FIXED_30_DAYS) {
    return 30
  }

  if (mode === PAYROLL_CALCULATION_MODES.WORKING_DAYS) {
    let p = total - sun - sat - hol
    return Math.max(1, p)
  }

  // calendar_days
  let p = total
  if (!includeW) p -= sun + sat
  if (!includeH) p -= hol
  return Math.max(1, p)
}

/**
 * Core HRMS-style payroll slice (LOP from daily rate × LOP days).
 *
 * @param {{ grossSalary: number, payableDays: number, lopDays: number }} input
 * @returns {{ perDaySalary: number, lopDeduction: number, effectiveGross: number, netPayable: number }}
 */
export function calculatePayroll({ grossSalary, payableDays, lopDays }) {
  const g = Number(grossSalary) || 0
  const pd = Math.max(1, Number(payableDays) || 1)
  const lop = Math.max(0, Number(lopDays) || 0)
  const perDaySalary = r2(g / pd)
  const lopDeduction = r2(perDaySalary * lop)
  const effectiveGross = Math.max(0, r2(g - lopDeduction))
  return {
    perDaySalary,
    lopDeduction,
    effectiveGross,
    /** Bank-style take-home before statutory splits is layered on in the UI. */
    netPayable: effectiveGross,
  }
}
