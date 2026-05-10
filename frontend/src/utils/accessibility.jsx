// ==========================================================================
// Item 2: Accessibility utilities and hooks
// Provides ARIA helpers, keyboard navigation, focus management,
// and screen-reader announcements.
// ==========================================================================
import { useCallback, useEffect, useRef } from 'react'

/**
 * Hook: Trap focus within a container (for modals/dialogs).
 * When active, Tab/Shift+Tab cycle through focusable elements inside ref.
 */
export function useFocusTrap(isActive = true) {
  const containerRef = useRef(null)

  useEffect(() => {
    if (!isActive || !containerRef.current) return

    const container = containerRef.current
    const focusable = container.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    const firstFocusable = focusable[0]
    const lastFocusable = focusable[focusable.length - 1]

    function handleKeyDown(e) {
      if (e.key !== 'Tab') return

      if (e.shiftKey) {
        if (document.activeElement === firstFocusable) {
          e.preventDefault()
          lastFocusable?.focus()
        }
      } else {
        if (document.activeElement === lastFocusable) {
          e.preventDefault()
          firstFocusable?.focus()
        }
      }
    }

    container.addEventListener('keydown', handleKeyDown)
    // Focus the first element
    firstFocusable?.focus()

    return () => container.removeEventListener('keydown', handleKeyDown)
  }, [isActive])

  return containerRef
}

/**
 * Hook: Announce messages to screen readers via aria-live region.
 */
export function useScreenReaderAnnounce() {
  const announce = useCallback((message, priority = 'polite') => {
    const el = document.getElementById('sr-announcer')
    if (el) {
      el.setAttribute('aria-live', priority)
      el.textContent = ''
      // Small delay so screen reader picks up the change
      requestAnimationFrame(() => {
        el.textContent = message
      })
    }
  }, [])

  return announce
}

/**
 * Hook: Keyboard navigation for list/grid items.
 * Arrow keys move focus, Enter/Space activate.
 */
export function useKeyboardNav(itemCount, onActivate) {
  const activeIndex = useRef(0)

  const handleKeyDown = useCallback(
    (e) => {
      let newIndex = activeIndex.current

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowRight':
          e.preventDefault()
          newIndex = Math.min(itemCount - 1, newIndex + 1)
          break
        case 'ArrowUp':
        case 'ArrowLeft':
          e.preventDefault()
          newIndex = Math.max(0, newIndex - 1)
          break
        case 'Home':
          e.preventDefault()
          newIndex = 0
          break
        case 'End':
          e.preventDefault()
          newIndex = itemCount - 1
          break
        case 'Enter':
        case ' ':
          e.preventDefault()
          onActivate?.(activeIndex.current)
          return
        default:
          return
      }

      activeIndex.current = newIndex
      // Focus the element with matching data-index
      const container = e.currentTarget
      const target = container.querySelector(`[data-index="${newIndex}"]`)
      target?.focus()
    },
    [itemCount, onActivate]
  )

  return { handleKeyDown, activeIndex }
}

/**
 * Hook: Skip-to-content link for keyboard users.
 */
export function useSkipToContent(targetId = 'main-content') {
  const skipToContent = useCallback(() => {
    const target = document.getElementById(targetId)
    if (target) {
      target.tabIndex = -1
      target.focus()
      target.scrollIntoView({ behavior: 'smooth' })
    }
  }, [targetId])

  return skipToContent
}

/**
 * Higher-order component wrapper that adds ARIA attributes.
 */
export function ariaProps({
  label,
  describedBy,
  role,
  expanded,
  selected,
  controls,
  live,
  required,
  invalid,
  errorMessage,
}) {
  const props = {}
  if (label) props['aria-label'] = label
  if (describedBy) props['aria-describedby'] = describedBy
  if (role) props.role = role
  if (expanded !== undefined) props['aria-expanded'] = expanded
  if (selected !== undefined) props['aria-selected'] = selected
  if (controls) props['aria-controls'] = controls
  if (live) props['aria-live'] = live
  if (required) props['aria-required'] = 'true'
  if (invalid) props['aria-invalid'] = 'true'
  if (errorMessage) props['aria-errormessage'] = errorMessage
  return props
}

/**
 * ScreenReaderOnly component — visually hidden but accessible.
 */
export function ScreenReaderOnly({ children, as: Tag = 'span' }) {
  return (
    <Tag
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    >
      {children}
    </Tag>
  )
}

/**
 * SkipLink component — skip-to-content for keyboard users.
 */
export function SkipLink({ targetId = 'main-content', label = 'Skip to main content' }) {
  return (
    <a
      href={`#${targetId}`}
      className="skip-link"
      style={{
        position: 'absolute',
        left: '-9999px',
        top: 'auto',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
        zIndex: 10000,
      }}
      onFocus={(e) => {
        e.target.style.position = 'fixed'
        e.target.style.left = '8px'
        e.target.style.top = '8px'
        e.target.style.width = 'auto'
        e.target.style.height = 'auto'
        e.target.style.padding = '12px 24px'
        e.target.style.background = '#4f6ef7'
        e.target.style.color = '#fff'
        e.target.style.borderRadius = '8px'
        e.target.style.fontSize = '14px'
        e.target.style.fontWeight = '600'
        e.target.style.textDecoration = 'none'
        e.target.style.boxShadow = '0 4px 16px rgba(0,0,0,0.2)'
      }}
      onBlur={(e) => {
        e.target.style.position = 'absolute'
        e.target.style.left = '-9999px'
        e.target.style.width = '1px'
        e.target.style.height = '1px'
      }}
    >
      {label}
    </a>
  )
}

/**
 * LiveRegion component — invisible aria-live region for announcements.
 */
export function LiveRegion() {
  return (
    <div
      id="sr-announcer"
      aria-live="polite"
      aria-atomic="true"
      style={{
        position: 'absolute',
        width: '1px',
        height: '1px',
        padding: 0,
        margin: '-1px',
        overflow: 'hidden',
        clip: 'rect(0, 0, 0, 0)',
        whiteSpace: 'nowrap',
        border: 0,
      }}
    />
  )
}
