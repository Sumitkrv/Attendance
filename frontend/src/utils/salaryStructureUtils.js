/**
 * Salary structure on contractual gross — components do NOT shrink when LOP is applied.
 * LOP is handled as a separate deduction in payrollEngine.
 */

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/**
 * @param {number} grossSalary
 * @param {Record<string, number>} str — same shape as EmployeePayrollCalculator DEFAULT_STRUCTURE
 */
export function computeSalaryStructureAmounts(grossSalary, str) {
  const g = Number(grossSalary) || 0
  const {
    basicPct = 50,
    hraPct = 25,
    conveyancePct = 5,
    ccaPct = 18.75,
    medicalPct = 1.25,
    positionAllowPct = 0,
    newsPaperPct = 0,
    mobileReimbPct = 0,
    arrearPct = 0,
    bonusPct = 0,
    otherEarningsPct = 0,
  } = str || {}

  const basicRaw = (g * basicPct) / 100
  const hraRaw = (g * hraPct) / 100
  const conveyanceRaw = (g * conveyancePct) / 100
  const ccaRaw = (g * ccaPct) / 100
  const medicalRaw = (g * medicalPct) / 100
  const positionAllowRaw = (g * positionAllowPct) / 100
  const newsPaperRaw = (g * newsPaperPct) / 100
  const mobileReimbRaw = (g * mobileReimbPct) / 100
  const arrearRaw = (g * arrearPct) / 100
  const bonusRaw = (g * bonusPct) / 100
  const otherEarnRaw = (g * otherEarningsPct) / 100

  const structureTotalRaw =
    basicRaw +
    hraRaw +
    conveyanceRaw +
    ccaRaw +
    medicalRaw +
    positionAllowRaw +
    newsPaperRaw +
    mobileReimbRaw +
    arrearRaw +
    bonusRaw +
    otherEarnRaw

  const fixedPct = r2(
    basicPct +
      hraPct +
      conveyancePct +
      ccaPct +
      medicalPct +
      positionAllowPct +
      newsPaperPct +
      mobileReimbPct +
      arrearPct +
      bonusPct +
      otherEarningsPct,
  )
  const pctOk = Math.abs(fixedPct - 100) < 0.01

  return {
    pctOk,
    fixedPct,
    structureTotalRaw,
    structureTotal: r2(structureTotalRaw),
    rounded: {
      basic: r2(basicRaw),
      hra: r2(hraRaw),
      conveyance: r2(conveyanceRaw),
      cca: r2(ccaRaw),
      medical: r2(medicalRaw),
      positionAllow: r2(positionAllowRaw),
      newsPaper: r2(newsPaperRaw),
      mobileReimb: r2(mobileReimbRaw),
      arrear: r2(arrearRaw),
      bonus: r2(bonusRaw),
      otherEarnings: r2(otherEarnRaw),
    },
  }
}
