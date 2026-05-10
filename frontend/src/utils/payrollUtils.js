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
 * Historical: resolved “cycle” days used in old fixed-30 / divisor rules.
 * Payroll per-day rate always uses calendar month length elsewhere; retained for tooling only.
 *
 * @param {ReturnType<import('./payrollSettings').mergeCompanyPayrollSettings>} settings
 * @param {{ totalDaysInMonth: number, sundayCount: number, saturdayCount: number, holidayCount: number }} fullMonth
 */
export function resolvePayableDays(settings, fullMonth) {
  const mode = String(settings.payrollCalculationMode || PAYROLL_CALCULATION_MODES.CALENDAR_DAYS).toLowerCase()
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
 * Calendar payroll slice: per-day = gross ÷ calendar days in month;
 * till-date earnings = per-day × payableDayUnits (present + leaves + holidays + weekends in elapsed window).
 * LOP ₹ = per-day × lopDays (shown separately — do not subtract again from earnings built from payable units).
 *
 * @param {{ grossSalary: number, totalCalendarDaysInMonth: number, payableDayUnits: number, lopDays: number }} input
 */
export function calculatePayroll({ grossSalary, totalCalendarDaysInMonth, payableDayUnits, lopDays }) {
  const g = Number(grossSalary) || 0
  const cal = Math.max(1, Number(totalCalendarDaysInMonth) || 1)
  const payable = Math.max(0, Number(payableDayUnits) || 0)
  const lop = Math.max(0, Number(lopDays) || 0)
  const perDaySalary = r2(g / cal)
  const tillDateEarned = r2(perDaySalary * payable)
  const lopDeduction = r2(perDaySalary * lop)
  const effectiveGross = Math.max(0, tillDateEarned)
  return {
    perDaySalary,
    lopDeduction,
    effectiveGross,
    tillDateEarned,
    netPayable: effectiveGross,
  }
}
