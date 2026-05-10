import { describe, expect, it } from 'vitest'
import { firstNameOf, isAfterDailyCutoff, normalizeDashboardAlertIssue } from './dashboardV2'

describe('dashboardV2 utils', () => {
  it('extracts first name safely', () => {
    expect(firstNameOf('Sumit Thakur')).toBe('Sumit')
    expect(firstNameOf('sumit_thakur')).toBe('sumit')
    expect(firstNameOf('')).toBe('Admin')
  })

  it('checks daily cutoff by hour', () => {
    const atMorning = new Date('2026-04-21T09:15:00')
    const atNoon = new Date('2026-04-21T12:00:00')
    expect(isAfterDailyCutoff(10, atMorning)).toBe(false)
    expect(isAfterDailyCutoff(10, atNoon)).toBe(true)
  })

  it('normalizes duplicate absenteeism alert issues', () => {
    expect(normalizeDashboardAlertIssue('No Attendance')).toBe('attendance coverage risk')
    expect(normalizeDashboardAlertIssue('High Absenteeism')).toBe('attendance coverage risk')
    expect(normalizeDashboardAlertIssue('Late Checkin')).toBe('late checkin')
  })
})
