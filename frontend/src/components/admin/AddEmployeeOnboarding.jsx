import { useMemo, useState } from 'react'
import {
  Building2,
  Briefcase,
  ChevronLeft,
  ChevronRight,
  Landmark,
  Loader2,
  Mail,
  Shield,
  User,
  Wallet,
  ImageIcon,
  KeyRound,
  ChevronDown,
  ChevronUp,
  IndianRupee,
} from 'lucide-react'
import { formatINR, estimatePayrollPreviewIndia } from './addEmployeePayrollPreview'
import './AddEmployeeOnboarding.css'

const STEPS = [
  { id: 1, label: 'Basics', short: 'Profile' },
  { id: 2, label: 'Job', short: 'Role' },
  { id: 3, label: 'Pay', short: 'Pay' },
  { id: 4, label: 'Bank', short: 'KYC' },
  { id: 5, label: 'Access', short: 'Login' },
]

function generateSecureTempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'
  const digits = '0123456789'
  let s = ''
  for (let i = 0; i < 9; i++) s += chars[Math.floor(Math.random() * chars.length)]
  s += digits[Math.floor(Math.random() * digits.length)]
  return s
}

function formatShiftSummary(wp) {
  const w = wp || {}
  const sat = w.saturdayPolicy || 'OFF'
  return `${w.shiftStart || '09:00'}–${w.shiftEnd || '18:00'} · Sat ${sat}`
}

export default function AddEmployeeOnboarding({
  newEmp,
  setNewEmp,
  employeeFormEmail,
  setEmployeeFormEmail,
  employeeFormRole,
  setEmployeeFormRole,
  employeeFormStatus,
  setEmployeeFormStatus,
  addEmployeeFeedback,
  addEmployeeFieldErrors,
  addEmployeeShowPassword,
  setAddEmployeeShowPassword,
  createEmployeeSubmitting,
  companies,
  addCompanyMode,
  setAddCompanyMode,
  newCompanyName,
  setNewCompanyName,
  addCompanyError,
  setAddCompanyError,
  handleAddCompany,
  addCompanyBusy,
  employees,
  departments,
  directoryDepartments,
  directoryRoles,
  catalogBusy,
  newDepartmentName,
  setNewDepartmentName,
  addDepartment,
  editDepartment,
  deleteDepartment,
  showInlineDeptManager,
  setShowInlineDeptManager,
  newRoleName,
  setNewRoleName,
  addRole,
  editRole,
  deleteRole,
  showInlineRoleManager,
  setShowInlineRoleManager,
  selectedCompany,
  goToView,
  onCancel,
  createEmployee,
  roles,
}) {
  const [step, setStep] = useState(1)
  const [advancedWorkPolicyOpen, setAdvancedWorkPolicyOpen] = useState(false)
  const [stepHint, setStepHint] = useState('')

  const preview = useMemo(
    () =>
      estimatePayrollPreviewIndia({
        salaryType: newEmp.salary_type,
        monthlyGross: parseFloat(newEmp.monthly_salary || 0) || 0,
        netTargetMonthly: parseFloat(newEmp.net_target_monthly || 0) || 0,
      }),
    [newEmp.salary_type, newEmp.monthly_salary, newEmp.net_target_monthly],
  )

  const orgSummary = useMemo(() => {
    const cid = newEmp.company_name
      ? companies.find((c) => c.name === newEmp.company_name || c.id === newEmp.company_name)
      : null
    return {
      company: newEmp.company_name || selectedCompany?.name || '—',
      accent: cid?.color || '#6366f1',
      headcount: Array.isArray(employees) ? employees.length : 0,
    }
  }, [newEmp.company_name, companies, selectedCompany, employees])

  function validateStep(s) {
    if (s === 1) {
      const name = String(newEmp.name || '').trim()
      const email = String(employeeFormEmail || '').trim()
      const mobile = String(newEmp.mobile || '').trim()
      if (!name) return 'Enter full name to continue.'
      if (!email) return 'Work email is required.'
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email address.'
      if (!mobile) return 'Mobile number is required for HR records.'
      return ''
    }
    if (s === 2) {
      if (!String(newEmp.designation || '').trim()) return 'Designation is required.'
      return ''
    }
    if (s === 3) {
      if (newEmp.salary_type === 'IN_HAND') {
        const n = parseFloat(newEmp.net_target_monthly || 0)
        if (n < 0) return 'Net in-hand cannot be negative.'
      } else {
        const g = parseFloat(newEmp.monthly_salary || 0)
        if (g < 0) return 'Monthly salary cannot be negative.'
      }
      return ''
    }
    return ''
  }

  function goNext(e) {
    e.preventDefault()
    const err = validateStep(step)
    setStepHint(err)
    if (err) return
    setStep((x) => Math.min(5, x + 1))
  }

  function goBack(e) {
    e.preventDefault()
    setStepHint('')
    setStep((x) => Math.max(1, x - 1))
  }

  function onPhotoFile(file) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      setStepHint('Please choose an image file for profile photo.')
      return
    }
    if (file.size > 200000) {
      setStepHint('Image is large for inline storage — paste a hosted URL instead, or choose a smaller file.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      setNewEmp((o) => ({ ...o, photo_url: reader.result }))
      setStepHint('')
    }
    reader.readAsDataURL(file)
  }

  const salaryAmount =
    newEmp.salary_type === 'CTC_BASED'
      ? parseFloat(newEmp.monthly_salary || 0) || 0
      : parseFloat(newEmp.net_target_monthly || 0) || 0

  return (
    <form className="aeo-shell" onSubmit={createEmployee}>
      <div className="aeo-main">
        <header className="aeo-header">
          <div>
            <p className="aeo-kicker">Employee onboarding</p>
            <h2 className="aeo-title">Add employee</h2>
            <p className="aeo-sub">
              A guided flow for HR teams — progress is saved when you submit on the final step.
            </p>
          </div>
          <div className="aeo-header-actions">
            <button
              type="button"
              className="aeo-btn ghost"
              onClick={() => goToView('employeePayroll', 'payroll', 'employee-payroll')}
              disabled={createEmployeeSubmitting}
            >
              Payroll
            </button>
            <button type="button" className="aeo-btn ghost" onClick={onCancel} disabled={createEmployeeSubmitting}>
              Cancel
            </button>
          </div>
        </header>

        <nav className="aeo-steps" aria-label="Onboarding steps">
          {STEPS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`aeo-step-pill ${step === s.id ? 'active' : ''} ${step > s.id ? 'done' : ''}`}
              onClick={() => {
                if (s.id < step) setStep(s.id)
              }}
              disabled={s.id > step}
            >
              <span className="aeo-step-num">{s.id}</span>
              {s.label}
            </button>
          ))}
        </nav>

        {!!addEmployeeFeedback.text && (
          <div className={`aeo-banner ${addEmployeeFeedback.type === 'success' ? 'ok' : 'err'}`}>
            {addEmployeeFeedback.text}
          </div>
        )}
        {!!stepHint && <div className="aeo-banner err">{stepHint}</div>}

        {step === 1 && (
          <section className="aeo-panel">
            <div className="aeo-section-head">
              <User size={18} strokeWidth={2} />
              <div>
                <h3 className="aeo-section-title">Basic information</h3>
                <p className="aeo-section-desc">Identity, contact, and emergency details.</p>
              </div>
            </div>

            <div className="aeo-grid-2">
              <div className="aeo-field span-2">
                <span className="aeo-label">Profile photo</span>
                <div className="aeo-photo-row">
                  <div className="aeo-avatar">
                    {newEmp.photo_url ? (
                      <img src={newEmp.photo_url} alt="" />
                    ) : (
                      <ImageIcon size={28} className="muted" />
                    )}
                  </div>
                  <div className="aeo-photo-actions">
                    <label className="aeo-file-btn">
                      Upload
                      <input
                        type="file"
                        accept="image/*"
                        className="sr-only"
                        onChange={(e) => onPhotoFile(e.target.files?.[0])}
                      />
                    </label>
                    <input
                      className="aeo-input"
                      placeholder="Or paste image URL"
                      value={newEmp.photo_url?.startsWith('data:') ? '' : newEmp.photo_url}
                      onChange={(e) => setNewEmp((o) => ({ ...o, photo_url: e.target.value }))}
                    />
                  </div>
                </div>
                <p className="aeo-hint">Uploads stay under ~200KB, or use a hosted URL for larger files.</p>
              </div>

              <div className="aeo-field">
                <span className="aeo-label">Full name *</span>
                <input
                  className={`aeo-input ${addEmployeeFieldErrors.name ? 'invalid' : ''}`}
                  value={newEmp.name}
                  onChange={(e) => {
                    setNewEmp((o) => ({ ...o, name: e.target.value }))
                  }}
                  placeholder="As per official records"
                  autoComplete="name"
                />
                {addEmployeeFieldErrors.name && <p className="aeo-err">{addEmployeeFieldErrors.name}</p>}
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Mobile *</span>
                <input
                  className="aeo-input"
                  value={newEmp.mobile}
                  onChange={(e) => setNewEmp((o) => ({ ...o, mobile: e.target.value }))}
                  placeholder="+91"
                  inputMode="tel"
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Work email *</span>
                <input
                  className={`aeo-input ${addEmployeeFieldErrors.email ? 'invalid' : ''}`}
                  type="email"
                  value={employeeFormEmail}
                  onChange={(e) => setEmployeeFormEmail(e.target.value)}
                  placeholder="name@company.com"
                />
                {addEmployeeFieldErrors.email && <p className="aeo-err">{addEmployeeFieldErrors.email}</p>}
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Date of birth</span>
                <input
                  className="aeo-input"
                  type="date"
                  value={newEmp.dob}
                  onChange={(e) => setNewEmp((o) => ({ ...o, dob: e.target.value }))}
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Gender</span>
                <select
                  className="aeo-input"
                  value={newEmp.gender}
                  onChange={(e) => setNewEmp((o) => ({ ...o, gender: e.target.value }))}
                >
                  <option value="">Select</option>
                  <option value="Male">Male</option>
                  <option value="Female">Female</option>
                  <option value="Other">Other</option>
                </select>
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Blood group</span>
                <select
                  className="aeo-input"
                  value={newEmp.blood_group}
                  onChange={(e) => setNewEmp((o) => ({ ...o, blood_group: e.target.value }))}
                >
                  <option value="">Select</option>
                  {['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'].map((bg) => (
                    <option key={bg} value={bg}>
                      {bg}
                    </option>
                  ))}
                </select>
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Marital status</span>
                <select
                  className="aeo-input"
                  value={newEmp.marital_status}
                  onChange={(e) => setNewEmp((o) => ({ ...o, marital_status: e.target.value }))}
                >
                  <option value="">Select</option>
                  <option value="Single">Single</option>
                  <option value="Married">Married</option>
                  <option value="Divorced">Divorced</option>
                  <option value="Widowed">Widowed</option>
                </select>
              </div>
              <div className="aeo-field span-2">
                <span className="aeo-label">Address</span>
                <textarea
                  className="aeo-textarea"
                  rows={2}
                  value={newEmp.permanent_address}
                  onChange={(e) => setNewEmp((o) => ({ ...o, permanent_address: e.target.value }))}
                  placeholder="Current / permanent address"
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Emergency contact</span>
                <input
                  className="aeo-input"
                  value={newEmp.emergency_contact_name}
                  onChange={(e) => setNewEmp((o) => ({ ...o, emergency_contact_name: e.target.value }))}
                  placeholder="Name"
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Emergency phone</span>
                <input
                  className="aeo-input"
                  value={newEmp.emergency_contact_phone}
                  onChange={(e) => setNewEmp((o) => ({ ...o, emergency_contact_phone: e.target.value }))}
                  placeholder="+91"
                />
              </div>
            </div>
          </section>
        )}

        {step === 2 && (
          <section className="aeo-panel">
            <div className="aeo-section-head">
              <Briefcase size={18} strokeWidth={2} />
              <div>
                <h3 className="aeo-section-title">Job details</h3>
                <p className="aeo-section-desc">Organisation context, role, and reporting.</p>
              </div>
            </div>

            <div className="aeo-org-card" style={{ borderLeftColor: orgSummary.accent }}>
              <Building2 size={20} />
              <div>
                <p className="aeo-org-label">Organisation snapshot</p>
                <p className="aeo-org-title">{orgSummary.company}</p>
                <p className="aeo-org-meta">
                  {orgSummary.headcount} employees in directory
                  {selectedCompany?.name ? ` • Context: ${selectedCompany.name}` : ''}
                </p>
              </div>
            </div>

            <div className="aeo-grid-2">
              <div className="aeo-field">
                <span className="aeo-label">Employee ID</span>
                <input
                  className="aeo-input"
                  value={newEmp.emp_id}
                  onChange={(e) => setNewEmp((o) => ({ ...o, emp_id: e.target.value.toUpperCase() }))}
                  placeholder="EMP-001"
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Designation *</span>
                <input
                  className="aeo-input"
                  value={newEmp.designation}
                  onChange={(e) => setNewEmp((o) => ({ ...o, designation: e.target.value }))}
                  placeholder="e.g. Senior Analyst"
                />
              </div>

              <div className="aeo-field">
                <div className="aeo-inline-label">
                  <span className="aeo-label tight">Department *</span>
                  <button
                    type="button"
                    className="aeo-link-btn"
                    onClick={() => {
                      setShowInlineDeptManager((v) => !v)
                      setShowInlineRoleManager(false)
                    }}
                  >
                    Manage
                  </button>
                </div>
                <select
                  className="aeo-input"
                  value={newEmp.department}
                  onChange={(e) => setNewEmp((o) => ({ ...o, department: e.target.value }))}
                >
                  {directoryDepartments.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
                {showInlineDeptManager && (
                  <div className="aeo-mini-panel">
                    <div className="aeo-mini-row">
                      <input
                        className="aeo-input small"
                        placeholder="New department"
                        value={newDepartmentName}
                        onChange={(e) => setNewDepartmentName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addDepartment()
                          }
                        }}
                      />
                      <button type="button" className="aeo-btn primary sm" onClick={addDepartment} disabled={catalogBusy || !newDepartmentName.trim()}>
                        Add
                      </button>
                    </div>
                    <ul className="aeo-mini-list">
                      {(departments || []).map((item) => (
                        <li key={item.id}>
                          <span>{item.name}</span>
                          <span>
                            <button type="button" className="aeo-link-btn" onClick={() => editDepartment(item)} disabled={catalogBusy}>
                              Edit
                            </button>
                            <button type="button" className="aeo-link-btn danger" onClick={() => deleteDepartment(item)} disabled={catalogBusy}>
                              Del
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="aeo-field">
                <div className="aeo-inline-label">
                  <span className="aeo-label tight">Role *</span>
                  <button
                    type="button"
                    className="aeo-link-btn"
                    onClick={() => {
                      setShowInlineRoleManager((v) => !v)
                      setShowInlineDeptManager(false)
                    }}
                  >
                    Manage
                  </button>
                </div>
                <select className="aeo-input" value={employeeFormRole} onChange={(e) => setEmployeeFormRole(e.target.value)}>
                  {directoryRoles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                {showInlineRoleManager && (
                  <div className="aeo-mini-panel">
                    <div className="aeo-mini-row">
                      <input
                        className="aeo-input small"
                        placeholder="New role"
                        value={newRoleName}
                        onChange={(e) => setNewRoleName(e.target.value.toLowerCase())}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            addRole()
                          }
                        }}
                      />
                      <button type="button" className="aeo-btn primary sm" onClick={addRole} disabled={catalogBusy || !newRoleName.trim()}>
                        Add
                      </button>
                    </div>
                    <ul className="aeo-mini-list">
                      {(roles || []).map((item) => (
                        <li key={item.id}>
                          <span>{item.name}</span>
                          <span>
                            <button type="button" className="aeo-link-btn" onClick={() => editRole(item)} disabled={catalogBusy}>
                              Edit
                            </button>
                            <button type="button" className="aeo-link-btn danger" onClick={() => deleteRole(item)} disabled={catalogBusy}>
                              Del
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>

              <div className="aeo-field">
                <span className="aeo-label">Company</span>
                {addCompanyMode ? (
                  <div>
                    <div className="aeo-mini-row">
                      <input
                        className="aeo-input"
                        placeholder="Company name"
                        value={newCompanyName}
                        onChange={(e) => {
                          setNewCompanyName(e.target.value)
                          if (setAddCompanyError) setAddCompanyError('')
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            handleAddCompany(newCompanyName)
                          }
                        }}
                        autoFocus
                        disabled={addCompanyBusy}
                      />
                      <button
                        type="button"
                        className="aeo-btn primary sm"
                        disabled={addCompanyBusy || !newCompanyName.trim()}
                        onClick={() => handleAddCompany(newCompanyName)}
                      >
                        {addCompanyBusy ? '…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="aeo-btn ghost sm"
                        onClick={() => {
                          setAddCompanyMode(false)
                          setNewCompanyName('')
                        }}
                      >
                        ✕
                      </button>
                    </div>
                    {addCompanyError && <p className="aeo-err">{addCompanyError}</p>}
                  </div>
                ) : (
                  <div className="aeo-mini-row">
                    <select
                      className="aeo-input grow"
                      value={newEmp.company_name}
                      onChange={(e) => setNewEmp((o) => ({ ...o, company_name: e.target.value }))}
                    >
                      <option value="">Select company</option>
                      {companies.map((c) => (
                        <option key={c.id} value={c.name}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="aeo-btn ghost sm"
                      onClick={() => {
                        if (setAddCompanyError) setAddCompanyError('')
                        setAddCompanyMode(true)
                      }}
                      title="Add company"
                    >
                      +
                    </button>
                  </div>
                )}
              </div>

              <div className="aeo-field">
                <span className="aeo-label">Employment type</span>
                <select
                  className="aeo-input"
                  value={newEmp.employment_type}
                  onChange={(e) => setNewEmp((o) => ({ ...o, employment_type: e.target.value }))}
                >
                  <option value="Full-time">Full-time</option>
                  <option value="Part-time">Part-time</option>
                  <option value="Contract">Contract</option>
                  <option value="Intern">Intern</option>
                </select>
              </div>

              <div className="aeo-field">
                <span className="aeo-label">Date of joining</span>
                <input
                  className="aeo-input"
                  type="date"
                  value={newEmp.date_of_joining}
                  onChange={(e) => setNewEmp((o) => ({ ...o, date_of_joining: e.target.value }))}
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Employee status</span>
                <select className="aeo-input" value={employeeFormStatus} onChange={(e) => setEmployeeFormStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Reporting manager</span>
                <select
                  className="aeo-input"
                  value={newEmp.reporting_manager}
                  onChange={(e) => setNewEmp((o) => ({ ...o, reporting_manager: e.target.value }))}
                >
                  <option value="">None / self</option>
                  {(Array.isArray(employees) ? employees : []).map((emp) => {
                    const eid = String(emp?.id || emp?._id || '')
                    return (
                      <option key={eid} value={String(emp?.name || '')}>
                        {String(emp?.name || '')} — {String(emp?.designation || emp?.department || '')}
                      </option>
                    )
                  })}
                </select>
              </div>
            </div>

            <div className="aeo-adv-wrap">
              <button
                type="button"
                className="aeo-adv-trigger"
                onClick={() => setAdvancedWorkPolicyOpen((o) => !o)}
              >
                {advancedWorkPolicyOpen ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                Advanced work policy
                <span className="aeo-adv-sub">Shift, grace, overtime, Saturday</span>
              </button>
              {advancedWorkPolicyOpen && (
                <div className="aeo-adv-panel">
                  <div className="aeo-grid-2">
                    <div className="aeo-field">
                      <span className="aeo-label">Saturday policy</span>
                      <select
                        className="aeo-input"
                        value={newEmp.work_policy?.saturdayPolicy || 'OFF'}
                        onChange={(e) =>
                          setNewEmp((o) => ({
                            ...o,
                            work_policy: { ...o.work_policy, saturdayPolicy: e.target.value },
                          }))
                        }
                      >
                        <option value="OFF">Off — paid weekend</option>
                        <option value="WORKING">Working — attendance required</option>
                        <option value="HALF_DAY">Half day</option>
                      </select>
                    </div>
                    <div className="aeo-field">
                      <span className="aeo-label">Paid leaves / month</span>
                      <input
                        className="aeo-input"
                        type="number"
                        min={0}
                        max={31}
                        value={newEmp.work_policy?.paidLeavesPerMonth ?? 2}
                        onChange={(e) =>
                          setNewEmp((o) => ({
                            ...o,
                            work_policy: {
                              ...o.work_policy,
                              paidLeavesPerMonth: parseInt(e.target.value, 10) || 0,
                            },
                          }))
                        }
                      />
                    </div>
                    <div className="aeo-field">
                      <span className="aeo-label">Shift start</span>
                      <input
                        className="aeo-input"
                        type="time"
                        value={newEmp.work_policy?.shiftStart || '09:00'}
                        onChange={(e) =>
                          setNewEmp((o) => ({
                            ...o,
                            work_policy: { ...o.work_policy, shiftStart: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div className="aeo-field">
                      <span className="aeo-label">Shift end</span>
                      <input
                        className="aeo-input"
                        type="time"
                        value={newEmp.work_policy?.shiftEnd || '18:00'}
                        onChange={(e) =>
                          setNewEmp((o) => ({
                            ...o,
                            work_policy: { ...o.work_policy, shiftEnd: e.target.value },
                          }))
                        }
                      />
                    </div>
                    <div className="aeo-field">
                      <span className="aeo-label">Grace minutes</span>
                      <input
                        className="aeo-input"
                        type="number"
                        min={0}
                        max={60}
                        value={newEmp.work_policy?.graceMinutes ?? 15}
                        onChange={(e) =>
                          setNewEmp((o) => ({
                            ...o,
                            work_policy: {
                              ...o.work_policy,
                              graceMinutes: parseInt(e.target.value, 10) || 0,
                            },
                          }))
                        }
                      />
                    </div>
                    <div className="aeo-field flex-center">
                      <label className="aeo-check">
                        <input
                          type="checkbox"
                          checked={!!newEmp.work_policy?.overtimeEligible}
                          onChange={(e) =>
                            setNewEmp((o) => ({
                              ...o,
                              work_policy: {
                                ...o.work_policy,
                                overtimeEligible: e.target.checked,
                              },
                            }))
                          }
                        />
                        Overtime eligible
                      </label>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}

        {step === 3 && (
          <section className="aeo-panel">
            <div className="aeo-section-head">
              <Wallet size={18} strokeWidth={2} />
              <div>
                <h3 className="aeo-section-title">Compensation & payroll</h3>
                <p className="aeo-section-desc">Single source of truth for monthly salary — payroll reads this automatically.</p>
              </div>
            </div>

            <div className="aeo-pay-card">
              <p className="aeo-pay-eyebrow">Salary basis</p>
              <div className="aeo-salary-cards">
                {[
                  {
                    val: 'CTC_BASED',
                    title: 'Standard CTC',
                    desc: 'Gross minus statutory deductions',
                  },
                  {
                    val: 'IN_HAND',
                    title: 'Full in-hand',
                    desc: 'Guaranteed bank credit (gross-up in payroll)',
                  },
                ].map((opt) => (
                  <button
                    key={opt.val}
                    type="button"
                    className={`aeo-salary-card ${newEmp.salary_type === opt.val ? 'on' : ''}`}
                    onClick={() => setNewEmp((o) => ({ ...o, salary_type: opt.val }))}
                  >
                    <span className="aeo-sc-title">{opt.title}</span>
                    <span className="aeo-sc-desc">{opt.desc}</span>
                  </button>
                ))}
              </div>

              {newEmp.salary_type === 'CTC_BASED' ? (
                <div className="aeo-field aeo-pay-hero">
                  <span className="aeo-label">Monthly salary (gross)</span>
                  <div className="aeo-inr">
                    <IndianRupee size={18} />
                    <input
                      className="aeo-input hero"
                      type="number"
                      min={0}
                      step={100}
                      placeholder="e.g. 40000"
                      value={newEmp.monthly_salary}
                      onChange={(e) => setNewEmp((o) => ({ ...o, monthly_salary: e.target.value }))}
                    />
                  </div>
                </div>
              ) : (
                <div className="aeo-field aeo-pay-hero">
                  <span className="aeo-label">Guaranteed in-hand (monthly)</span>
                  <div className="aeo-inr">
                    <IndianRupee size={18} />
                    <input
                      className="aeo-input hero"
                      type="number"
                      min={0}
                      step={100}
                      placeholder="e.g. 50000"
                      value={newEmp.net_target_monthly}
                      onChange={(e) => setNewEmp((o) => ({ ...o, net_target_monthly: e.target.value }))}
                    />
                  </div>
                </div>
              )}

              <div className="aeo-preview">
                <p className="aeo-preview-title">Estimated payroll preview</p>
                <div className="aeo-preview-grid">
                  <div>
                    <span className="aeo-pv-label">
                      {newEmp.salary_type === 'IN_HAND' ? 'Guaranteed in-hand' : 'Estimated in-hand'}
                    </span>
                    <span className="aeo-pv-val">{formatINR(preview.estimatedInHand)}</span>
                  </div>
                  <div>
                    <span className="aeo-pv-label">Estimated PF (employee)</span>
                    <span className="aeo-pv-val">
                      {newEmp.salary_type === 'IN_HAND' ? '—' : formatINR(preview.estimatedPf)}
                    </span>
                  </div>
                  <div>
                    <span className="aeo-pv-label">Estimated TDS</span>
                    <span className="aeo-pv-val">{formatINR(preview.estimatedTds)}</span>
                  </div>
                </div>
                {newEmp.salary_type === 'CTC_BASED' && preview.estimatedEsi > 0 && (
                  <p className="aeo-preview-foot">
                    Includes PT / ESI estimates (PT {formatINR(preview.estimatedPt)}, ESI {formatINR(preview.estimatedEsi)}).
                  </p>
                )}
              </div>
            </div>
          </section>
        )}

        {step === 4 && (
          <section className="aeo-panel">
            <div className="aeo-section-head">
              <Landmark size={18} strokeWidth={2} />
              <div>
                <h3 className="aeo-section-title">Bank &amp; compliance</h3>
                <p className="aeo-section-desc">KYC identifiers and salary payout account.</p>
              </div>
            </div>

            <div className="aeo-grid-2">
              <div className="aeo-field">
                <span className="aeo-label">Aadhaar</span>
                <input
                  className="aeo-input"
                  placeholder="XXXX XXXX XXXX"
                  maxLength={14}
                  value={newEmp.aadhaar_number}
                  onChange={(e) =>
                    setNewEmp((o) => ({
                      ...o,
                      aadhaar_number: e.target.value
                        .replace(/\D/g, '')
                        .replace(/(\d{4})(?=\d)/g, '$1 ')
                        .trim(),
                    }))
                  }
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">PAN</span>
                <input
                  className="aeo-input mono"
                  placeholder="ABCDE1234F"
                  maxLength={10}
                  value={newEmp.pan_number}
                  onChange={(e) => setNewEmp((o) => ({ ...o, pan_number: e.target.value.toUpperCase() }))}
                />
              </div>
              <div className="aeo-field span-2 aeo-bank-banner">
                <Landmark size={18} />
                <div>
                  <p className="aeo-bank-label">Bank account for payroll</p>
                  <p className="aeo-bank-sub">IFSC verified format — used for statutory filings and payouts.</p>
                </div>
              </div>
              <div className="aeo-field span-2">
                <span className="aeo-label">Bank name</span>
                <input
                  className="aeo-input"
                  value={newEmp.bank_name}
                  onChange={(e) => setNewEmp((o) => ({ ...o, bank_name: e.target.value }))}
                  placeholder="e.g. HDFC Bank"
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Account number</span>
                <input
                  className="aeo-input mono"
                  value={newEmp.bank_account_no}
                  onChange={(e) => setNewEmp((o) => ({ ...o, bank_account_no: e.target.value.replace(/\D/g, '') }))}
                  placeholder="Salary account"
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">IFSC</span>
                <input
                  className="aeo-input mono"
                  maxLength={11}
                  value={newEmp.bank_ifsc}
                  onChange={(e) => setNewEmp((o) => ({ ...o, bank_ifsc: e.target.value.toUpperCase() }))}
                  placeholder="HDFC0001234"
                />
              </div>
              <div className="aeo-field span-2">
                <span className="aeo-label">Photo URL / upload</span>
                <p className="aeo-hint">Profile photo can also be finalized here for verification workflows.</p>
                <div className="aeo-photo-row">
                  <div className="aeo-avatar sm">
                    {newEmp.photo_url ? <img src={newEmp.photo_url} alt="" /> : <ImageIcon size={22} className="muted" />}
                  </div>
                  <label className="aeo-file-btn">
                    Upload
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => onPhotoFile(e.target.files?.[0])}
                    />
                  </label>
                  <input
                    className="aeo-input grow"
                    placeholder="https://…"
                    value={newEmp.photo_url?.startsWith('data:') ? '' : newEmp.photo_url}
                    onChange={(e) => setNewEmp((o) => ({ ...o, photo_url: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          </section>
        )}

        {step === 5 && (
          <section className="aeo-panel">
            <div className="aeo-section-head">
              <Shield size={18} strokeWidth={2} />
              <div>
                <h3 className="aeo-section-title">Access &amp; security</h3>
                <p className="aeo-section-desc">Portal access, credentials, and onboarding comms.</p>
              </div>
            </div>

            <div className="aeo-grid-2">
              <div className="aeo-field">
                <span className="aeo-label">Login ID</span>
                <input
                  className="aeo-input"
                  placeholder="Defaults from email if blank"
                  value={newEmp.login_id}
                  onChange={(e) => setNewEmp((o) => ({ ...o, login_id: e.target.value.toLowerCase() }))}
                />
              </div>
              <div className="aeo-field">
                <span className="aeo-label">Temporary password</span>
                <div className="aeo-pass-row">
                  <input
                    className={`aeo-input ${addEmployeeFieldErrors.password ? 'invalid' : ''}`}
                    type={addEmployeeShowPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Leave blank to use server default"
                    value={newEmp.password}
                    onChange={(e) => {
                      setNewEmp((o) => ({ ...o, password: e.target.value }))
                    }}
                  />
                  <button type="button" className="aeo-btn ghost sm" onClick={() => setAddEmployeeShowPassword((v) => !v)}>
                    {addEmployeeShowPassword ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    className="aeo-btn secondary sm"
                    onClick={() => {
                      const pw = generateSecureTempPassword()
                      setNewEmp((o) => ({ ...o, password: pw }))
                      setAddEmployeeShowPassword(true)
                    }}
                  >
                    <KeyRound size={14} /> Generate
                  </button>
                </div>
                {addEmployeeFieldErrors.password && <p className="aeo-err">{addEmployeeFieldErrors.password}</p>}
                <p className="aeo-hint">
                  Employee will be prompted to change password on first login when using admin-defined credentials.
                </p>
              </div>

              <div className="aeo-field flex-center">
                <label className="aeo-check">
                  <input
                    type="checkbox"
                    checked={newEmp.portal_access !== false}
                    onChange={(e) => setNewEmp((o) => ({ ...o, portal_access: e.target.checked }))}
                  />
                  Employee portal access
                </label>
              </div>
              <div className="aeo-field flex-center">
                <label className="aeo-check">
                  <input
                    type="checkbox"
                    checked={!!newEmp.send_invite_email}
                    onChange={(e) => setNewEmp((o) => ({ ...o, send_invite_email: e.target.checked }))}
                  />
                  Send invite email (queued when dispatch is enabled)
                </label>
              </div>
            </div>

            <div className="aeo-footnote">
              <Mail size={15} />
              <span>Invite email uses your HRMS mailer configuration when available; otherwise copy credentials manually.</span>
            </div>
          </section>
        )}

        <div className="aeo-nav">
          <button type="button" className="aeo-btn ghost" onClick={goBack} disabled={step === 1 || createEmployeeSubmitting}>
            <ChevronLeft size={16} /> Back
          </button>
          {step < 5 ? (
            <button type="button" className="aeo-btn primary" onClick={goNext}>
              Continue <ChevronRight size={16} />
            </button>
          ) : (
            <button type="submit" className="aeo-btn primary" disabled={createEmployeeSubmitting}>
              {createEmployeeSubmitting ? (
                <>
                  <Loader2 size={16} className="hrms-spin" /> Saving…
                </>
              ) : (
                'Complete onboarding'
              )}
            </button>
          )}
        </div>
      </div>

      <aside className="aeo-side" aria-label="Onboarding summary">
        <div className="aeo-side-card">
          <p className="aeo-side-kicker">Live summary</p>
          <h3 className="aeo-side-name">{String(newEmp.name || 'New employee').trim() || 'New employee'}</h3>
          <dl className="aeo-side-dl">
            <div>
              <dt>Company</dt>
              <dd>{orgSummary.company}</dd>
            </div>
            <div>
              <dt>Department</dt>
              <dd>{newEmp.department || '—'}</dd>
            </div>
            <div>
              <dt>Designation</dt>
              <dd>{newEmp.designation || '—'}</dd>
            </div>
            <div>
              <dt>Salary</dt>
              <dd className="aeo-em">
                {salaryAmount ? formatINR(salaryAmount) : '—'}{' '}
                <span className="aeo-micro">{newEmp.salary_type === 'IN_HAND' ? 'in-hand' : 'gross'}</span>
              </dd>
            </div>
            <div>
              <dt>Joining</dt>
              <dd>{newEmp.date_of_joining || '—'}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{employeeFormRole || '—'}</dd>
            </div>
            <div>
              <dt>Shift policy</dt>
              <dd>{formatShiftSummary(newEmp.work_policy)}</dd>
            </div>
          </dl>
        </div>
      </aside>
    </form>
  )
}
