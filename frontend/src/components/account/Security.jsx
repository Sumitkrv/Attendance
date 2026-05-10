import { useEffect, useState } from 'react'
import { Loader2, Monitor, RefreshCw, Shield, Smartphone, Globe, Tablet } from 'lucide-react'
import { apiFetch } from '../../api'

function deviceIconKind(deviceLabel = '') {
  const d = String(deviceLabel || '').toLowerCase()
  if (/iphone|android|mobile|pixel|galaxy/.test(d)) return 'phone'
  if (/ipad|tablet/.test(d)) return 'tablet'
  if (/windows|mac|linux|desktop|chrome|firefox|safari|edge/.test(d)) return 'desktop'
  return 'globe'
}

function DeviceGlyph({ device }) {
  const kind = deviceIconKind(device)
  const common = { size: 22, strokeWidth: 1.65, className: 'hrms-session-icon', 'aria-hidden': true }
  if (kind === 'phone') return <Smartphone {...common} />
  if (kind === 'tablet') return <Tablet {...common} />
  if (kind === 'desktop') return <Monitor {...common} />
  return <Globe {...common} />
}

export default function Security({ token, onFlash }) {
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [sessions, setSessions] = useState([])
  const [error, setError] = useState('')

  async function loadSessions() {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/api/account/sessions', {}, token)
      setSessions(Array.isArray(data?.items) ? data.items : [])
    } catch (err) {
      setError(err.message || 'Unable to load sessions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadSessions()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token])

  async function logoutOtherDevices() {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const data = await apiFetch('/api/account/sessions/logout-others', {
        method: 'POST',
      }, token)
      const msg = data?.message || 'Other sessions ended'
      if (typeof onFlash === 'function') onFlash(msg)
      await loadSessions()
    } catch (err) {
      setError(err.message || 'Unable to log out other devices')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hrms-account-card">
      <div className="hrms-account-card-inner">
        {!!error && (
          <div className="hrms-account-banner hrms-account-banner--error" role="alert">
            {error}
          </div>
        )}

        <header className="hrms-account-security-head">
          <div className="hrms-account-security-title-block">
            <div className="hrms-session-icon-wrap" aria-hidden>
              <Shield size={22} strokeWidth={1.65} />
            </div>
            <div>
              <h3 className="hrms-account-section-title hrms-account-section-title--flush">Sessions</h3>
              <p className="hrms-account-section-hint hrms-account-section-hint--tight">
                Where your account is signed in. Revoke access you don’t recognize.
              </p>
            </div>
          </div>

          <div className="hrms-account-actions-row">
            <button
              type="button"
              className="hrms-account-btn hrms-account-btn--danger-solid"
              onClick={logoutOtherDevices}
              disabled={busy || loading}
            >
              {busy ? 'Signing out…' : 'Log out other devices'}
            </button>
            <button
              type="button"
              className="hrms-account-btn hrms-account-btn--secondary"
              onClick={() => loadSessions()}
              disabled={loading || busy}
            >
              {loading ? <Loader2 size={16} className="hrms-spin" /> : <RefreshCw size={16} strokeWidth={1.75} />}
              Refresh list
            </button>
          </div>
        </header>

        <div className="hrms-account-divider" />

        {loading ? (
          <p className="hrms-account-muted-loading">Loading sessions…</p>
        ) : (
          <ul className="hrms-session-list">
            {!sessions.length && (
              <li className="hrms-account-empty-sessions">No sessions returned from the server.</li>
            )}
            {sessions.map((session) => {
              const isCurrent = !!session?.is_current
              const status = String(session?.status || 'inactive').toLowerCase()
              const active = status === 'active'
              return (
                <li
                  key={String(session?.id || `${session?.device}-${session?.created_at}`)}
                  className={`hrms-session-card${isCurrent ? ' hrms-session-card--current' : ''}`}
                >
                  <div className="hrms-session-card__top">
                    <div className="hrms-session-card__identity">
                      <DeviceGlyph device={session?.device} />
                      <div>
                        <p className="hrms-session-card__device">{String(session?.device || 'Unknown device')}</p>
                        <p className="hrms-session-card__meta">
                          <span>{String(session?.ip || '—')}</span>
                          <span className="hrms-session-card__sep">·</span>
                          <span>{String(session?.location || 'Unknown location')}</span>
                        </p>
                      </div>
                    </div>
                    <div className="hrms-session-card__badges">
                      {isCurrent ? (
                        <span className="hrms-session-pill hrms-session-pill--current">
                          <span className="hrms-session-live-dot" aria-hidden /> Current session
                        </span>
                      ) : (
                        <span className={`hrms-session-pill ${active ? 'hrms-session-pill--remote' : 'hrms-session-pill--muted'}`}>
                          {active ? 'Active' : 'Signed out'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="hrms-session-card__detail-grid">
                    <div>
                      <span className="hrms-session-detail-label">Last active</span>
                      <span className="hrms-session-detail-val">
                        {String(session?.last_seen_at || '—').replace('T', ' ').slice(0, 19) || '—'}
                      </span>
                    </div>
                    <div>
                      <span className="hrms-session-detail-label">Started</span>
                      <span className="hrms-session-detail-val">
                        {String(session?.created_at || '—').replace('T', ' ').slice(0, 19) || '—'}
                      </span>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
