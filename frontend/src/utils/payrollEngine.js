/**
 * Main payroll snapshot: divisor rules, LOP, structure on gross, live vs finalized context.
 */

import { mergeCompanyPayrollSettings, payrollModeLabel } from './payrollSettings'
import { getDaysInMonth, resolvePayableDays, calculatePayroll } from './payrollUtils'
import { computeSalaryStructureAmounts } from './salaryStructureUtils'
import { computeEarnedTillDate, computeProjectedGrossAfterLop } from './payrollProjectionUtils'
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

  const totalDaysInMonth =
    Number(att?.totalDaysInMonth) || Number(att?.totalDays) || getDaysInMonth(year, month)
  const sundayCount = Number(att?.sundays) || 0
  const saturdayCount = Number(att?.saturdays) || 0
  const holidayCount = Number(att?.holidaysFullMonth) || 0

  const payableDays = resolvePayableDays(payrollSettings, {
    totalDaysInMonth,
    sundayCount,
    saturdayCount,
    holidayCount,
  })

  const lop = Math.max(0, Number(att?.lopDays) || 0)
  const presentDays = Math.max(0, Number(att?.presentDays) || 0)

  const { perDaySalary, lopDeduction } = calculatePayroll({
    grossSalary: g,
    payableDays,
    lopDays: lop,
  })
  const perDay = perDaySalary
  const lopDed = lopDeduction
  const projectedGrossAfterLop = computeProjectedGrossAfterLop(g, lopDed)
  const earnedTillDate = computeEarnedTillDate(perDay, presentDays)

  const {
    pfPct = 0,
    tdsPct = 0,
    advanceAmount = 0,
    otherDeductionAmt = 0,
  } = str || {}

  const structure = computeSalaryStructureAmounts(g, str || {})

  const casual = Number(att.casualLeave) || 0
  const sick = Number(att.sickLeave) || 0
  const paidLeaveDays = Number(att.paidLeave) || casual + sick
  const halfDayEarned = (Number(att.halfDays) || 0) * 0.5
  const computedPaidDays = Math.max(
    0,
    presentDays + paidLeaveDays + (Number(att.paidHolidays) || 0) + halfDayEarned,
  )
  const paidDays = Number(att?.paidDays) > 0 ? Number(att.paidDays) : computedPaidDays

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
  const totalDed = r2(lopDed + structuralDeductions)
  const net = r2(totalEarnings - totalDed)

  const attendanceWorkingDays =
    Number(att?.attendanceWorkingDays) || Number(att?.workingDays) || 0

  const attendancePct = r2((presentDays / Math.max(1, payableDays)) * 100)

  const basisFlags = [
    payrollSettings.includeWeekendsInPayroll ? 'weekends in divisor' : 'weekends excluded from divisor',
    payrollSettings.includeHolidaysInPayroll ? 'holidays in divisor' : 'holidays excluded from divisor',
  ].join(' · ')

  return {
    ...run,
    payrollBasisLabel: payrollModeLabel(payrollSettings.payrollCalculationMode),
    payrollBasisFlags: basisFlags,
    payableDays,
    totalDaysInMonth,
    presentDays,
    attendanceWorkingDays,
    paidLeaveDays,
    paidDays,
    lop,
    perDay,
    lopDed,
    effGross: projectedGrossAfterLop,
    projectedGrossAfterLop,
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
