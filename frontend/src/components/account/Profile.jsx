import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../../api'

function initialsOf(name = '') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function Profile({ token, onProfileNameUpdated, onFlash }) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [profile, setProfile] = useState(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const baselineNameRef = useRef('')

  async function loadProfile() {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/api/account/profile', {}, token)
      const row = data?.profile || {}
      setProfile(row)
      const n = String(row?.name || '')
      setName(n)
      baselineNameRef.current = n.trim()
    } catch (err) {
      setError(err.message || 'Unable to load profile')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadProfile()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  const trimmedName = String(name || '').trim()
  const isDirty = trimmedName !== String(baselineNameRef.current || '').trim()

  async function submit(e) {
    e.preventDefault()
    if (saving || !isDirty) return
    if (!trimmedName) {
      setError('Name is required')
      return
    }

    setSaving(true)
    setError('')
    try {
      const data = await apiFetch('/api/account/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmedName }),
      }, token)
      const row = data?.profile || {}
      setProfile(row)
      const saved = String(row?.name || trimmedName)
      setName(saved)
      baselineNameRef.current = saved.trim()
      const msg = data?.message || 'Profile updated successfully'
      if (typeof onFlash === 'function') onFlash(msg)
      if (typeof onProfileNameUpdated === 'function') {
        onProfileNameUpdated(saved.trim())
      }
    } catch (err) {
      setError(err.message || 'Unable to update profile')
    } finally {
      setSaving(false)
    }
  }

  const displayRole = String(profile?.role || 'admin').replace(/_/g, ' ')
  const created = String(profile?.created_at || '').replace('T', ' ').slice(0, 19)

  return (
    <div className="hrms-account-card">
      <div className="hrms-account-card-inner">
        {!!error && (
          <div className="hrms-account-banner hrms-account-banner--error" role="alert">
            {error}
          </div>
        )}

        <header className="hrms-account-profile-header">
          <div className="hrms-account-avatar" aria-hidden>
            {initialsOf(profile?.name || name || profile?.username || '')}
          </div>
          <div className="hrms-account-profile-headlines">
            <h2 className="hrms-account-display-name">
              {loading ? '…' : String(profile?.name || name || profile?.username || 'Admin')}
            </h2>
            <p className="hrms-account-display-email">{loading ? ' ' : String(profile?.email || '')}</p>
            <div className="hrms-account-badge-row">
              <span className="hrms-account-badge hrms-account-badge--role">{displayRole}</span>
              <span className="hrms-account-badge hrms-account-badge--ok">Active</span>
            </div>
          </div>
        </header>

        <div className="hrms-account-divider" />

        <section>
          <h3 className="hrms-account-section-title">Profile details</h3>
          <p className="hrms-account-section-hint">These details appear across your admin workspace.</p>

          {loading ? (
            <p className="hrms-account-muted-loading">Loading profile…</p>
          ) : (
            <form className="hrms-account-form" onSubmit={submit}>
              <div className="hrms-account-field-grid">
                <div className="hrms-account-field">
                  <label className="hrms-account-label" htmlFor="hrms-account-name">Display name</label>
                  <input
                    id="hrms-account-name"
                    className="hrms-account-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Your name"
                    autoComplete="name"
                  />
                </div>
                <div className="hrms-account-field">
                  <label className="hrms-account-label" htmlFor="hrms-account-email">Email</label>
                  <input
                    id="hrms-account-email"
                    className="hrms-account-input"
                    value={String(profile?.email || '')}
                    readOnly
                    aria-readonly="true"
                  />
                  <p className="hrms-account-field-hint">Read-only · contact support to update your login email.</p>
                </div>
              </div>

              <div className="hrms-account-readonly-grid">
                <div>
                  <span className="hrms-account-meta-label">Username</span>
                  <p className="hrms-account-meta-value">{String(profile?.username || '—')}</p>
                </div>
                <div>
                  <span className="hrms-account-meta-label">Member since</span>
                  <p className="hrms-account-meta-value">{created || '—'}</p>
                </div>
              </div>

              <footer className="hrms-account-footer">
                <button
                  type="submit"
                  className="hrms-account-btn hrms-account-btn--primary"
                  disabled={saving || !isDirty || loading}
                >
                  {saving ? 'Saving…' : 'Save changes'}
                </button>
              </footer>
            </form>
          )}
        </section>
      </div>
    </div>
  )
}
