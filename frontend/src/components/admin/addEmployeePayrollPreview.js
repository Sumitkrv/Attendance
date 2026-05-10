/** Phase-1 payroll estimates for onboarding preview (aligns with backend payroll routes). */

export function estimatePayrollPreviewIndia({ salaryType, monthlyGross, netTargetMonthly }) {
  const st = String(salaryType || 'CTC_BASED').toUpperCase()
  if (st === 'IN_HAND') {
    const net = Math.max(0, Number(netTargetMonthly || 0))
    return {
      estimatedInHand: net,
      estimatedPf: 0,
      estimatedEsi: 0,
      estimatedPt: 0,
      estimatedTds: 0,
    }
  }

  const gross = Math.max(0, Number(monthlyGross || 0))
  const basic = gross * 0.5
  const pfWage = Math.min(basic, 15000)
  const pf = Math.round(pfWage * 0.12 * 100) / 100
  const esi = gross <= 21000 ? Math.round(gross * 0.0075 * 100) / 100 : 0
  const pt = gross > 15000 ? 200 : gross > 10000 ? 150 : 0
  const tds = 0
  const inHand = Math.max(0, Math.round((gross - pf - esi - pt - tds) * 100) / 100)

  return {
    estimatedInHand: inHand,
    estimatedPf: pf,
    estimatedEsi: esi,
    estimatedPt: pt,
    estimatedTds: tds,
  }
}

export function formatINR(amount) {
  return `₹${Number(amount || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}
