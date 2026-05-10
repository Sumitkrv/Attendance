// ==========================================================================
// Item 12: Frontend white-label/branding hook
// Fetches branding config and applies CSS custom properties dynamically.
// ==========================================================================
import { useEffect, useState } from 'react'
import { BASE_URL } from '../config/apiConfig'

const DEFAULT_BRANDING = {
  company_name: 'PRHR',
  tagline: 'Smart HR Management System',
  logo_url: '',
  primary_color: '#4f6ef7',
  primary_hover: '#3b5ee5',
  sidebar_color: '#1a1d3a',
  accent_color: '#22c55e',
  font_family: "'Inter', -apple-system, BlinkMacSystemFont, sans-serif",
  powered_by: { show: true, text: 'Powered by PRHR', url: 'https://prsparkz.com' },
}

/**
 * Hook: Fetch and apply branding configuration.
 *
 * Usage:
 *   const { branding, isLoaded } = useBranding()
 *   // branding.company_name, branding.logo_url, etc.
 */
export function useBranding() {
  const [branding, setBranding] = useState(DEFAULT_BRANDING)
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function loadBranding() {
      try {
        const res = await fetch(`${BASE_URL}/api/branding`)
        if (res.ok) {
          const data = await res.json()
          if (!cancelled) {
            setBranding({ ...DEFAULT_BRANDING, ...data })
            applyBrandingCSS(data)
          }
        }
      } catch {
        // Use defaults
      } finally {
        if (!cancelled) setIsLoaded(true)
      }
    }

    loadBranding()
    return () => { cancelled = true }
  }, [])

  return { branding, isLoaded }
}

/**
 * Apply branding as CSS custom properties on :root.
 */
function applyBrandingCSS(branding) {
  const root = document.documentElement
  const mappings = {
    '--color-primary': branding.primary_color,
    '--color-primary-hover': branding.primary_hover,
    '--color-secondary': branding.secondary_color,
    '--color-accent': branding.accent_color,
    '--color-danger': branding.danger_color,
    '--color-warning': branding.warning_color,
    '--bg-sidebar': branding.sidebar_color,
    '--bg-card': branding.card_color,
    '--text-primary': branding.text_primary,
    '--text-secondary': branding.text_secondary,
  }

  for (const [prop, value] of Object.entries(mappings)) {
    if (value) {
      root.style.setProperty(prop, value)
    }
  }

  // Update page title
  if (branding.company_name) {
    document.title = `${branding.company_name} — HR Management`
  }

  // Apply custom CSS if provided
  if (branding.custom_css) {
    let styleEl = document.getElementById('whitelabel-css')
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'whitelabel-css'
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = branding.custom_css
  }
}

export default useBranding
