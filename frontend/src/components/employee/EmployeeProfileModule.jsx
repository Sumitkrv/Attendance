import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Camera,
  Download,
  Eye,
  FileText,
  History,
  Lock,
  Mail,
  Shield,
  Upload,
  UserCircle2,
} from 'lucide-react'
import './EmployeeProfileModule.css'

const DOC_BLUEPRINT = [
  { id: 'aadhaar', title: 'Aadhaar Card', editable: true },
  { id: 'pan', title: 'PAN Card', editable: true },
  { id: 'offer_letter', title: 'Offer Letter', editable: false },
  { id: 'joining_letter', title: 'Joining Letter', editable: false },
  { id: 'salary_documents', title: 'Salary Documents', editable: true },
  { id: 'experience_letter', title: 'Experience Letter', editable: true },
  { id: 'id_card', title: 'ID Card', editable: false },
  { id: 'education', title: 'Educational Certificates', editable: true },
  { id: 'other', title: 'Other Company Documents', editable: true },
]

function profileStorageKey(employeeId, area) {
  return `employee_profile_${area}_v1_${String(employeeId || 'self')}`
}

function readJson(storageKey, fallbackValue) {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return fallbackValue
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : fallbackValue
  } catch {
    return fallbackValue
  }
}

function buildInitialProfile(employee = {}) {
  const fullName = String(employee?.name || 'Employee')
  const employeeId = String(employee?.emp_id || employee?.employee_id || employee?.id || 'HRMS-0000')
  const officialEmail = String(employee?.official_email || employee?.email || '')
  const phone = String(employee?.mobile || employee?.phone || employee?.phone_number || '')
  const joiningDateRaw = String(employee?.date_of_joining || employee?.join_date || employee?.joining_date || '')
  const joiningDate = joiningDateRaw && /^\d{4}-\d{2}-\d{2}$/.test(joiningDateRaw)
    ? joiningDateRaw
    : ''

  return {
    basic: {
      fullName,
      employeeId,
      department: String(employee?.department || 'Engineering'),
      designation: String(employee?.designation || 'Software Engineer'),
      reportingManager: String(employee?.reporting_manager || employee?.manager_name || ''),
      joiningDate,
      employmentType: String(employee?.employment_type || 'Full-time'),
      workLocation: String(employee?.company_name || employee?.work_location || ''),
      gender: String(employee?.gender || ''),
      bloodGroup: String(employee?.blood_group || ''),
      maritalStatus: String(employee?.marital_status || ''),
      fatherName: String(employee?.father_name || ''),
      dob: String(employee?.dob || ''),
    },
    contact: {
      personalEmail: String(employee?.personal_email || ''),
      officialEmail,
      phoneNumber: phone,
      alternateContactNumber: String(employee?.emergency_contact_phone || employee?.alternate_phone || ''),
      currentAddress: String(employee?.current_address || ''),
      permanentAddress: String(employee?.permanent_address || ''),
    },
    emergency: {
      name: String(employee?.emergency_contact_name || ''),
      relationship: String(employee?.emergency_relationship || ''),
      contactNumber: String(employee?.emergency_contact_phone || employee?.emergency_contact_number || ''),
    },
    bank: {
      bankName: String(employee?.bank_name || ''),
      accountNumber: String(employee?.bank_account_no || employee?.account_number || ''),
      ifscCode: String(employee?.bank_ifsc || employee?.ifsc_code || ''),
      panNumber: String(employee?.pan_number || ''),
      aadhaarNumber: String(employee?.aadhaar_number || ''),
    },
    timeline: [
      {
        id: 'join',
        title: 'Joined Company',
        detail: `Joined as ${String(employee?.designation || 'Software Engineer')}`,
        date: joiningDate,
      },
      {
        id: 'dept-update',
        title: 'Department Update',
        detail: `Moved to ${String(employee?.department || 'Engineering')} operations`,
        date: '2024-06-18',
      },
      {
        id: 'role-update',
        title: 'Role Update',
        detail: 'Role scope updated for delivery ownership',
        date: '2025-01-12',
      },
      {
        id: 'promotion',
        title: 'Promotion',
        detail: 'Promoted to Senior Software Engineer',
        date: '2025-11-01',
      },
    ],
  }
}

function buildInitialDocuments() {
  const nowIso = new Date().toISOString()
  return DOC_BLUEPRINT.reduce((acc, doc) => {
    acc[doc.id] = {
      id: doc.id,
      title: doc.title,
      editable: !!doc.editable,
      uploaded: false,
      fileName: '',
      fileType: '',
      fileSize: '',
      lastUpdatedAt: nowIso,
      objectUrl: '',
    }
    return acc
  }, {})
}

function bytesLabel(size) {
  const n = Number(size || 0)
  if (!Number.isFinite(n) || n <= 0) return '-'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

function isImageType(fileType = '', fileName = '') {
  const t = String(fileType || '').toLowerCase()
  if (t.startsWith('image/')) return true
  return /\.(png|jpg|jpeg|webp|gif|bmp|svg)$/i.test(String(fileName || ''))
}

export default function EmployeeProfileModule({
  employee,
  onPasswordChange,
  onEmployeePatch,
}) {
  const employeeId = String(employee?.employee_id || employee?.id || 'self')
  const defaults = useMemo(() => buildInitialProfile(employee), [employee])

  const [profileData, setProfileData] = useState(() => {
    const stored = readJson(profileStorageKey(employeeId, 'data'), null)
    return stored || defaults
  })
  const [documents, setDocuments] = useState(() => {
    const stored = readJson(profileStorageKey(employeeId, 'documents'), null)
    return stored || buildInitialDocuments()
  })
  const [security, setSecurity] = useState(() => {
    const stored = readJson(profileStorageKey(employeeId, 'security'), null)
    return stored || {
      loginEmail: profileData?.contact?.officialEmail || String(employee?.email || ''),
      twoFactorEnabled: false,
      twoFactorMethod: 'authenticator_app',
      lastLogin: {
        at: new Date().toISOString(),
        ip: '192.168.0.14',
        location: 'Bengaluru, IN',
        device: 'MacBook Pro · Chrome',
      },
      loginActivity: [
        { id: 'l1', at: new Date().toISOString(), action: 'Successful Login', ip: '192.168.0.14', status: 'success' },
        { id: 'l2', at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), action: 'Password Verification', ip: '192.168.0.14', status: 'success' },
        { id: 'l3', at: new Date(Date.now() - 26 * 3600 * 1000).toISOString(), action: 'Failed Login Attempt', ip: '10.0.0.8', status: 'blocked' },
      ],
      deviceHistory: [
        { id: 'd1', device: 'MacBook Pro · Chrome', location: 'Bengaluru, IN', lastActiveAt: new Date().toISOString(), current: true },
        { id: 'd2', device: 'iPhone 15 · Safari', location: 'Bengaluru, IN', lastActiveAt: new Date(Date.now() - 86400 * 1000).toISOString(), current: false },
      ],
    }
  })

  const [contactDraft, setContactDraft] = useState(profileData.contact)
  const [emergencyDraft, setEmergencyDraft] = useState(profileData.emergency)
  const [contactEditing, setContactEditing] = useState(false)
  const [emergencyEditing, setEmergencyEditing] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })

  const [avatarUrl, setAvatarUrl] = useState(() => String(employee?.avatar_url || ''))
  const [avatarName, setAvatarName] = useState(() => String(employee?.avatar_name || ''))
  const avatarUrlRef = useRef('')

  const [previewModal, setPreviewModal] = useState({ open: false, title: '', fileName: '', fileType: '', url: '' })
  const uploadUrlRef = useRef({})

  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '', confirmPassword: '' })
  const [passwordLoading, setPasswordLoading] = useState(false)

  useEffect(() => {
    if (!employee?.id && !employee?.employee_id) return
    const nextDefaults = buildInitialProfile(employee)
    setProfileData((old) => ({ ...nextDefaults, ...(old || {}) }))
  }, [employee])

  useEffect(() => {
    setContactDraft(profileData.contact)
  }, [profileData.contact])

  useEffect(() => {
    setEmergencyDraft(profileData.emergency)
  }, [profileData.emergency])

  useEffect(() => {
    localStorage.setItem(profileStorageKey(employeeId, 'data'), JSON.stringify(profileData))
  }, [employeeId, profileData])

  useEffect(() => {
    const persisted = Object.fromEntries(
      Object.entries(documents || {}).map(([id, value]) => [id, { ...value, objectUrl: '' }]),
    )
    localStorage.setItem(profileStorageKey(employeeId, 'documents'), JSON.stringify(persisted))
  }, [employeeId, documents])

  useEffect(() => {
    localStorage.setItem(profileStorageKey(employeeId, 'security'), JSON.stringify(security))
  }, [employeeId, security])

  useEffect(() => (() => {
    if (avatarUrlRef.current && avatarUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(avatarUrlRef.current)
    }
    Object.values(uploadUrlRef.current).forEach((url) => {
      if (url && String(url).startsWith('blob:')) {
        URL.revokeObjectURL(url)
      }
    })
  }), [])

  function updateNotice(type, text) {
    setNotice({ type: String(type || ''), text: String(text || '') })
  }

  function handleSaveContact() {
    setProfileData((old) => ({ ...old, contact: { ...contactDraft } }))
    setContactEditing(false)
    updateNotice('success', 'Contact information updated successfully.')
  }

  function handleSaveEmergency() {
    setProfileData((old) => ({ ...old, emergency: { ...emergencyDraft } }))
    setEmergencyEditing(false)
    updateNotice('success', 'Emergency contact updated successfully.')
  }

  function onAvatarChange(file) {
    if (!file) return
    const objectUrl = URL.createObjectURL(file)
    if (avatarUrlRef.current && avatarUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(avatarUrlRef.current)
    }
    avatarUrlRef.current = objectUrl
    setAvatarUrl(objectUrl)
    setAvatarName(file.name)
    updateNotice('success', 'Profile picture updated.')
    onEmployeePatch?.({ avatar_url: objectUrl, avatar_name: file.name })
  }

  function removeAvatar() {
    if (avatarUrlRef.current && avatarUrlRef.current.startsWith('blob:')) {
      URL.revokeObjectURL(avatarUrlRef.current)
    }
    avatarUrlRef.current = ''
    setAvatarUrl('')
    setAvatarName('')
    updateNotice('success', 'Profile picture removed.')
    onEmployeePatch?.({ avatar_url: '', avatar_name: '' })
  }

  function updateDocument(docId, file) {
    if (!docId || !file) return
    const oldUrl = uploadUrlRef.current[docId]
    if (oldUrl && String(oldUrl).startsWith('blob:')) {
      URL.revokeObjectURL(oldUrl)
    }
    const objectUrl = URL.createObjectURL(file)
    uploadUrlRef.current[docId] = objectUrl
    setDocuments((old) => ({
      ...old,
      [docId]: {
        ...(old?.[docId] || {}),
        uploaded: true,
        fileName: file.name,
        fileType: file.type,
        fileSize: bytesLabel(file.size),
        lastUpdatedAt: new Date().toISOString(),
        objectUrl,
      },
    }))
    updateNotice('success', 'Document uploaded successfully.')
  }

  function removeDocument(docId) {
    const oldUrl = uploadUrlRef.current[docId]
    if (oldUrl && String(oldUrl).startsWith('blob:')) {
      URL.revokeObjectURL(oldUrl)
    }
    uploadUrlRef.current[docId] = ''
    setDocuments((old) => ({
      ...old,
      [docId]: {
        ...(old?.[docId] || {}),
        uploaded: false,
        fileName: '',
        fileType: '',
        fileSize: '',
        objectUrl: '',
        lastUpdatedAt: new Date().toISOString(),
      },
    }))
    updateNotice('success', 'Document removed.')
  }

  function openPreview(doc) {
    if (!doc?.objectUrl) {
      updateNotice('error', 'No file available for preview.')
      return
    }
    setPreviewModal({
      open: true,
      title: doc.title,
      fileName: doc.fileName,
      fileType: doc.fileType,
      url: doc.objectUrl,
    })
  }

  function downloadDocument(doc) {
    if (!doc?.objectUrl) {
      updateNotice('error', 'No file available for download.')
      return
    }
    const anchor = document.createElement('a')
    anchor.href = doc.objectUrl
    anchor.download = doc.fileName || `${doc.id || 'document'}`
    anchor.click()
  }

  async function handlePasswordUpdate() {
    const currentPassword = String(passwordForm.currentPassword || '')
    const newPassword = String(passwordForm.newPassword || '')
    const confirmPassword = String(passwordForm.confirmPassword || '')

    if (!currentPassword || !newPassword || !confirmPassword) {
      updateNotice('error', 'All password fields are required.')
      return
    }
    if (newPassword !== confirmPassword) {
      updateNotice('error', 'New password and confirm password must match.')
      return
    }

    try {
      setPasswordLoading(true)
      if (onPasswordChange) {
        await onPasswordChange(currentPassword, newPassword)
      }
      setPasswordForm({ currentPassword: '', newPassword: '', confirmPassword: '' })
      updateNotice('success', 'Password updated successfully.')
    } catch (err) {
      updateNotice('error', err?.message || 'Unable to update password right now.')
    } finally {
      setPasswordLoading(false)
    }
  }

  function updateSecurityEmail() {
    const next = String(security.loginEmail || '').trim()
    if (!next || !next.includes('@')) {
      updateNotice('error', 'Enter a valid login email.')
      return
    }
    setSecurity((old) => ({ ...old, loginEmail: next }))
    updateNotice('success', 'Login email updated successfully.')
  }

  const summaryName = String(profileData?.basic?.fullName || 'Employee')
  const summaryRole = `${profileData?.basic?.designation || 'Employee'} • ${profileData?.basic?.department || 'Department'}`
  const summaryAvatar = avatarUrl || ''
  const documentsList = DOC_BLUEPRINT.map((doc) => ({ ...doc, ...(documents?.[doc.id] || {}) }))

  return (
    <section className="employee-profile-shell">
      <article className="card employee-profile-summary" id="employee-profile-personal-section">
        <div className="employee-profile-avatar-wrap">
          {summaryAvatar ? (
            <img src={summaryAvatar} alt="Profile" className="employee-profile-avatar" />
          ) : (
            <div className="employee-profile-avatar employee-profile-avatar-fallback">
              {summaryName.slice(0, 1).toUpperCase()}
            </div>
          )}
        </div>

        <div className="employee-profile-summary-main">
          <h3>{summaryName}</h3>
          <p className="muted">{summaryRole}</p>
          <div className="employee-profile-summary-tags">
            <span className="status-badge">Employee ID: {profileData.basic.employeeId}</span>
            <span className="status-badge">Joining: {profileData.basic.joiningDate}</span>
            <span className="status-badge">Location: {profileData.basic.workLocation}</span>
          </div>
        </div>

        <div className="employee-profile-avatar-actions">
          <label className="employee-profile-action-btn">
            <Camera size={15} />
            <span>{summaryAvatar ? 'Edit Photo' : 'Upload Photo'}</span>
            <input type="file" accept="image/*" onChange={(e) => onAvatarChange(e.target.files?.[0])} />
          </label>
          <button type="button" className="ghost" onClick={removeAvatar} disabled={!summaryAvatar}>Remove</button>
          {!!avatarName && <p className="muted small">{avatarName}</p>}
        </div>
      </article>

      {notice.text && (
        <p className={notice.type === 'error' ? 'error' : 'success'} style={{ margin: 0 }}>{notice.text}</p>
      )}

      <section className="employee-profile-grid">
        <article className="card employee-profile-card">
          <div className="employee-profile-card-title">
            <UserCircle2 size={18} />
            <h4>Basic Information (Admin Controlled)</h4>
          </div>
          <div className="employee-profile-fields-grid">
            <label><span>Full Name</span><input value={profileData.basic.fullName} disabled /></label>
            <label><span>Employee ID</span><input value={profileData.basic.employeeId} disabled /></label>
            <label><span>Designation</span><input value={profileData.basic.designation} disabled /></label>
            <label><span>Department</span><input value={profileData.basic.department} disabled /></label>
            <label><span>Employment Type</span><input value={profileData.basic.employmentType} disabled /></label>
            <label><span>Company</span><input value={profileData.basic.workLocation} disabled /></label>
            <label><span>Joining Date</span><input value={profileData.basic.joiningDate || '—'} disabled /></label>
            <label><span>Reporting Manager</span><input value={profileData.basic.reportingManager || '—'} disabled /></label>
            <label><span>Date of Birth</span><input value={profileData.basic.dob || '—'} disabled /></label>
            <label><span>Gender</span><input value={profileData.basic.gender || '—'} disabled /></label>
            <label><span>Blood Group</span><input value={profileData.basic.bloodGroup || '—'} disabled /></label>
            <label><span>Marital Status</span><input value={profileData.basic.maritalStatus || '—'} disabled /></label>
            <label><span>Father's Name</span><input value={profileData.basic.fatherName || '—'} disabled /></label>
          </div>
        </article>

        <article className="card employee-profile-card">
          <div className="employee-profile-card-title">
            <Mail size={18} />
            <h4>Contact Information (Employee Editable)</h4>
          </div>
          <div className="employee-profile-fields-grid">
            <label>
              <span>Personal Email</span>
              <input
                value={contactDraft.personalEmail || ''}
                disabled={!contactEditing}
                onChange={(e) => setContactDraft((old) => ({ ...old, personalEmail: e.target.value }))}
              />
            </label>
            <label>
              <span>Official Email</span>
              <input value={contactDraft.officialEmail || ''} disabled />
            </label>
            <label>
              <span>Phone Number</span>
              <input
                value={contactDraft.phoneNumber || ''}
                disabled={!contactEditing}
                onChange={(e) => setContactDraft((old) => ({ ...old, phoneNumber: e.target.value }))}
              />
            </label>
            <label>
              <span>Alternate Contact Number</span>
              <input
                value={contactDraft.alternateContactNumber || ''}
                disabled={!contactEditing}
                onChange={(e) => setContactDraft((old) => ({ ...old, alternateContactNumber: e.target.value }))}
              />
            </label>
            <label className="employee-profile-full-row">
              <span>Current Address</span>
              <textarea
                rows={2}
                value={contactDraft.currentAddress || ''}
                disabled={!contactEditing}
                onChange={(e) => setContactDraft((old) => ({ ...old, currentAddress: e.target.value }))}
              />
            </label>
            <label className="employee-profile-full-row">
              <span>Permanent Address</span>
              <textarea
                rows={2}
                value={contactDraft.permanentAddress || ''}
                disabled={!contactEditing}
                onChange={(e) => setContactDraft((old) => ({ ...old, permanentAddress: e.target.value }))}
              />
            </label>
          </div>
          <div className="employee-profile-card-actions">
            {!contactEditing ? (
              <button type="button" onClick={() => setContactEditing(true)}>Edit Contact Info</button>
            ) : (
              <>
                <button type="button" onClick={handleSaveContact}>Save Contact Info</button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setContactDraft(profileData.contact)
                    setContactEditing(false)
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </article>

        <article className="card employee-profile-card">
          <div className="employee-profile-card-title">
            <Shield size={18} />
            <h4>Emergency Contact (Employee Editable)</h4>
          </div>
          <div className="employee-profile-fields-grid">
            <label>
              <span>Emergency Contact Name</span>
              <input
                value={emergencyDraft.name || ''}
                disabled={!emergencyEditing}
                onChange={(e) => setEmergencyDraft((old) => ({ ...old, name: e.target.value }))}
              />
            </label>
            <label>
              <span>Relationship</span>
              <input
                value={emergencyDraft.relationship || ''}
                disabled={!emergencyEditing}
                onChange={(e) => setEmergencyDraft((old) => ({ ...old, relationship: e.target.value }))}
              />
            </label>
            <label>
              <span>Contact Number</span>
              <input
                value={emergencyDraft.contactNumber || ''}
                disabled={!emergencyEditing}
                onChange={(e) => setEmergencyDraft((old) => ({ ...old, contactNumber: e.target.value }))}
              />
            </label>
          </div>
          <div className="employee-profile-card-actions">
            {!emergencyEditing ? (
              <button type="button" onClick={() => setEmergencyEditing(true)}>Edit Emergency Contact</button>
            ) : (
              <>
                <button type="button" onClick={handleSaveEmergency}>Save Emergency Contact</button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setEmergencyDraft(profileData.emergency)
                    setEmergencyEditing(false)
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </div>
        </article>

        <article className="card employee-profile-card">
          <div className="employee-profile-card-title">
            <Lock size={18} />
            <h4>Bank & Identity Details (Admin Controlled)</h4>
          </div>
          <div className="employee-profile-fields-grid">
            <label><span>Bank Name</span><input value={profileData.bank.bankName} disabled /></label>
            <label><span>Account Number</span><input value={profileData.bank.accountNumber} disabled /></label>
            <label><span>IFSC Code</span><input value={profileData.bank.ifscCode} disabled /></label>
            <label><span>PAN Number</span><input value={profileData.bank.panNumber} disabled /></label>
            <label><span>Aadhaar Number</span><input value={profileData.bank.aadhaarNumber} disabled /></label>
          </div>
        </article>
      </section>

      <section className="card employee-profile-card" id="employee-profile-documents-section">
        <div className="employee-profile-card-title">
          <FileText size={18} />
          <h4>Documents</h4>
        </div>
        <p className="muted" style={{ marginTop: 0 }}>
          Secure self-service document center. Employees can upload, preview, download, and replace allowed files.
        </p>
        <div className="employee-doc-grid">
          {documentsList.map((doc) => (
            <article key={doc.id} className="employee-doc-card">
              <h5>{doc.title}</h5>
              <p className="muted small" style={{ margin: '4px 0 10px' }}>
                Status: {doc.uploaded ? 'Uploaded' : 'Not uploaded'}
              </p>
              <div className="employee-doc-meta">
                <p><span>File:</span> <strong>{doc.fileName || '-'}</strong></p>
                <p><span>Size:</span> <strong>{doc.fileSize || '-'}</strong></p>
                <p><span>Updated:</span> <strong>{String(doc.lastUpdatedAt || '').slice(0, 10) || '-'}</strong></p>
              </div>
              <div className="employee-doc-actions">
                <label className="employee-doc-btn">
                  <Upload size={14} />
                  <span>{doc.uploaded ? 'Replace' : 'Upload'}</span>
                  <input
                    type="file"
                    disabled={doc.uploaded && !doc.editable}
                    onChange={(e) => updateDocument(doc.id, e.target.files?.[0])}
                  />
                </label>
                <button type="button" className="ghost" onClick={() => openPreview(doc)} disabled={!doc.uploaded}>
                  <Eye size={14} />
                  Preview
                </button>
                <button type="button" className="ghost" onClick={() => downloadDocument(doc)} disabled={!doc.uploaded}>
                  <Download size={14} />
                  Download
                </button>
                {doc.editable && doc.uploaded && (
                  <button type="button" className="ghost" onClick={() => removeDocument(doc.id)}>Remove</button>
                )}
              </div>
              {!doc.editable && (
                <p className="muted small" style={{ marginTop: 10 }}>Admin controlled document.</p>
              )}
            </article>
          ))}
        </div>
      </section>

      <section className="card employee-profile-card" id="employee-profile-security-section">
        <div className="employee-profile-card-title">
          <Shield size={18} />
          <h4>Security Settings</h4>
        </div>
        <div className="employee-security-grid">
          <article className="employee-security-card">
            <h5>Change Password</h5>
            <div className="employee-profile-fields-grid">
              <label>
                <span>Current Password</span>
                <input
                  type="password"
                  value={passwordForm.currentPassword}
                  onChange={(e) => setPasswordForm((old) => ({ ...old, currentPassword: e.target.value }))}
                />
              </label>
              <label>
                <span>New Password</span>
                <input
                  type="password"
                  value={passwordForm.newPassword}
                  onChange={(e) => setPasswordForm((old) => ({ ...old, newPassword: e.target.value }))}
                />
              </label>
              <label>
                <span>Confirm Password</span>
                <input
                  type="password"
                  value={passwordForm.confirmPassword}
                  onChange={(e) => setPasswordForm((old) => ({ ...old, confirmPassword: e.target.value }))}
                />
              </label>
            </div>
            <button type="button" onClick={handlePasswordUpdate} disabled={passwordLoading}>
              {passwordLoading ? 'Updating...' : 'Update Password'}
            </button>
          </article>

          <article className="employee-security-card">
            <h5>Update Login Email</h5>
            <label>
              <span>Login Email</span>
              <input
                type="email"
                value={security.loginEmail || ''}
                onChange={(e) => setSecurity((old) => ({ ...old, loginEmail: e.target.value }))}
              />
            </label>
            <div className="employee-profile-card-actions">
              <button type="button" onClick={updateSecurityEmail}>Update Login Email</button>
            </div>
          </article>

          <article className="employee-security-card">
            <h5>Two-Factor Authentication</h5>
            <label className="employee-security-toggle">
              <input
                type="checkbox"
                checked={!!security.twoFactorEnabled}
                onChange={(e) => setSecurity((old) => ({ ...old, twoFactorEnabled: !!e.target.checked }))}
              />
              <span>Enable Two-Factor Authentication</span>
            </label>
            <label>
              <span>Verification Method</span>
              <select
                value={security.twoFactorMethod || 'authenticator_app'}
                onChange={(e) => setSecurity((old) => ({ ...old, twoFactorMethod: e.target.value }))}
                disabled={!security.twoFactorEnabled}
              >
                <option value="authenticator_app">Authenticator App</option>
                <option value="email_otp">Email OTP</option>
                <option value="sms_otp">SMS OTP</option>
              </select>
            </label>
          </article>

          <article className="employee-security-card employee-security-span-2">
            <h5>Last Login Details</h5>
            <div className="employee-security-last-login">
              <p><span>Time:</span> <strong>{String(security.lastLogin?.at || '').replace('T', ' ').slice(0, 16) || '-'}</strong></p>
              <p><span>IP:</span> <strong>{security.lastLogin?.ip || '-'}</strong></p>
              <p><span>Location:</span> <strong>{security.lastLogin?.location || '-'}</strong></p>
              <p><span>Device:</span> <strong>{security.lastLogin?.device || '-'}</strong></p>
            </div>
          </article>

          <article className="employee-security-card employee-security-span-2">
            <h5>Login Activity History</h5>
            <div className="employee-security-table-wrap">
              <table className="employee-security-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Action</th>
                    <th>IP Address</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(security.loginActivity || []).map((item) => (
                    <tr key={item.id}>
                      <td>{String(item.at || '').replace('T', ' ').slice(0, 16)}</td>
                      <td>{item.action || '-'}</td>
                      <td>{item.ip || '-'}</td>
                      <td>
                        <span className={`status-badge ${item.status === 'blocked' ? 'warn' : 'ok'}`}>
                          {item.status === 'blocked' ? 'Blocked' : 'Success'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>

          <article className="employee-security-card employee-security-span-2">
            <h5>Device Login History</h5>
            <div className="employee-security-table-wrap">
              <table className="employee-security-table">
                <thead>
                  <tr>
                    <th>Device</th>
                    <th>Location</th>
                    <th>Last Active</th>
                    <th>Session</th>
                  </tr>
                </thead>
                <tbody>
                  {(security.deviceHistory || []).map((item) => (
                    <tr key={item.id}>
                      <td>{item.device || '-'}</td>
                      <td>{item.location || '-'}</td>
                      <td>{String(item.lastActiveAt || '').replace('T', ' ').slice(0, 16)}</td>
                      <td>
                        <span className={`status-badge ${item.current ? 'ok' : ''}`}>{item.current ? 'Current Device' : 'Previous Device'}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>

      <section className="card employee-profile-card">
        <div className="employee-profile-card-title">
          <History size={18} />
          <h4>Employment Timeline</h4>
        </div>
        <div className="employee-timeline-list">
          {(profileData.timeline || []).map((item) => (
            <article key={item.id} className="employee-timeline-item">
              <span className="employee-timeline-dot" aria-hidden="true" />
              <div>
                <p className="employee-timeline-title">{item.title}</p>
                <p className="muted small">{item.detail}</p>
              </div>
              <strong>{item.date}</strong>
            </article>
          ))}
        </div>
      </section>

      {previewModal.open && (
        <div className="modal-overlay" onClick={() => setPreviewModal({ open: false, title: '', fileName: '', fileType: '', url: '' })}>
          <div className="modal-card employee-doc-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="row between">
              <h3>{previewModal.title}</h3>
              <button type="button" className="ghost" onClick={() => setPreviewModal({ open: false, title: '', fileName: '', fileType: '', url: '' })}>Close</button>
            </div>
            <p className="muted small" style={{ marginTop: 0 }}>{previewModal.fileName || '-'}</p>
            {isImageType(previewModal.fileType, previewModal.fileName) ? (
              <img src={previewModal.url} alt={previewModal.fileName} className="employee-doc-preview-image" />
            ) : (
              <iframe title={previewModal.fileName || 'Document preview'} src={previewModal.url} className="employee-doc-preview-frame" />
            )}
          </div>
        </div>
      )}
    </section>
  )
}