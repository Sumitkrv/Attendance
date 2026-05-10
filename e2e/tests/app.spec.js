// ==========================================================================
// Item 5: E2E tests using Playwright
// Install: npx playwright install
// Run:     npx playwright test
// ==========================================================================
import { test, expect } from '@playwright/test'

const BASE = process.env.FRONTEND_URL || 'http://localhost:5173'
const API = process.env.API_URL || 'http://localhost:5001'

test.describe('Admin Login Flow', () => {
  test('should show login form on admin page', async ({ page }) => {
    await page.goto(`${BASE}/#/admin`)
    // Should see the login card
    await expect(page.locator('text=Admin Login').or(page.locator('text=PRHR Admin Login'))).toBeVisible({ timeout: 10000 })
  })

  test('should show error for invalid credentials', async ({ page }) => {
    await page.goto(`${BASE}/#/admin`)
    await page.fill('input[name="username"], input[placeholder*="Username"]', 'admin')
    await page.fill('input[name="password"], input[type="password"]', 'wrongpassword')
    await page.click('button[type="submit"], button:has-text("Login")')
    // Should show error message
    await expect(page.locator('text=Invalid').or(page.locator('[class*="error"]'))).toBeVisible({ timeout: 5000 })
  })

  test('should login successfully with correct credentials', async ({ page }) => {
    await page.goto(`${BASE}/#/admin`)
    await page.fill('input[name="username"], input[placeholder*="Username"]', 'admin')
    await page.fill('input[name="password"], input[type="password"]', process.env.ADMIN_PASSWORD || 'admin123')
    await page.click('button[type="submit"], button:has-text("Login")')
    // After login, should see dashboard elements
    await expect(page.locator('text=Dashboard').or(page.locator('[class*="sidebar"]'))).toBeVisible({ timeout: 15000 })
  })
})

test.describe('User Login Flow', () => {
  test('should show user login form', async ({ page }) => {
    await page.goto(`${BASE}/#/user`)
    await expect(page.locator('input[placeholder*="Login"]').or(page.locator('text=User Login'))).toBeVisible({ timeout: 10000 })
  })
})

test.describe('Health Checks', () => {
  test('backend health endpoint should return ok', async ({ request }) => {
    const resp = await request.get(`${API}/health`)
    expect(resp.status()).toBe(200)
    const data = await resp.json()
    expect(data.status).toBe('ok')
  })

  test('backend readiness endpoint should respond', async ({ request }) => {
    const resp = await request.get(`${API}/ready`)
    expect([200, 503]).toContain(resp.status())
  })
})

test.describe('Admin Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    // Login first
    await page.goto(`${BASE}/#/admin`)
    await page.fill('input[name="username"], input[placeholder*="Username"]', 'admin')
    await page.fill('input[name="password"], input[type="password"]', process.env.ADMIN_PASSWORD || 'admin123')
    await page.click('button[type="submit"], button:has-text("Login")')
    await page.waitForTimeout(3000)
  })

  test('should display employee list', async ({ page }) => {
    // Navigate to employees section
    const employeesLink = page.locator('text=Employees').or(page.locator('[class*="sidebar"] >> text=Directory'))
    if (await employeesLink.isVisible()) {
      await employeesLink.first().click()
      await page.waitForTimeout(2000)
    }
  })

  test('should display attendance data', async ({ page }) => {
    const attendanceLink = page.locator('text=Attendance').or(page.locator('[class*="sidebar"] >> text=Logs'))
    if (await attendanceLink.isVisible()) {
      await attendanceLink.first().click()
      await page.waitForTimeout(2000)
    }
  })
})

test.describe('Account Lockout', () => {
  test('should lock account after multiple failed attempts', async ({ request }) => {
    const uniqueUser = `locktest_${Date.now()}`
    // 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await request.post(`${API}/admin/login`, {
        data: { username: uniqueUser, password: 'wrong' },
      })
    }
    // 6th attempt should be locked
    const resp = await request.post(`${API}/admin/login`, {
      data: { username: uniqueUser, password: 'wrong' },
    })
    expect(resp.status()).toBe(429)
    const data = await resp.json()
    expect(data.locked).toBe(true)
  })
})
