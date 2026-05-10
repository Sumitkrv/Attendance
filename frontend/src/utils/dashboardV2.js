export function firstNameOf(value = '') {
  const full = String(value || '').trim().replace(/[_\-.]+/g, ' ')
  if (!full) return 'Admin'
  return full.split(/\s+/).filter(Boolean)[0] || 'Admin'
}

export function isAfterDailyCutoff(hour = 10, atDate = new Date()) {
  const cutoffHour = Number.isFinite(Number(hour)) ? Number(hour) : 10
  return atDate.getHours() >= cutoffHour
}

export function normalizeDashboardAlertIssue(value = '') {
  const text = String(value || '').trim().toLowerCase()
  if (text.includes('no attendance') || text.includes('high absenteeism') || text.includes('missing check')) {
    return 'attendance coverage risk'
  }
  return text || 'alert'
}
