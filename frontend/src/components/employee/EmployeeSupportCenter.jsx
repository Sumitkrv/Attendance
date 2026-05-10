import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, MessageCircle, Search } from 'lucide-react'
import { apiFetch } from '../../api'
import './EmployeeSupportCenter.css'

const CATEGORY_OPTIONS = [
  { value: 'hr_support', label: 'HR Support' },
  { value: 'salary_issue', label: 'Salary Issue' },
  { value: 'attendance_issue', label: 'Attendance Issue' },
  { value: 'leave_issue', label: 'Leave Issue' },
  { value: 'asset_issue', label: 'Asset Issue' },
  { value: 'it_support', label: 'IT Support' },
  { value: 'login_problem', label: 'Login Problem' },
  { value: 'system_error', label: 'System Error' },
  { value: 'payroll_problem', label: 'Payroll Problem' },
  { value: 'document_request', label: 'Document Request' },
]

const PRIORITY_OPTIONS = ['high', 'medium', 'low']
const CONTACT_OPTIONS = ['email', 'phone', 'chat', 'any']
const HELPDESK_DRAFT_KEY = 'employee_helpdesk_ticket_draft_v1'

const POLICY_LIBRARY = [
  { id: 'attendance_policy', title: 'Attendance Policy', updatedAt: '2026-04-20', summary: 'Attendance rules, late marks, and regularization flow.' },
  { id: 'leave_policy', title: 'Leave Policy', updatedAt: '2026-04-18', summary: 'Leave categories, entitlement, and approval SLAs.' },
  { id: 'wfh_policy', title: 'Work From Home Policy', updatedAt: '2026-04-15', summary: 'WFH eligibility, approval matrix, and compliance.' },
  { id: 'code_of_conduct', title: 'Code of Conduct', updatedAt: '2026-04-07', summary: 'Expected behavior, ethics, and disciplinary policy.' },
  { id: 'asset_usage_policy', title: 'Asset Usage Policy', updatedAt: '2026-04-22', summary: 'Asset handling, return obligations, and liabilities.' },
  { id: 'payroll_policy', title: 'Payroll Policy', updatedAt: '2026-04-09', summary: 'Payroll cycle, cutoffs, deductions, and disbursement.' },
  { id: 'security_policy', title: 'Security Policy', updatedAt: '2026-04-23', summary: 'Password, data privacy, and endpoint security standards.' },
  { id: 'company_handbook', title: 'Company Handbook', updatedAt: '2026-04-19', summary: 'Overall company handbook for all employees.' },
  { id: 'joining_exit_policy', title: 'Joining / Exit Policies', updatedAt: '2026-04-16', summary: 'Onboarding and separation policy checklist.' },
]

function badgeClass(status = '') {
  const key = String(status || '').toLowerCase()
  if (['resolved', 'closed'].includes(key)) return 'ok'
  if (['in_progress'].includes(key)) return 'warn'
  if (['rejected'].includes(key)) return 'danger'
  return ''
}

function readDraft() {
  try {
    const raw = localStorage.getItem(HELPDESK_DRAFT_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function saveDraft(payload) {
  try {
    localStorage.setItem(HELPDESK_DRAFT_KEY, JSON.stringify(payload || {}))
  } catch {
    // no-op
  }
}

export default function EmployeeSupportCenter({ activeItem = 'support-helpdesk' }) {
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [tickets, setTickets] = useState([])
  const [ticketsLoading, setTicketsLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [policySearch, setPolicySearch] = useState('')

  const [form, setForm] = useState(() => {
    const draft = readDraft()
    return {
      category: String(draft?.category || 'hr_support'),
      subject: String(draft?.subject || ''),
      priority: String(draft?.priority || 'medium'),
      description: String(draft?.description || ''),
      preferredContactMethod: String(draft?.preferredContactMethod || 'email'),
      attachment: null,
      attachmentName: '',
    }
  })

  const [chatTab, setChatTab] = useState('hr')
  const [chatInput, setChatInput] = useState('')
  const [chatMessages, setChatMessages] = useState([
    { id: 'seed1', by: 'support', team: 'hr', text: 'Hello! HR support is online. How can we help?' },
    { id: 'seed2', by: 'support', team: 'it', text: 'Hi, IT desk here. Share your system issue and we will assist.' },
  ])

  const showHelpdesk = activeItem !== 'support-policies'
  const showPolicies = activeItem === 'support-policies'

  async function loadTickets() {
    setTicketsLoading(true)
    try {
      const rows = await apiFetch('/user/helpdesk/tickets')
      setTickets(Array.isArray(rows) ? rows : [])
    } catch (err) {
      setTickets([])
      setNotice({ type: 'error', text: err?.message || 'Unable to load ticket history.' })
    } finally {
      setTicketsLoading(false)
    }
  }

  useEffect(() => {
    loadTickets()
  }, [])

  function saveTicketDraft() {
    saveDraft({
      category: form.category,
      subject: form.subject,
      priority: form.priority,
      description: form.description,
      preferredContactMethod: form.preferredContactMethod,
    })
    setNotice({ type: 'success', text: 'Ticket draft saved.' })
  }

  async function submitTicket() {
    if (!String(form.subject || '').trim() || !String(form.description || '').trim()) {
      setNotice({ type: 'error', text: 'Subject and description are required.' })
      return
    }

    setSubmitting(true)
    try {
      const payload = new FormData()
      payload.append('category', form.category)
      payload.append('subject', form.subject)
      payload.append('priority', form.priority)
      payload.append('description', form.description)
      payload.append('preferred_contact_method', form.preferredContactMethod)
      if (form.attachment) payload.append('attachment', form.attachment)

      await apiFetch('/user/helpdesk/tickets', {
        method: 'POST',
        body: payload,
      })

      localStorage.removeItem(HELPDESK_DRAFT_KEY)
      setForm({
        category: 'hr_support',
        subject: '',
        priority: 'medium',
        description: '',
        preferredContactMethod: 'email',
        attachment: null,
        attachmentName: '',
      })
      setNotice({ type: 'success', text: 'Ticket submitted to Helpdesk and synced with admin panel.' })
      await loadTickets()
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to submit ticket.' })
    } finally {
      setSubmitting(false)
    }
  }

  async function openPolicyPdf(policy, mode = 'view') {
    try {
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF()
      let y = 16
      pdf.setFontSize(16)
      pdf.text(policy.title, 14, y)
      y += 8
      pdf.setFontSize(11)
      pdf.text(`Last Updated: ${policy.updatedAt}`, 14, y)
      y += 8
      const body = [
        policy.summary,
        '',
        'This document contains company-approved HRMS policy guidance.',
        'For policy clarification, raise a Helpdesk ticket under HR Support.',
      ]
      body.forEach((line) => {
        const wrapped = pdf.splitTextToSize(line, 180)
        pdf.text(wrapped, 14, y)
        y += wrapped.length * 6
      })

      if (mode === 'download') {
        pdf.save(`${policy.id}.pdf`)
        return
      }

      const blob = pdf.output('blob')
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank', 'noopener,noreferrer')
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch {
      setNotice({ type: 'error', text: 'Unable to open policy PDF right now.' })
    }
  }

  function sendChatMessage() {
    const text = String(chatInput || '').trim()
    if (!text) return
    const team = chatTab === 'hr' ? 'hr' : 'it'
    setChatMessages((old) => ([
      ...old,
      { id: `u_${Date.now()}`, by: 'employee', team, text },
      { id: `s_${Date.now()}_1`, by: 'support', team, text: team === 'hr' ? 'HR team received your message. We will get back shortly.' : 'IT support acknowledged. We are checking this issue now.' },
    ]))
    setChatInput('')
  }

  const filteredPolicies = useMemo(() => {
    const query = String(policySearch || '').trim().toLowerCase()
    return POLICY_LIBRARY.filter((p) => {
      if (!query) return true
      return String(p.title || '').toLowerCase().includes(query)
        || String(p.summary || '').toLowerCase().includes(query)
    })
  }, [policySearch])

  return (
    <section className="employee-support-shell">
      {notice.text && <p className={notice.type === 'error' ? 'error' : 'success'} style={{ margin: 0 }}>{notice.text}</p>}

      {showHelpdesk && (
        <section className="employee-support-helpdesk-grid" id="employee-support-helpdesk-section">
          <article className="card employee-support-form-card">
            <h3>Helpdesk</h3>
            <p className="muted">Raise support tickets for HR, payroll, attendance, assets, IT, and login/system issues.</p>

            <div className="employee-support-form-grid">
              <label>
                <span>Ticket Category</span>
                <select value={form.category} onChange={(e) => setForm((old) => ({ ...old, category: e.target.value }))}>
                  {CATEGORY_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                </select>
              </label>
              <label>
                <span>Priority Level</span>
                <select value={form.priority} onChange={(e) => setForm((old) => ({ ...old, priority: e.target.value }))}>
                  {PRIORITY_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </label>
              <label className="employee-support-full-row">
                <span>Subject</span>
                <input value={form.subject} onChange={(e) => setForm((old) => ({ ...old, subject: e.target.value }))} placeholder="Enter ticket subject" />
              </label>
              <label className="employee-support-full-row">
                <span>Description</span>
                <textarea rows={4} value={form.description} onChange={(e) => setForm((old) => ({ ...old, description: e.target.value }))} placeholder="Describe your issue" />
              </label>
              <label>
                <span>Preferred Contact Method</span>
                <select value={form.preferredContactMethod} onChange={(e) => setForm((old) => ({ ...old, preferredContactMethod: e.target.value }))}>
                  {CONTACT_OPTIONS.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </select>
              </label>
              <label>
                <span>Attachment Upload</span>
                <input type="file" onChange={(e) => {
                  const file = e.target.files?.[0] || null
                  setForm((old) => ({ ...old, attachment: file, attachmentName: file?.name || '' }))
                }} />
                {!!form.attachmentName && <small className="muted">{form.attachmentName}</small>}
              </label>
            </div>

            <div className="employee-support-actions">
              <button type="button" onClick={submitTicket} disabled={submitting}>{submitting ? 'Submitting...' : 'Submit Ticket'}</button>
              <button type="button" className="ghost" onClick={saveTicketDraft}>Save Draft</button>
            </div>
          </article>

          <article className="card employee-support-history-card">
            <h3>Ticket History</h3>
            <div className="employee-support-table-wrap">
              <table className="employee-support-table">
                <thead>
                  <tr>
                    <th>Ticket ID</th>
                    <th>Category</th>
                    <th>Subject</th>
                    <th>Created Date</th>
                    <th>Status</th>
                    <th>Assigned To</th>
                    <th>Resolution Date</th>
                    <th>Admin Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {ticketsLoading && (
                    <tr><td colSpan={8}>Loading tickets...</td></tr>
                  )}
                  {!ticketsLoading && tickets.map((row) => (
                    <tr key={row.id}>
                      <td>{row.ticket_id || '-'}</td>
                      <td>{String(row.category || '').replace(/_/g, ' ')}</td>
                      <td>{row.subject || '-'}</td>
                      <td>{String(row.created_at || '').slice(0, 10) || '-'}</td>
                      <td><span className={`status-badge ${badgeClass(row.status)}`}>{String(row.status || 'open').replace(/_/g, ' ')}</span></td>
                      <td>{row.assigned_to || row.assigned_team || '-'}</td>
                      <td>{row.resolution_date || '-'}</td>
                      <td>{row.admin_remarks || '-'}</td>
                    </tr>
                  ))}
                  {!ticketsLoading && !tickets.length && (
                    <tr><td colSpan={8}>No tickets yet.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </section>
      )}

      {showPolicies && (
        <section className="employee-support-policy-shell" id="employee-support-policies-section">
          <article className="card employee-support-policy-toolbar">
            <label className="employee-support-policy-search">
              <Search size={15} />
              <input value={policySearch} onChange={(e) => setPolicySearch(e.target.value)} placeholder="Search policy" />
            </label>
          </article>

          <div className="employee-support-policy-grid">
            {filteredPolicies.map((policy) => {
              const updatedRecently = (Date.now() - new Date(policy.updatedAt).getTime()) <= (14 * 24 * 3600 * 1000)
              return (
                <article key={policy.id} className="card employee-support-policy-card">
                  <div className="employee-support-policy-head">
                    <h4>{policy.title}</h4>
                    {updatedRecently && <span className="status-badge warn">Latest Update</span>}
                  </div>
                  <p className="muted small" style={{ margin: '4px 0 0' }}>Updated: {policy.updatedAt}</p>
                  <p className="muted" style={{ margin: '10px 0 0' }}>{policy.summary}</p>
                  <div className="employee-support-policy-actions">
                    <button type="button" className="ghost" onClick={() => openPolicyPdf(policy, 'view')}><FileText size={14} /> View PDF</button>
                    <button type="button" className="ghost" onClick={() => openPolicyPdf(policy, 'download')}><Download size={14} /> Download</button>
                  </div>
                </article>
              )
            })}
            {!filteredPolicies.length && (
              <article className="card employee-support-policy-card"><p className="muted small" style={{ margin: 0 }}>No policy found for this search.</p></article>
            )}
          </div>

          <article className="card employee-support-chat-card">
            <div className="employee-support-chat-head">
              <h3><MessageCircle size={18} /> Live Chat Support</h3>
              <div className="employee-support-chat-tabs">
                <button type="button" className={chatTab === 'hr' ? 'active' : ''} onClick={() => setChatTab('hr')}>Chat with HR</button>
                <button type="button" className={chatTab === 'it' ? 'active' : ''} onClick={() => setChatTab('it')}>Chat with IT</button>
              </div>
            </div>
            <div className="employee-support-chat-body">
              {chatMessages.filter((m) => m.team === chatTab).slice(-8).map((m) => (
                <p key={m.id} className={`employee-support-chat-msg ${m.by === 'employee' ? 'by-employee' : 'by-support'}`}>{m.text}</p>
              ))}
            </div>
            <div className="employee-support-chat-input">
              <input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Type your message" />
              <button type="button" onClick={sendChatMessage}>Send</button>
            </div>
          </article>
        </section>
      )}
    </section>
  )
}
