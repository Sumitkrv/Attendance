import { useState, useEffect } from 'react'
import { apiFetch } from '../../api'
import {
  MapPin, Plus, Pencil, Trash2, Loader2, CheckCircle2, AlertCircle,
  Navigation, Clock3, Building2, Shield, X, Save,
} from 'lucide-react'

export default function MultiGeofenceManager({ token }) {
  const [locations, setLocations] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [feedback, setFeedback] = useState({ type: '', text: '' })
  const [formOpen, setFormOpen] = useState(false)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState('')
  const [testingId, setTestingId] = useState('')
  const [testResult, setTestResult] = useState({ id: '', type: '', text: '' })

  const EMPTY_FORM = {
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radius_meters: 200,
    timezone: 'Asia/Kolkata',
    working_hours_start: '09:00',
    working_hours_end: '18:00',
    is_active: true,
    allowed_departments: [],
  }
  const [form, setForm] = useState(EMPTY_FORM)

  useEffect(() => { loadLocations() }, [token])

  async function loadLocations() {
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch('/api/locations', {}, token)
      setLocations(Array.isArray(data) ? data : [])
    } catch (err) {
      setError(err.message || 'Failed to load locations')
    } finally {
      setLoading(false)
    }
  }

  function openCreateForm() {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setFormOpen(true)
  }

  function openEditForm(loc) {
    setForm({
      name: loc.name || '',
      address: loc.address || '',
      latitude: loc.latitude || '',
      longitude: loc.longitude || '',
      radius_meters: loc.radius_meters || 200,
      timezone: loc.timezone || 'Asia/Kolkata',
      working_hours_start: loc.working_hours?.start || '09:00',
      working_hours_end: loc.working_hours?.end || '18:00',
      is_active: loc.is_active !== false,
      allowed_departments: loc.allowed_departments || [],
    })
    setEditingId(loc._id)
    setFormOpen(true)
  }

  function closeForm() {
    setFormOpen(false)
    setEditingId(null)
    setForm(EMPTY_FORM)
  }

  async function handleSubmit(e) {
    e?.preventDefault()
    if (!form.name.trim()) { flash('error', 'Location name is required'); return }
    if (!form.latitude || !form.longitude) { flash('error', 'Latitude and Longitude are required'); return }

    setSaving(true)
    try {
      const payload = {
        name: form.name.trim(),
        address: form.address.trim(),
        latitude: parseFloat(form.latitude),
        longitude: parseFloat(form.longitude),
        radius_meters: parseInt(form.radius_meters) || 200,
        timezone: form.timezone,
        working_hours_start: form.working_hours_start,
        working_hours_end: form.working_hours_end,
        is_active: form.is_active,
        allowed_departments: form.allowed_departments,
      }

      if (editingId) {
        payload.working_hours = { start: form.working_hours_start, end: form.working_hours_end }
        await apiFetch(`/api/locations/${editingId}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, token)
        flash('success', 'Location updated successfully')
      } else {
        await apiFetch('/api/locations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }, token)
        flash('success', 'Location created successfully')
      }
      closeForm()
      loadLocations()
    } catch (err) {
      flash('error', err.message || 'Failed to save location')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(locId) {
    if (!confirm('Are you sure you want to delete this location?')) return
    setDeleting(locId)
    try {
      await apiFetch(`/api/locations/${locId}`, { method: 'DELETE' }, token)
      flash('success', 'Location deleted')
      loadLocations()
    } catch (err) {
      flash('error', err.message || 'Failed to delete')
    } finally {
      setDeleting('')
    }
  }

  async function testLocation(loc) {
    if (!navigator.geolocation) {
      setTestResult({ id: loc._id, type: 'error', text: 'Geolocation not supported' })
      return
    }
    setTestingId(loc._id)
    setTestResult({ id: '', type: '', text: '' })
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 })
      })
      const res = await apiFetch('/api/locations/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      }, token)
      setTestResult({
        id: loc._id,
        type: res.ok ? 'success' : 'error',
        text: res.ok
          ? `Inside ${res.location_name} (${res.distance_meters}m away)`
          : `Outside · Closest: ${res.closest_location} (${res.closest_distance_meters}m)`,
      })
    } catch (err) {
      setTestResult({ id: loc._id, type: 'error', text: err.message || 'Location test failed' })
    } finally {
      setTestingId('')
    }
  }

  function fetchCurrentLocation() {
    if (!navigator.geolocation) { flash('error', 'Geolocation not supported'); return }
    navigator.geolocation.getCurrentPosition(
      pos => {
        setForm(f => ({
          ...f,
          latitude: pos.coords.latitude.toFixed(6),
          longitude: pos.coords.longitude.toFixed(6),
        }))
        flash('success', 'Current location fetched')
      },
      () => flash('error', 'Unable to get location'),
      { enableHighAccuracy: true, timeout: 10000 }
    )
  }

  function flash(type, text) {
    setFeedback({ type, text })
    setTimeout(() => setFeedback({ type: '', text: '' }), 4000)
  }

  return (
    <div className="multi-geofence-manager">
      <div className="multi-geofence-header">
        <div>
          <h3><MapPin size={20} /> Office Locations & Geofences</h3>
          <p className="muted small">Manage multiple office locations. Employees can be assigned to specific locations for attendance validation.</p>
        </div>
        <button type="button" className="bulk-payroll-run-btn" onClick={openCreateForm}>
          <Plus size={15} /> Add Location
        </button>
      </div>

      {feedback.text && (
        <div className={`bulk-payroll-feedback ${feedback.type}`}>
          {feedback.type === 'success' ? <CheckCircle2 size={15} /> : <AlertCircle size={15} />}
          <span>{feedback.text}</span>
        </div>
      )}

      {loading && (
        <div className="table-loading-state"><Loader2 size={16} className="hrms-spin" /><p>Loading locations...</p></div>
      )}

      {!loading && error && <div className="bulk-payroll-feedback error"><AlertCircle size={15} /><span>{error}</span></div>}

      {!loading && !error && !locations.length && (
        <div className="multi-geofence-empty">
          <MapPin size={40} style={{ color: '#94a3b8' }} />
          <h4>No Office Locations</h4>
          <p className="muted">Add your first office location to enable multi-location geofence attendance.</p>
          <button type="button" className="bulk-payroll-run-btn" onClick={openCreateForm}>
            <Plus size={15} /> Add First Location
          </button>
        </div>
      )}

      {!loading && locations.length > 0 && (
        <div className="multi-geofence-grid">
          {locations.map(loc => (
            <div key={loc._id} className={`multi-geofence-card ${loc.is_active !== false ? '' : 'inactive'}`}>
              <div className="multi-geofence-card-header">
                <div className="multi-geofence-card-title">
                  <MapPin size={16} className="text-primary" />
                  <h4>{loc.name}</h4>
                  <span className={`multi-geofence-status-dot ${loc.is_active !== false ? 'active' : 'inactive'}`} />
                </div>
                <div className="multi-geofence-card-actions">
                  <button type="button" className="ghost small" onClick={() => openEditForm(loc)} title="Edit">
                    <Pencil size={13} />
                  </button>
                  <button type="button" className="ghost small danger" onClick={() => handleDelete(loc._id)} disabled={deleting === loc._id} title="Delete">
                    {deleting === loc._id ? <Loader2 size={13} className="hrms-spin" /> : <Trash2 size={13} />}
                  </button>
                </div>
              </div>

              <div className="multi-geofence-card-body">
                {loc.address && <p className="multi-geofence-address">{loc.address}</p>}
                <div className="multi-geofence-details">
                  <div><Navigation size={13} /><span>Lat: {loc.latitude}, Lng: {loc.longitude}</span></div>
                  <div><Shield size={13} /><span>Radius: {loc.radius_meters}m</span></div>
                  <div><Clock3 size={13} /><span>{loc.working_hours?.start || '09:00'} – {loc.working_hours?.end || '18:00'}</span></div>
                  <div><Building2 size={13} /><span>{loc.timezone || 'Asia/Kolkata'}</span></div>
                </div>
                {loc.allowed_departments?.length > 0 && (
                  <div className="multi-geofence-departments">
                    {loc.allowed_departments.map(d => <span key={d} className="multi-geofence-dept-chip">{d}</span>)}
                  </div>
                )}
              </div>

              <div className="multi-geofence-card-footer">
                <button
                  type="button"
                  className="ghost small"
                  onClick={() => testLocation(loc)}
                  disabled={testingId === loc._id}
                >
                  {testingId === loc._id ? <Loader2 size={13} className="hrms-spin" /> : <Navigation size={13} />}
                  {testingId === loc._id ? 'Testing...' : 'Test My Location'}
                </button>
                {testResult.id === loc._id && testResult.text && (
                  <span className={`multi-geofence-test-result ${testResult.type}`}>
                    {testResult.type === 'success' ? <CheckCircle2 size={12} /> : <AlertCircle size={12} />}
                    {testResult.text}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <div className="modal-overlay" onClick={closeForm}>
          <div className="modal-card" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
            <div className="row between">
              <h3>{editingId ? 'Edit Location' : 'Add New Location'}</h3>
              <button type="button" className="ghost" onClick={closeForm}><X size={16} /></button>
            </div>
            <form onSubmit={handleSubmit} className="multi-geofence-form">
              <div className="multi-geofence-form-grid">
                <div className="field full">
                  <label>Location Name *</label>
                  <input placeholder="e.g. Head Office, Branch - Mumbai" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="field full">
                  <label>Address</label>
                  <input placeholder="Full address" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Latitude *</label>
                  <input type="number" step="0.000001" placeholder="28.6139" value={form.latitude} onChange={e => setForm(f => ({ ...f, latitude: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Longitude *</label>
                  <input type="number" step="0.000001" placeholder="77.2090" value={form.longitude} onChange={e => setForm(f => ({ ...f, longitude: e.target.value }))} />
                </div>
                <div className="field full">
                  <button type="button" className="ghost" onClick={fetchCurrentLocation} style={{ marginBottom: 8 }}>
                    <Navigation size={13} /> Use My Current Location
                  </button>
                </div>
                <div className="field">
                  <label>Radius (meters)</label>
                  <input type="number" min="50" max="5000" value={form.radius_meters} onChange={e => setForm(f => ({ ...f, radius_meters: e.target.value }))} />
                  <span className="muted small">Recommended: 100–500m</span>
                </div>
                <div className="field">
                  <label>Timezone</label>
                  <select value={form.timezone} onChange={e => setForm(f => ({ ...f, timezone: e.target.value }))}>
                    <option value="Asia/Kolkata">Asia/Kolkata (IST)</option>
                    <option value="America/New_York">America/New_York (EST)</option>
                    <option value="Europe/London">Europe/London (GMT)</option>
                    <option value="Asia/Dubai">Asia/Dubai (GST)</option>
                    <option value="Asia/Singapore">Asia/Singapore (SGT)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Working Hours Start</label>
                  <input type="time" value={form.working_hours_start} onChange={e => setForm(f => ({ ...f, working_hours_start: e.target.value }))} />
                </div>
                <div className="field">
                  <label>Working Hours End</label>
                  <input type="time" value={form.working_hours_end} onChange={e => setForm(f => ({ ...f, working_hours_end: e.target.value }))} />
                </div>
                <div className="field full">
                  <label className="row" style={{ gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={form.is_active} onChange={e => setForm(f => ({ ...f, is_active: e.target.checked }))} />
                    Location is Active
                  </label>
                </div>
              </div>
              <div className="row modal-actions" style={{ marginTop: 16 }}>
                <button type="button" className="ghost" onClick={closeForm} disabled={saving}>Cancel</button>
                <button type="submit" disabled={saving}>
                  {saving ? <Loader2 size={14} className="hrms-spin" /> : <Save size={14} />}
                  {saving ? 'Saving...' : (editingId ? 'Update Location' : 'Create Location')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
