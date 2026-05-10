/**
 * Main payroll snapshot: calendar divisor, MTD payable units, structure on attendance-earned gross.
 */

import { mergeCompanyPayrollSettings, payrollModeLabel } from './payrollSettings'
import { getDaysInMonth, calculatePayroll } from './payrollUtils'
import { computeSalaryStructureAmounts } from './salaryStructureUtils'
import { resolvePayrollRunContext } from './payrollFinalizationUtils'

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * @param {{
 *  grossSalary: number,
 *  str: Record<string, number>,
 *  att: Record<string, unknown>,
 *  company: Record<string, unknown> | null,
 *  year: number,
 *  month: number,
 *  now?: Date
 * }} input
 */
export function computePayrollSnapshot(input) {
  const { grossSalary, str, att, company, year, month, now = new Date() } = input
  const g = Number(grossSalary) || 0

  const run = resolvePayrollRunContext({ year, month, company, now })
  const payrollSettings = mergeCompanyPayrollSettings(company)

  const calendarDivisor =
    Number(att?.totalDaysInMonth) || Number(att?.totalDays) || getDaysInMonth(year, month)

  const casual = Number(att.casualLeave) || 0
  const sick = Number(att.sickLeave) || 0
  const paidLeaveDays = Number(att.paidLeave) || casual + sick
  const presentDays = Math.max(0, Number(att?.presentDays) || 0)
  const halfDayEarned = (Number(att.halfDays) || 0) * 0.5
  const holidaysPaid = Number(att.paidHolidays) || 0
  const weekoffsInCycle = Number(att.weekoffDays) || Number(att.weekoffDaysTracked) || 0
  const computedPaidUnits = Math.max(
    0,
    presentDays + paidLeaveDays + holidaysPaid + halfDayEarned + weekoffsInCycle,
  )
  const paidDayUnits = Number(att?.paidDays) > 0 ? Number(att.paidDays) : computedPaidUnits

  const lop = Math.max(0, Number(att?.lopDays) || 0)

  const { perDaySalary, lopDeduction, tillDateEarned } = calculatePayroll({
    grossSalary: g,
    totalCalendarDaysInMonth: calendarDivisor,
    payableDayUnits: paidDayUnits,
    lopDays: lop,
  })
  const perDay = perDaySalary
  const lopDed = lopDeduction
  const earnedTillDate = tillDateEarned

  const {
    pfPct = 0,
    tdsPct = 0,
    advanceAmount = 0,
    otherDeductionAmt = 0,
  } = str || {}

  const structure = computeSalaryStructureAmounts(Math.max(0, earnedTillDate), str || {})

  const overtimeHours = Number(att?.overtimeHours) || 0
  const otEarn = r2(Number(att?.overtimeEarnings) || (overtimeHours * (perDay / 9) * 1.5))
  const lateDed = r2(Number(att?.latePenalty) || 0)

  const {
    rounded: {
      basic,
      hra,
      conveyance,
      cca,
      medical,
      positionAllow,
      newsPaper,
      mobileReimb,
      arrear,
      bonus: bonusE,
      otherEarnings: otherE,
    },
    fixedPct,
    pctOk,
  } = structure

  const rawStructure = structure.structureTotalRaw
  const totalEarnings = r2(rawStructure + otEarn)

  const pf = r2(basic * pfPct / 100)
  const tds = r2(totalEarnings * tdsPct / 100)
  const advance = Number(advanceAmount) || 0
  const otherDed = Number(otherDeductionAmt) || 0

  const structuralDeductions = r2(pf + tds + advance + otherDed + lateDed)
  const totalDed = structuralDeductions
  const net = r2(Math.max(0, totalEarnings - totalDed))

  const attendanceWorkingDays =
    Number(att?.attendanceWorkingDays) || Number(att?.workingDays) || 0

  const resolved = paidDayUnits + lop
  const pctFromBackend = Number(att?.attendancePct)
  const attendancePct = Number.isFinite(pctFromBackend) && pctFromBackend >= 0
    ? r2(pctFromBackend)
    : r2(resolved > 0 ? (paidDayUnits / resolved) * 100 : 0)

  const basisFlags =
    `${payrollSettings.payrollCalculationMode}: MTD accrued on gross ÷ ${calendarDivisor} calendar days`

  return {
    ...run,
    payrollBasisLabel: payrollModeLabel(payrollSettings.payrollCalculationMode),
    payrollBasisFlags: basisFlags,
    payableDays: paidDayUnits,
    totalDaysInMonth: calendarDivisor,
    presentDays,
    attendanceWorkingDays,
    paidLeaveDays,
    paidDays: paidDayUnits,
    lop,
    perDay,
    lopDed,
    effGross: earnedTillDate,
    projectedGrossAfterLop: earnedTillDate,
    earnedTillDate,
    fixedPct,
    pctOk,
    earnings: {
      basic,
      hra,
      conveyance,
      cca,
      medical,
      positionAllow,
      newsPaper,
      mobileReimb,
      arrear,
      overtime: otEarn,
      bonus: bonusE,
      otherEarnings: otherE,
    },
    totalEarnings,
    pf,
    tds,
    advance,
    otherDed,
    lateDed,
    structuralDeductions,
    totalDed,
    net,
    netPayable: net,
    attendancePct,
  }
}
