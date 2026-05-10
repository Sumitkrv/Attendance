import { Info } from 'lucide-react'
import './PayslipDoc.css'

/** @type {string[]} */
export const PAYSLIP_MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

export const PAYSLIP_MONTH_ABBR = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
]
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']

function b100(n) {
  return n < 20 ? ONES[n] : TENS[~~(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : '')
}
function b1000(n) {
  return n < 100
    ? b100(n)
    : `${ONES[~~(n / 100)]} Hundred${n % 100 ? ` ${b100(n % 100)}` : ''}`
}

export function payslipNumToWords(n) {
  const num = Math.round(Math.abs(Number(n) || 0))
  if (!num) return 'Zero Rupees Only'
  let r = num
  const parts = []
  if (r >= 10000000) {
    parts.push(`${b1000(~~(r / 10000000))} Crore`)
    r %= 10000000
  }
  if (r >= 100000) {
    parts.push(`${b1000(~~(r / 100000))} Lakh`)
    r %= 100000
  }
  if (r >= 1000) {
    parts.push(`${b1000(~~(r / 1000))} Thousand`)
    r %= 1000
  }
  if (r > 0) parts.push(b1000(r))
  return `${parts.join(' ')} Rupees Only`
}

export const payslipFmtINR = (n) =>
  `₹${Number(n || 0).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

/**
 * Map persisted payslip row (GET /user/payroll/payslips) + employee claims into PayslipDoc props.
 * Codes must match backend `_payslip_arrays_from_calculator_snapshot`.
 */
export function buildPayslipDocPropsFromPublishedRow(row, employeeLite = {}) {
  const year = Number(row?.year)
  const month = Number(row?.month)

  const emp = {
    name: String(row?.employee_name || employeeLite?.name || 'Employee'),
    login_id: String(employeeLite?.login_id || employeeLite?.id || row?.employee_id || '—'),
    id: employeeLite?.id,
    department: String(row?.department || employeeLite?.department || 'General'),
    role: employeeLite?.role != null && String(employeeLite.role).trim() !== ''
      ? employeeLite.role
      : '—',
  }

  const grossSalary = Number(row?.monthly_ctc_snapshot ?? row?.gross_salary ?? 0)

  const earningsList = Array.isArray(row?.earnings) ? row.earnings : []
  const dedList = Array.isArray(row?.deductions) ? row.deductions : []
  const amt = (list, code) =>
    Number(
      (list.find((x) => String(x?.code || '').toUpperCase() === code) || {}).amount || 0,
    )

  const earnings = {
    basic: amt(earningsList, 'BASIC'),
    hra: amt(earningsList, 'HRA'),
    conveyance: amt(earningsList, 'CONV'),
    cca: amt(earningsList, 'CCA'),
    medical: amt(earningsList, 'MED'),
    positionAllow: amt(earningsList, 'POS_ALW'),
    newsPaper: amt(earningsList, 'NEWS'),
    mobileReimb: amt(earningsList, 'MOBILE'),
    arrear: amt(earningsList, 'ARREAR'),
    overtime: amt(earningsList, 'OT'),
  }

  const lopDed = amt(dedList, 'LOP') || Number(row?.lop_deduction || 0)

  const totalEarnings = Number(row?.gross_salary || 0)

  let calendarDays
  if (row?.calendar_days_snapshot != null && row.calendar_days_snapshot !== '') {
    calendarDays = Number(row.calendar_days_snapshot)
  } else if (Number.isFinite(year) && Number.isFinite(month) && month >= 1 && month <= 12) {
    calendarDays = new Date(year, month, 0).getDate()
  } else {
    calendarDays = 31
  }

  const payable = Number(row?.working_days_snapshot ?? row?.payable_days_snapshot ?? 0)
  const cd = Math.max(1, calendarDays || 1)
  const perDay =
    grossSalary > 0 ? Math.round((grossSalary / cd) * 100) / 100 : 0

  const calc = {
    payableDays: payable,
    presentDays: Number(row?.present_days_snapshot ?? 0),
    lop: Number(row?.lop_days_snapshot ?? 0),
    paidLeaveDays: Number(row?.paid_leave_snapshot ?? 0),
    lopDed,
    perDay,
    earnedTillDate: Number(row?.mtd_earned_till_publish ?? row?.net_salary ?? 0),
    uiMode: String(row?.payslip_kind || '').toLowerCase() === 'interim_mtd' ? 'live' : 'finalized',
    earnings,
    totalEarnings,
    pf: amt(dedList, 'PF'),
    tds: amt(dedList, 'TDS'),
    advance: amt(dedList, 'ADVANCE'),
    otherDed: amt(dedList, 'OTHER'),
    lateDed: amt(dedList, 'LATE'),
    totalDed: Number(row?.total_deductions ?? 0),
    net: Number(row?.net_salary ?? 0),
    attendancePct: Number(row?.attendance_pct_snapshot ?? 0),
  }

  const synced =
    row?.synced_days_snapshot != null && row.synced_days_snapshot !== ''
      ? Number(row.synced_days_snapshot)
      : Number(row?.present_days_snapshot ?? 0)

  const att = {
    totalDaysInMonth: calendarDays,
    attendanceWorkingDays: synced,
    presentDays: Number(row?.present_days_snapshot ?? 0),
  }

  return { employee: emp, grossSalary, year, month, calc, att }
}

/**
 * Salary slip markup shared by admin payroll preview and employee PDF export.
 * @param {{ name?: string, login_id?: string, department?: string, role?: unknown }} employee
 * @param {number} grossSalary Monthly CTC for header Gross Salary row
 */
export default function PayslipDoc({ employee, grossSalary, year, month, calc, att }) {
  const empName = employee?.name || employee?.login_id || 'Employee'
  const empDept = employee?.department || '—'
  const empDesig = employee?.role || '—'
  const empId = employee?.login_id || employee?.id || '—'
  const {
    payableDays,
    lop,
    paidLeaveDays,
    lopDed,
    perDay,
    earnedTillDate,
    uiMode,
    attendancePct,
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
      overtime,
    },
    totalEarnings,
    pf,
    tds,
    advance,
    otherDed,
    lateDed,
    totalDed,
    net,
  } = calc
  const {
    totalDaysInMonth,
    attendanceWorkingDays,
    presentDays,
  } = att
  const isLive = uiMode === 'live'
  const slipKind = isLive ? 'Projected' : 'Final'

  const earningsRows = [
    { label: 'Basic Salary', amount: basic },
    { label: 'HRA', amount: hra },
    { label: 'Conveyance Allowance', amount: conveyance },
    { label: 'CCA', amount: cca },
    { label: 'Medical', amount: medical },
    { label: 'Position Allowance', amount: positionAllow },
    { label: 'New Paper and Periodicals', amount: newsPaper },
    { label: 'Mobile Reimbursement', amount: mobileReimb },
    { label: 'Arrear', amount: arrear },
    { label: 'Overtime Earnings', amount: overtime },
  ]

  const deductionsRows = []
  if (lopDed > 0) deductionsRows.push({ label: 'Loss of Pay (LOP)', amount: lopDed })
  deductionsRows.push(
    { label: 'Provident Fund', amount: pf },
    { label: 'TDS', amount: tds },
    { label: 'Advance Adjustment', amount: advance },
  )
  if (lateDed > 0) deductionsRows.push({ label: 'Late Penalty', amount: lateDed })
  if (otherDed > 0) deductionsRows.push({ label: 'Other Deductions', amount: otherDed })

  const maxRows = Math.max(earningsRows.length, deductionsRows.length)
  const padded = Array.from({ length: maxRows })

  const primaryWordsAmount = isLive ? earnedTillDate : net

  return (
    <div
      className={`payslip-doc ${isLive ? 'payslip-doc--projected' : 'payslip-doc--final'}`}
      id="payslip-print-target"
    >
      {isLive && (
        <div className="ps-watermark" aria-hidden="true">
          {slipKind.toUpperCase()} PAYSLIP
        </div>
      )}

      <div className="ps-header">
        <div className="ps-company-logo">
          <span>{(empDept?.[0] || 'C').toUpperCase()}</span>
        </div>
        <div className="ps-company-info">
          <div className="ps-company-name">Company Payroll</div>
        </div>
        <div className="ps-slip-badge">
          Salary Slip<br />
          <strong>
            {PAYSLIP_MONTH_ABBR[(month || 1) - 1]} {year}
          </strong>
        </div>
      </div>

      <div className="ps-emp-section">
        <div className="ps-emp-grid">
          <div className="ps-emp-row">
            <span>Employee Name</span>
            <strong>{empName}</strong>
          </div>
          <div className="ps-emp-row">
            <span>Employee Code</span>
            <strong>{String(empId).toUpperCase().slice(0, 8)}</strong>
          </div>
          <div className="ps-emp-row">
            <span>Department</span>
            <strong>{empDept}</strong>
          </div>
          <div className="ps-emp-row">
            <span>Designation</span>
            <strong>{String(empDesig).replace(/_/g, ' ')}</strong>
          </div>
          <div className="ps-emp-row">
            <span>Pay Period</span>
            <strong>
              {PAYSLIP_MONTH_NAMES[(month || 1) - 1]} {year}
            </strong>
          </div>
          <div className="ps-emp-row">
            <span>Gross Salary</span>
            <strong>{payslipFmtINR(grossSalary)}</strong>
          </div>
        </div>
        {lopDed > 0 && (
          <div className="ps-lop-note">
            Loss of Pay ({lop} day{lop > 1 ? 's' : ''}) — {payslipFmtINR(lopDed)}
          </div>
        )}
      </div>

      <div className="ps-table-section">
        <div className="ps-table-header earn">EARNINGS</div>
        <div className="ps-table-header ded">DEDUCTIONS</div>

        <div className="ps-table-body">
          <div className="ps-table-col">
            {earningsRows.map((r, i) => (
              <div key={`e-${String(i)}`} className={`ps-table-row${r.amount === 0 ? ' zero' : ''}`}>
                <span>{r.label}</span>
                <strong>{r.amount === 0 ? '0.00' : payslipFmtINR(r.amount)}</strong>
              </div>
            ))}
          </div>
          <div className="ps-table-col ded">
            {deductionsRows.map((r, i) => (
              <div key={`d-${String(i)}`} className={`ps-table-row${r.amount === 0 ? ' zero' : ''}`}>
                <span>{r.label}</span>
                <strong>{r.amount === 0 ? '0.00' : payslipFmtINR(r.amount)}</strong>
              </div>
            ))}
            {padded.slice(deductionsRows.length).map((_, i) => (
              <div key={`dp-${String(i)}`} className="ps-table-row empty">
                <span />
                <span />
              </div>
            ))}
          </div>
        </div>

        <div className="ps-table-footer">
          <div className="ps-table-total earn">
            <span>Total Earnings</span>
            <strong>{payslipFmtINR(totalEarnings)}</strong>
          </div>
          <div className="ps-table-total ded">
            <span>Total Deductions</span>
            <strong>{payslipFmtINR(totalDed)}</strong>
          </div>
        </div>
      </div>

      <div className={`ps-net-section${isLive ? ' ps-net-section--live' : ''}`}>
        {isLive ? (
          <div className="ps-net-stack">
            <div className="ps-net-label">Earned till date (MTD) — not final payout</div>
            <div className="ps-net-amount ps-net-amount--primary">{payslipFmtINR(earnedTillDate)}</div>
          </div>
        ) : (
          <>
            <div className="ps-net-label">Net payable salary</div>
            <div className="ps-net-amount">{payslipFmtINR(net)}</div>
          </>
        )}
      </div>

      <div className="ps-words">
        <Info size={12} aria-hidden />
        <span>
          <em>In Words ({isLive ? 'MTD earned' : 'Net payable'}):</em>{' '}
          {payslipNumToWords(primaryWordsAmount)}
        </span>
      </div>

      <div className="ps-att-section">
        <div className="ps-att-title">Attendance summary</div>
        <div className="ps-att-grid">
          {[
            { label: 'Payable days', val: payableDays },
            { label: 'Present days', val: presentDays },
            { label: 'LOP days', val: lop },
            { label: 'Paid leave days', val: paidLeaveDays },
            { label: 'Attendance %', val: `${attendancePct}%` },
            { label: 'Synced days', val: attendanceWorkingDays },
            { label: 'Per day rate', val: payslipFmtINR(perDay) },
            { label: 'Calendar days', val: totalDaysInMonth },
          ].map((item) => (
            <div
              key={item.label}
              className={`ps-att-cell ${item.label === 'LOP days' && lop > 0 ? 'danger' : ''}`}
            >
              <div className="ps-att-val">{item.val}</div>
              <div className="ps-att-lbl">{item.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="ps-sign-row">
        <div className="ps-sign-block">
          <div className="ps-sign-line" />
          <span>Authorized Signatory</span>
        </div>
        <div className="ps-sign-block">
          <div className="ps-sign-line" />
          <span>Employee Signature</span>
        </div>
      </div>

      <div className="ps-footer-note">
        {isLive
          ? 'Projected figures for an active payroll cycle. Final amounts are issued after payroll is finalized and locked.'
          : 'Final salary slip. No signature required if digitally signed.'}
      </div>
    </div>
  )
}
