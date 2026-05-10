/**
 * Live-cycle payroll projection: earned MTD vs month-end estimates.
 * Per-day rate must come from payrollEngine (gross ÷ payable days).
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * @param {number} perDaySalary — rounded per-day from payroll core
 * @param {number} presentDays
 */
export function computeEarnedTillDate(perDaySalary, presentDays) {
  const pd = r2(Number(perDaySalary) || 0)
  const p = Math.max(0, Number(presentDays) || 0)
  return r2(pd * p)
}

/**
 * Month-end gross after full-cycle LOP (statutory bases use full gross; LOP is separate).
 * @param {number} grossSalary
 * @param {number} lopDeduction
 */
export function computeProjectedGrossAfterLop(grossSalary, lopDeduction) {
  const g = Number(grossSalary) || 0
  const l = Math.max(0, Number(lopDeduction) || 0)
  return Math.max(0, r2(g - l))
}
