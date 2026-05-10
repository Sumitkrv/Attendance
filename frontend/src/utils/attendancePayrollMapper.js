/**
 * Maps payroll-preview API + company context → attendance state for the payroll UI.
 * Attendance sync fields stay as returned by the backend; payroll divisor uses full-month cycle only.
 */

import {
  getDaysInMonth,
  countSundays,
  countSaturdays,
  countHolidaysInMonth,
} from './payrollUtils'

const n0 = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/**
 * @param {Record<string, unknown> | null | undefined} preview — /api/employees/:id/payroll-preview JSON
 * @param {number} year
 * @param {number} month 1–12
 * @param {Record<string, unknown> | null | undefined} company — selectedCompany from context
 */
export function buildPayrollAttendanceState(preview, year, month, company) {
  const totalDaysInMonth = getDaysInMonth(year, month)
  const sundaysFullMonth = countSundays(year, month)
  const saturdaysFullMonth = countSaturdays(year, month)

  const daysTrackedInPeriod = n0(preview?.totalDaysInMonth) || totalDaysInMonth
  const sundaysInPeriod = n0(preview?.sundaysInMonth)
  const saturdaysInPeriod = n0(preview?.saturdaysOffInMonth ?? preview?.saturdaysInMonth)
  const paidHolidaysInPeriod = n0(preview?.paidHolidayDays ?? preview?.holidayDays)
  const holidaysFromCompany = countHolidaysInMonth(company?.holidays, year, month)
  const holidaysFullMonth = holidaysFromCompany > 0 ? holidaysFromCompany : paidHolidaysInPeriod

  const attendanceWorkingDays =
    n0(preview?.workingDaysInMonth) ||
    Math.max(1, daysTrackedInPeriod - sundaysInPeriod - saturdaysInPeriod - paidHolidaysInPeriod)

  const casualLeave = n0(preview?.casualLeaveDays)
  const sickLeave = n0(preview?.sickLeaveDays)
  const paidLeave = n0(preview?.paidLeaveDays) || casualLeave + sickLeave
  const presentDays = n0(preview?.presentDays)
  const halfDays = n0(preview?.halfDays ?? preview?.halfDayCount)
  const paidDays =
    n0(preview?.paidDays) ||
    Math.max(0, presentDays + paidLeave + paidHolidaysInPeriod + halfDays * 0.5)
  const lopDays =
    n0(preview?.lopDays) ||
    Math.max(0, attendanceWorkingDays - Math.min(attendanceWorkingDays, paidDays))

  const weekends = sundaysFullMonth + saturdaysFullMonth
  const holidays = holidaysFullMonth
  const paidLeaves = paidLeave

  return {
    totalDays: totalDaysInMonth,
    totalDaysInMonth,
    daysTrackedInPeriod,
    sundays: sundaysFullMonth,
    saturdays: saturdaysFullMonth,
    weekends,
    holidays,
    paidLeaves,
    sundaysInPeriod,
    saturdaysInPeriod,
    paidHolidays: paidHolidaysInPeriod,
    holidaysFullMonth,
    attendanceWorkingDays,
    /** @deprecated use attendanceWorkingDays; kept for setAttField compatibility */
    workingDays: attendanceWorkingDays,
    presentDays,
    casualLeave,
    sickLeave,
    paidLeave,
    halfDays,
    overtimeHours: n0(preview?.overtimeHours ?? preview?.totalOvertimeHours),
    overtimeEarnings: n0(preview?.overtimeEarnings ?? preview?.totalOvertime),
    lateMarks: n0(preview?.lateMarks),
    earlyExits: n0(preview?.earlyExits),
    latePenalty: n0(preview?.latePenalty),
    paidDays,
    lopDays,
    absentDays: n0(preview?.absentDays),
    attendancePct: n0(preview?.attendancePct ?? preview?.attendancePercentage),
    source: preview?.attendanceSource || 'database',
    attendanceRecordCount: n0(preview?.attendanceRecordCount),
    leaveRecordCount: n0(preview?.approvedLeaveRecordCount ?? preview?.leaveRecordCount),
    holidayRecordCount: n0(preview?.holidayRecordCount),
    lastSyncedAt:
      preview?.attendanceLastSyncedAt || preview?.lastSyncedAt || new Date().toISOString(),
    sourceMessage:
      preview?.attendanceSourceMessage ||
      `Attendance synced from ${n0(preview?.attendanceRecordCount)} attendance records and ${n0(preview?.approvedLeaveRecordCount ?? preview?.leaveRecordCount)} approved leave records.`,
  }
}

export function makeDefaultPayrollAttendanceAtt(year, month) {
  const totalDaysInMonth = getDaysInMonth(year, month)
  const suns = countSundays(year, month)
  const sats = countSaturdays(year, month)
  const paidHolidaysInPeriod = 0
  const attendanceWorkingDays = Math.max(1, totalDaysInMonth - suns - sats - paidHolidaysInPeriod)
  const weekends = suns + sats
  return {
    totalDays: totalDaysInMonth,
    totalDaysInMonth,
    daysTrackedInPeriod: totalDaysInMonth,
    sundays: suns,
    saturdays: sats,
    weekends,
    holidays: 0,
    paidLeaves: 0,
    sundaysInPeriod: suns,
    saturdaysInPeriod: sats,
    paidHolidays: paidHolidaysInPeriod,
    holidaysFullMonth: 0,
    attendanceWorkingDays,
    workingDays: attendanceWorkingDays,
    presentDays: 0,
    casualLeave: 0,
    sickLeave: 0,
    paidLeave: 0,
    halfDays: 0,
    overtimeHours: 0,
    overtimeEarnings: 0,
    lateMarks: 0,
    earlyExits: 0,
    paidDays: 0,
    lopDays: attendanceWorkingDays,
    absentDays: 0,
    latePenalty: 0,
    attendancePct: 0,
    source: 'default',
    attendanceRecordCount: 0,
    leaveRecordCount: 0,
    holidayRecordCount: 0,
    lastSyncedAt: '',
    sourceMessage: '',
  }
}
