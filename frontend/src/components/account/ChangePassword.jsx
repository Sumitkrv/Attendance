import { useMemo, useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { apiFetch } from '../../api'
import { PASSWORD_MIN_LENGTH } from '../../config/constants'

function getStrength(password = '') {
  const text = String(password || '')
  let score = 0
  if (text.length >= PASSWORD_MIN_LENGTH) score += 1
  if (/[A-Z]/.test(text)) score += 1
  if (/[a-z]/.test(text)) score += 1
  if (/[0-9]/.test(text)) score += 1
  if (/[^A-Za-z0-9]/.test(text)) score += 1

  if (score <= 2) return { label: 'Weak', band: 'weak', widthPct: Math.max(18, score * 20) }
  if (score <= 4) return { label: 'Medium', band: 'medium', widthPct: 72 }
  return { label: 'Strong', band: 'strong', widthPct: 100 }
}

function PasswordField({ id, label, value, onChange, autoComplete, reveal, onToggleReveal }) {
  return (
    <div className="hrms-account-field hrms-account-field--password">
      <label className="hrms-account-label" htmlFor={id}>{label}</label>
      <div className="hrms-account-input-shell">
        <input
          id={id}
          type={reveal ? 'text' : 'password'}
          className="hrms-account-input hrms-account-input--with-toggle"
          value={value}
          onChange={onChange}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          className="hrms-account-input-toggle"
          onClick={onToggleReveal}
          aria-label={reveal ? 'Hide password' : 'Show password'}
        >
          {reveal ? <EyeOff size={18} strokeWidth={1.75} /> : <Eye size={18} strokeWidth={1.75} />}
        </button>
      </div>
    </div>
  )
}

export default function ChangePassword({ token, onTokenRefresh, onFlash }) {
  const [oldPassword, setOldPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showOld, setShowOld] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const strength = useMemo(() => getStrength(newPassword), [newPassword])

  const lenOk = newPassword.length >= PASSWORD_MIN_LENGTH
  const mixedOk = /[A-Za-z]/.test(newPassword) && /\d/.test(newPassword)
  const symbolOk = /[^A-Za-z0-9]/.test(newPassword)
  const matchOk = newPassword.length > 0 && newPassword === confirmPassword

  async function submit(e) {
    e.preventDefault()
    if (saving) return

    if (!oldPassword || !newPassword) {
      setError('Current password and new password are required')
      return
    }
    if (String(newPassword).length < PASSWORD_MIN_LENGTH) {
      setError(`New password must be at least ${PASSWORD_MIN_LENGTH} characters`)
      return
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match')
      return
    }

    setSaving(true)
    setError('')
    try {
      const data = await apiFetch('/api/account/change-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
      }, token)
      if (String(data?.token || '').trim() && typeof onTokenRefresh === 'function') {
        onTokenRefresh(String(data.token))
      }
      setOldPassword('')
      setNewPassword('')
      setConfirmPassword('')
      const msg = data?.message || 'Password updated successfully'
      if (typeof onFlash === 'function') onFlash(msg)
    } catch (err) {
      setError(err.message || 'Unable to change password')
    } finally {
      setSaving(false)
    }
  }

  const barClass =
    strength.band === 'weak'
      ? 'hrms-password-strength__fill--weak'
      : strength.band === 'medium'
        ? 'hrms-password-strength__fill--medium'
        : 'hrms-password-strength__fill--strong'

  const labelClass =
    strength.band === 'weak'
      ? 'hrms-password-strength__label--weak'
      : strength.band === 'medium'
        ? 'hrms-password-strength__label--medium'
        : 'hrms-password-strength__label--strong'

  return (
    <div className="hrms-account-card">
      <div className="hrms-account-card-inner">
        {!!error && (
          <div className="hrms-account-banner hrms-account-banner--error" role="alert">
            {error}
          </div>
        )}

        <h3 className="hrms-account-section-title">Change password</h3>
        <p className="hrms-account-section-hint">
          Choose a password you don’t use elsewhere; you’ll stay signed in on this device.
        </p>

        <form className="hrms-account-form" onSubmit={submit}>
          <div className="hrms-account-password-stack">
            <PasswordField
              id="hrms-cp-old"
              label="Current password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              autoComplete="current-password"
              reveal={showOld}
              onToggleReveal={() => setShowOld((v) => !v)}
            />
            <PasswordField
              id="hrms-cp-new"
              label="New password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              reveal={showNew}
              onToggleReveal={() => setShowNew((v) => !v)}
            />
            <PasswordField
              id="hrms-cp-confirm"
              label="Confirm new password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              reveal={showConfirm}
              onToggleReveal={() => setShowConfirm((v) => !v)}
            />
          </div>

          <div className="hrms-password-strength">
            <div className="hrms-password-strength__head">
              <span className="hrms-password-strength__title">Password strength</span>
              <span className={`hrms-password-strength__label ${labelClass}`}>{strength.label}</span>
            </div>
            <div className="hrms-password-strength__track" role="progressbar" aria-valuenow={strength.widthPct} aria-valuemin={0} aria-valuemax={100}>
              <div className={`hrms-password-strength__fill ${barClass}`} style={{ width: `${strength.widthPct}%` }} />
            </div>
          </div>

          <ul className="hrms-account-checklist" aria-label="Password requirements">
            <li className={lenOk ? 'is-met' : ''}>At least {PASSWORD_MIN_LENGTH} characters</li>
            <li className={mixedOk ? 'is-met' : ''}>Mix of letters and numbers</li>
            <li className={symbolOk ? 'is-met' : ''}>Include a symbol for stronger protection</li>
            <li className={matchOk ? 'is-met' : ''}>Matches confirmation</li>
          </ul>

          <p className="hrms-account-security-tip">
            Avoid reused passwords from other products. If this account is shared, rotate credentials after handoff.
          </p>

          <footer className="hrms-account-footer">
            <button type="submit" className="hrms-account-btn hrms-account-btn--primary" disabled={saving}>
              {saving ? 'Updating…' : 'Update password'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
