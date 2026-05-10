import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Laptop,
  Plus,
  RotateCcw,
  ShieldAlert,
  Wrench,
} from 'lucide-react'
import { apiFetch } from '../../api'
import { BASE_URL } from '../../config/apiConfig'
import { USER_KEY } from '../../config/constants'
import './EmployeeAssetsModule.css'

const ASSET_SEED_TYPES = [
  { name: 'Laptop', category: 'Hardware', brandModel: 'Dell Latitude 5440' },
  { name: 'Charger', category: 'Accessory', brandModel: 'Dell 65W USB-C' },
  { name: 'Mouse', category: 'Accessory', brandModel: 'Logitech M590' },
  { name: 'Keyboard', category: 'Accessory', brandModel: 'Logitech K380' },
  { name: 'Monitor', category: 'Hardware', brandModel: 'LG 24MP60G' },
  { name: 'ID Card', category: 'Identity', brandModel: 'Corporate ID v2' },
  { name: 'Access Card', category: 'Identity', brandModel: 'RFID Access Card' },
  { name: 'SIM Card', category: 'Connectivity', brandModel: 'Airtel Corporate SIM' },
  { name: 'Company Phone', category: 'Mobile', brandModel: 'Samsung A55 Enterprise' },
  { name: 'Headset', category: 'Accessory', brandModel: 'Jabra Evolve2 40' },
  { name: 'Office Equipment', category: 'Equipment', brandModel: 'Docking Station' },
  { name: 'Other Assigned Devices', category: 'Other', brandModel: 'Security Token' },
]

const REQUEST_TYPES = [
  { value: 'new_asset', label: 'New Asset' },
  { value: 'replacement', label: 'Replacement' },
  { value: 'repair_request', label: 'Repair Request' },
  { value: 'return_request', label: 'Return Request' },
  { value: 'damage_report', label: 'Damage Report' },
  { value: 'upgrade_request', label: 'Upgrade Request' },
]

const PRIORITY_OPTIONS = ['low', 'medium', 'high', 'critical']

const DRAFT_KEY = 'employee_assets_request_draft_v1'

function statusClass(status) {
  const key = String(status || '').trim().toLowerCase()
  if (['active', 'approved', 'completed'].includes(key)) return 'ok'
  if (['returned'].includes(key)) return 'neutral'
  if (['under_repair', 'pending_return', 'in_progress', 'pending'].includes(key)) return 'warn'
  if (['lost_damaged', 'lost / damaged', 'rejected'].includes(key)) return 'danger'
  return ''
}

function statusLabel(status) {
  return String(status || 'pending').replace(/_/g, ' ')
}

function normalizeAssetRow(row = {}, idx = 0) {
  const id = String(row.id || row.asset_id || `asset_${idx}`)
  const assignedDate = String(row.assigned_date || row.created_at || '').slice(0, 10)
  return {
    id,
    assetName: String(row.asset_name || row.file_name || 'Assigned Asset'),
    assetId: String(row.asset_id || id),
    category: String(row.asset_category || row.file_type || 'other'),
    brandModel: String(row.brand_model || '-'),
    assignedDate: assignedDate || '-',
    returnDueDate: String(row.return_due_date || '-'),
    condition: String(row.asset_condition || 'Good'),
    warrantyStatus: String(row.warranty_status || 'Unknown'),
    assignedBy: String(row.assigned_by || row.uploaded_by || 'Admin'),
    currentStatus: String(row.current_status || 'active').toLowerCase(),
    timeline: Array.isArray(row.timeline) ? row.timeline : (assignedDate ? [{ title: 'Assigned', at: assignedDate }] : []),
    previewUrl: String(row.preview_url || row.file_url || '').trim(),
    fileType: String(row.file_type || '').trim().toLowerCase(),
  }
}

function resolvePreviewUrl(url = '') {
  const raw = String(url || '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  if (!raw.startsWith('/')) return raw

  const base = String(BASE_URL || '').trim().replace(/\/+$/, '')
  const originUrl = `${base || ''}${raw}`

  if (raw.startsWith('/user/assets/files/')) {
    try {
      const token = localStorage.getItem(USER_KEY) || ''
      if (token) {
        const glue = originUrl.includes('?') ? '&' : '?'
        return `${originUrl}${glue}token=${encodeURIComponent(token)}`
      }
    } catch {
      // no-op
    }
  }
  return originUrl || raw
}

function readDraft() {
  try {
    const raw = localStorage.getItem(DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function saveDraft(payload) {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(payload || {}))
  } catch {
    // no-op
  }
}

export default function EmployeeAssetsModule({ employee, activeItem = 'assets-my' }) {
  const [assets, setAssets] = useState([])
  const [loadingAssets, setLoadingAssets] = useState(false)
  const [requestHistory, setRequestHistory] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [submitting, setSubmitting] = useState(false)
  const currentAssetsView = activeItem === 'assets-requests' ? 'requests' : 'my'
  const showMyAssets = currentAssetsView === 'my'
  const showAssetRequests = currentAssetsView === 'requests'

  const [form, setForm] = useState(() => {
    const draft = readDraft()
    return {
      requestType: String(draft?.requestType || 'new_asset'),
      assetCategory: String(draft?.assetCategory || 'Laptop'),
      assetName: String(draft?.assetName || ''),
      priority: String(draft?.priority || 'medium'),
      reason: String(draft?.reason || ''),
      urgencyNote: String(draft?.urgencyNote || ''),
      uploadFile: null,
      uploadFileName: '',
      linkedAssetId: String(draft?.linkedAssetId || ''),
      workflowAction: String(draft?.workflowAction || ''),
    }
  })

  async function loadHistory() {
    setLoadingHistory(true)
    try {
      const rows = await apiFetch('/user/asset_requests')
      setRequestHistory(Array.isArray(rows) ? rows : [])
      setNotice({ type: '', text: '' })
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to load asset request history.' })
      setRequestHistory([])
    } finally {
      setLoadingHistory(false)
    }
  }

  async function loadAssets() {
    setLoadingAssets(true)
    try {
      const rows = await apiFetch('/user/assets')
      const normalized = (Array.isArray(rows) ? rows : []).map((row, idx) => normalizeAssetRow(row, idx))
      setAssets(normalized)
    } catch (err) {
      setAssets([])
      setNotice((old) => {
        if (old?.text) return old
        return { type: 'error', text: err?.message || 'Unable to load assigned assets.' }
      })
    } finally {
      setLoadingAssets(false)
    }
  }

  useEffect(() => {
    loadAssets()
    loadHistory()
  }, [])

  function applyDraftSave() {
    saveDraft({
      requestType: form.requestType,
      assetCategory: form.assetCategory,
      assetName: form.assetName,
      priority: form.priority,
      reason: form.reason,
      urgencyNote: form.urgencyNote,
      linkedAssetId: form.linkedAssetId,
      workflowAction: form.workflowAction,
    })
    setNotice({ type: 'success', text: 'Draft saved successfully.' })
  }

  async function submitRequest() {
    const reason = String(form.reason || '').trim()
    if (!reason) {
      setNotice({ type: 'error', text: 'Reason is required.' })
      return
    }

    setSubmitting(true)
    try {
      const payload = new FormData()
      payload.append('request_type', form.requestType)
      payload.append('asset_category', form.assetCategory)
      payload.append('asset_name', form.assetName)
      payload.append('priority', form.priority)
      payload.append('reason', reason)
      payload.append('urgency_note', form.urgencyNote)
      payload.append('linked_asset_id', form.linkedAssetId)
      payload.append('workflow_action', form.workflowAction)
      payload.append('source', form.requestType === 'damage_report' ? 'asset_damage' : (form.requestType === 'return_request' ? 'asset_return' : 'asset_request'))
      if (form.uploadFile) payload.append('attachment', form.uploadFile)

      await apiFetch('/user/asset_requests', {
        method: 'POST',
        body: payload,
      })

      localStorage.removeItem(DRAFT_KEY)
      setForm({
        requestType: 'new_asset',
        assetCategory: 'Laptop',
        assetName: '',
        priority: 'medium',
        reason: '',
        urgencyNote: '',
        uploadFile: null,
        uploadFileName: '',
        linkedAssetId: '',
        workflowAction: '',
      })
      setNotice({ type: 'success', text: 'Asset request submitted and synced to Admin workflow.' })
      await loadHistory()
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to submit asset request.' })
    } finally {
      setSubmitting(false)
    }
  }

  function useDamageTemplate(assetName, category, reason) {
    setForm((old) => ({
      ...old,
      requestType: 'damage_report',
      assetName,
      assetCategory: category,
      reason,
      priority: old.priority === 'low' ? 'medium' : old.priority,
      workflowAction: 'mark_repair',
    }))
    setNotice({ type: 'success', text: 'Damage report template applied.' })
  }

  function useReturnTemplate(reasonText) {
    setForm((old) => ({
      ...old,
      requestType: 'return_request',
      reason: reasonText,
      workflowAction: 'pending_return',
    }))
    setNotice({ type: 'success', text: 'Return request template applied.' })
  }

  const summary = useMemo(() => {
    const active = assets.filter((a) => String(a.currentStatus).toLowerCase() === 'active').length
    const underRepair = assets.filter((a) => String(a.currentStatus).toLowerCase() === 'under_repair').length
    const pendingReturn = assets.filter((a) => String(a.currentStatus).toLowerCase() === 'pending_return').length
    const lostDamaged = assets.filter((a) => ['lost_damaged', 'lost / damaged'].includes(String(a.currentStatus).toLowerCase())).length
    return {
      total: assets.length,
      active,
      underRepair,
      pendingReturn,
      lostDamaged,
    }
  }, [assets])

  const assignedAssetOptions = useMemo(
    () => assets.map((row) => ({
      id: row.assetId,
      label: `${row.assetName} (${row.assetId})`,
    })),
    [assets],
  )

  const timelineRows = useMemo(() => {
    const fromAssets = assets.flatMap((asset) => (asset.timeline || []).map((row, idx) => ({
      id: `${asset.assetId}_${idx}`,
      at: row.at,
      title: row.title,
      detail: `${asset.assetName} (${asset.assetId})`,
    })))

    const fromRequests = (requestHistory || []).map((row) => ({
      id: String(row.id || Math.random()),
      at: String(row.updated_at || row.created_at || '').slice(0, 10),
      title: statusLabel(row.status || 'pending'),
      detail: `${statusLabel(row.asset_request_type || row.request_type || 'request')} · ${row.asset_name || row.asset_category || '-'}`,
    }))

    return [...fromAssets, ...fromRequests]
      .filter((row) => row.at)
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
      .slice(0, 14)
  }, [assets, requestHistory])

  return (
    <section className="employee-assets-shell">
      <section className="employee-assets-summary-grid" id="employee-assets-my-section">
        <article className="card employee-assets-summary-card">
          <p>Total Assigned Assets</p>
          <strong>{summary.total}</strong>
        </article>
        <article className="card employee-assets-summary-card">
          <p>Active</p>
          <strong>{summary.active}</strong>
        </article>
        <article className="card employee-assets-summary-card">
          <p>Under Repair</p>
          <strong>{summary.underRepair}</strong>
        </article>
        <article className="card employee-assets-summary-card">
          <p>Pending Return</p>
          <strong>{summary.pendingReturn}</strong>
        </article>
      </section>

      {notice.text && (
        <p className={notice.type === 'error' ? 'error' : 'success'} style={{ margin: 0 }}>{notice.text}</p>
      )}

      {showMyAssets && (
      <article className="card employee-assets-table-card">
        <div className="employee-assets-title-row">
          <h3>My Assets</h3>
          <span className="muted small">Enterprise asset visibility with lifecycle tracking</span>
        </div>
        <div className="employee-assets-table-wrap">
          <table className="employee-assets-table employee-assets-table-my">
            <thead>
              <tr>
                <th>Preview</th>
                <th>Asset Name</th>
                <th>Asset ID</th>
                <th>Category</th>
                <th>Brand / Model</th>
                <th>Assigned Date</th>
                <th>Return Due Date</th>
                <th>Asset Condition</th>
                <th>Warranty Status</th>
                <th>Assigned By</th>
                <th>Current Status</th>
              </tr>
            </thead>
            <tbody>
              {loadingAssets && (
                <tr>
                  <td colSpan={10}>Loading assigned assets...</td>
                </tr>
              )}
              {assets.map((row) => (
                <tr key={row.id}>
                  <td>
                    {row.fileType === 'image' && row.previewUrl ? (
                      <img
                        src={resolvePreviewUrl(row.previewUrl)}
                        alt={row.assetName}
                        className="employee-asset-thumb"
                        loading="lazy"
                      />
                    ) : (
                      <span className="employee-asset-thumb-fallback">{row.fileType || 'file'}</span>
                    )}
                  </td>
                  <td>{row.assetName}</td>
                  <td>{row.assetId}</td>
                  <td>{row.category}</td>
                  <td>{row.brandModel}</td>
                  <td>{row.assignedDate}</td>
                  <td>{row.returnDueDate}</td>
                  <td>{row.condition}</td>
                  <td>{row.warrantyStatus}</td>
                  <td>{row.assignedBy}</td>
                  <td><span className={`status-badge ${statusClass(row.currentStatus)}`}>{statusLabel(row.currentStatus)}</span></td>
                </tr>
              ))}
              {!loadingAssets && !assets.length && (
                <tr>
                  <td colSpan={11}>No assigned assets found for your account.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>
      )}

      {showAssetRequests && (
      <section className="employee-assets-bottom-grid" id="employee-assets-requests-section">
        <article className="card employee-assets-request-card">
          <h3>Asset Requests</h3>
          <p className="muted">Submit new, replacement, repair, return, damage, or upgrade requests with workflow sync to Admin panel.</p>

          <div className="employee-assets-assigned-inline">
            <p className="employee-assets-assigned-title">Assigned Items</p>
            <div className="employee-assets-assigned-list">
              {assignedAssetOptions.map((item) => (
                <span key={item.id} className="status-badge">{item.label}</span>
              ))}
              {!assignedAssetOptions.length && (
                <span className="muted small">No assigned items yet.</span>
              )}
            </div>
          </div>

          <div className="employee-assets-form-grid">
            <label>
              <span>Request Type</span>
              <select value={form.requestType} onChange={(e) => setForm((old) => ({ ...old, requestType: e.target.value }))}>
                {REQUEST_TYPES.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
              </select>
            </label>
            <label>
              <span>Asset Category</span>
              <select value={form.assetCategory} onChange={(e) => setForm((old) => ({ ...old, assetCategory: e.target.value }))}>
                {ASSET_SEED_TYPES.map((opt) => <option key={opt.name} value={opt.name}>{opt.name}</option>)}
              </select>
            </label>
            <label>
              <span>Asset Name</span>
              <input value={form.assetName} onChange={(e) => setForm((old) => ({ ...old, assetName: e.target.value }))} placeholder="Enter asset name" />
            </label>
            <label>
              <span>Linked Asset ID (if any)</span>
              <select value={form.linkedAssetId} onChange={(e) => setForm((old) => ({ ...old, linkedAssetId: e.target.value }))}>
                <option value="">Optional linked asset id</option>
                {assignedAssetOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>{opt.label}</option>
                ))}
              </select>
            </label>
            <label>
              <span>Priority Level</span>
              <select value={form.priority} onChange={(e) => setForm((old) => ({ ...old, priority: e.target.value }))}>
                {PRIORITY_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
              </select>
            </label>
            <label>
              <span>Workflow Action (optional)</span>
              <select value={form.workflowAction} onChange={(e) => setForm((old) => ({ ...old, workflowAction: e.target.value }))}>
                <option value="">Select action</option>
                <option value="assign_replacement">Assign Replacement</option>
                <option value="mark_repair">Mark Repair</option>
                <option value="pending_return">Pending Return</option>
              </select>
            </label>
            <label className="employee-assets-full-row">
              <span>Reason</span>
              <textarea rows={3} value={form.reason} onChange={(e) => setForm((old) => ({ ...old, reason: e.target.value }))} placeholder="Write reason for request" />
            </label>
            <label className="employee-assets-full-row">
              <span>Urgency Note</span>
              <textarea rows={2} value={form.urgencyNote} onChange={(e) => setForm((old) => ({ ...old, urgencyNote: e.target.value }))} placeholder="Optional urgency details" />
            </label>
            <label className="employee-assets-full-row employee-assets-upload-label">
              <span>Upload Supporting Image (optional)</span>
              <input
                type="file"
                accept="image/*"
                onChange={(e) => {
                  const file = e.target.files?.[0] || null
                  setForm((old) => ({ ...old, uploadFile: file, uploadFileName: file?.name || '' }))
                }}
              />
              {!!form.uploadFileName && <small className="muted">Selected: {form.uploadFileName}</small>}
            </label>
          </div>

          <div className="employee-assets-form-actions">
            <button type="button" onClick={submitRequest} disabled={submitting}>{submitting ? 'Submitting...' : 'Submit Request'}</button>
            <button type="button" className="ghost" onClick={applyDraftSave}>Save Draft</button>
          </div>

          <div className="employee-assets-quick-grid">
            <article className="employee-assets-quick-card" onClick={() => useDamageTemplate('Laptop', 'Laptop', 'Laptop screen issue - flickering and dead pixels observed.')}
              role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') useDamageTemplate('Laptop', 'Laptop', 'Laptop screen issue - flickering and dead pixels observed.') }}>
              <ShieldAlert size={16} />
              <div>
                <p>Damage Reporting</p>
                <small>Laptop screen issue, keyboard damaged, ID card lost</small>
              </div>
            </article>
            <article className="employee-assets-quick-card" onClick={() => useDamageTemplate('Keyboard', 'Keyboard', 'Keyboard damaged - key response issue.')}
              role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') useDamageTemplate('Keyboard', 'Keyboard', 'Keyboard damaged - key response issue.') }}>
              <Wrench size={16} />
              <div>
                <p>Repair Request</p>
                <small>Mouse not working, monitor issue, SIM not working</small>
              </div>
            </article>
            <article className="employee-assets-quick-card" onClick={() => useReturnTemplate('Return request due to role transfer / department change.')}
              role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') useReturnTemplate('Return request due to role transfer / department change.') }}>
              <RotateCcw size={16} />
              <div>
                <p>Return Workflow</p>
                <small>Resignation, transfer, replacement return confirmation</small>
              </div>
            </article>
          </div>
        </article>

        <article className="card employee-assets-history-card">
          <h3>Asset Request History</h3>
          <div className="employee-assets-table-wrap">
            <table className="employee-assets-table employee-assets-table-history">
              <thead>
                <tr>
                  <th>Request Date</th>
                  <th>Request Type</th>
                  <th>Asset Name</th>
                  <th>Status</th>
                  <th>Admin Remarks</th>
                  <th>Approved By</th>
                  <th>Expected Resolution Date</th>
                </tr>
              </thead>
              <tbody>
                {loadingHistory && (
                  <tr>
                    <td colSpan={7}>Loading requests...</td>
                  </tr>
                )}
                {!loadingHistory && requestHistory.map((row) => (
                  <tr key={row.id}>
                    <td>{String(row.created_at || row.requested_at || '').slice(0, 10) || '-'}</td>
                    <td>{statusLabel(row.asset_request_type || row.request_type || '-')}</td>
                    <td>{row.asset_name || row.asset_category || '-'}</td>
                    <td><span className={`status-badge ${statusClass(row.status)}`}>{statusLabel(row.status)}</span></td>
                    <td>{row.admin_remarks || row.review_comment || '-'}</td>
                    <td>{row.approved_by || '-'}</td>
                    <td>{row.expected_resolution_date || '-'}</td>
                  </tr>
                ))}
                {!loadingHistory && !requestHistory.length && (
                  <tr>
                    <td colSpan={7}>No asset requests yet.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </article>
      </section>
      )}

      <article className="card employee-assets-timeline-card">
        <div className="employee-assets-title-row">
          <h3>Asset Timeline</h3>
          <span className="muted small">Assigned · Repaired · Replaced · Returned</span>
        </div>
        <div className="employee-assets-timeline-list">
          {timelineRows.map((row) => (
            <article key={row.id} className="employee-assets-timeline-item">
              <span className="employee-assets-timeline-dot" aria-hidden="true" />
              <div>
                <p>{row.title}</p>
                <small className="muted">{row.detail}</small>
              </div>
              <strong>{row.at}</strong>
            </article>
          ))}
          {!timelineRows.length && (
            <p className="muted small" style={{ margin: 0 }}>No timeline events yet.</p>
          )}
        </div>
      </article>

      <div className="employee-assets-footer-badges">
        <span className="status-badge ok"><CheckCircle2 size={14} /> Workflow synced with admin queue</span>
        <span className="status-badge warn"><Clock3 size={14} /> Track approvals and resolution ETA</span>
        <span className="status-badge"><Laptop size={14} /> Corporate asset lifecycle transparency</span>
        <span className="status-badge danger"><AlertTriangle size={14} /> Report lost/damaged assets instantly</span>
        <span className="status-badge"><Plus size={14} /> Raise new or upgrade requests quickly</span>
      </div>
    </section>
  )
}
