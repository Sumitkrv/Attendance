/**
 * Payroll projection helpers (per-day wage from payrollUtils.calculatePayroll).
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * Till-date accrued earnings from payable day-units × calendar per-day wage.
 */
export function computeEarnedTillDate(perDaySalary, payableDayUnits) {
  const pd = r2(Number(perDaySalary) || 0)
  const units = Math.max(0, Number(payableDayUnits) || 0)
  return r2(pd * units)
}

/**
 * Full-cycle gross after carving out LOP rupees only when both numbers refer to the same horizon.
 */
export function computeProjectedGrossAfterLop(grossSalary, lopDeduction) {
  const g = Number(grossSalary) || 0
  const l = Math.max(0, Number(lopDeduction) || 0)
  return Math.max(0, r2(g - l))
}
