import { useEffect, useMemo, useState } from 'react'
import { Download, FileText, Wallet } from 'lucide-react'
import { apiFetch } from '../../api'
import { BRAND_NAME } from '../../config/constants'
import { BASE_URL } from '../../config/apiConfig'
import { formatDateInput } from '../../utils/helpers'

const REIMBURSEMENT_DRAFT_KEY = 'employee_reimbursement_draft_v1'

const EXPENSE_TYPES = [
  { value: 'travel', label: 'Travel' },
  { value: 'food', label: 'Food' },
  { value: 'internet', label: 'Internet' },
  { value: 'medical', label: 'Medical' },
  { value: 'office_expense', label: 'Office Expense' },
  { value: 'client_meeting', label: 'Client Meeting' },
]

const PAYMENT_METHODS = ['Cash', 'Bank Transfer', 'UPI', 'Card', 'Petty Cash']

function readDraft() {
  try {
    const raw = localStorage.getItem(REIMBURSEMENT_DRAFT_KEY)
    if (!raw) {
      return {
        expenseType: 'travel',
        amount: '',
        expenseDate: formatDateInput(),
        description: '',
        paymentMethod: 'Bank Transfer',
        attachment: null,
        attachmentName: '',
      }
    }
    const parsed = JSON.parse(raw)
    return {
      expenseType: String(parsed?.expenseType || 'travel'),
      amount: String(parsed?.amount || ''),
      expenseDate: String(parsed?.expenseDate || formatDateInput()),
      description: String(parsed?.description || ''),
      paymentMethod: String(parsed?.paymentMethod || 'Bank Transfer'),
      attachment: null,
      attachmentName: '',
    }
  } catch {
    return {
      expenseType: 'travel',
      amount: '',
      expenseDate: formatDateInput(),
      description: '',
      paymentMethod: 'Bank Transfer',
      attachment: null,
      attachmentName: '',
    }
  }
}

function saveDraft(form) {
  try {
    localStorage.setItem(REIMBURSEMENT_DRAFT_KEY, JSON.stringify({
      expenseType: form.expenseType,
      amount: form.amount,
      expenseDate: form.expenseDate,
      description: form.description,
      paymentMethod: form.paymentMethod,
    }))
  } catch {
    // no-op
  }
}

function formatMoney(value) {
  const n = Number(value || 0)
  if (!Number.isFinite(n)) return '₹0.00'
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function monthLabel(year, month) {
  if (!Number.isFinite(Number(year)) || !Number.isFinite(Number(month))) return '-'
  const d = new Date(Number(year), Number(month) - 1, 1)
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

function payslipStatusKey(row) {
  const key = String(row?.status || '').trim().toLowerCase()
  if (key === 'paid') return 'paid'
  if (key === 'published') return 'published'
  if (key === 'pending') return 'pending'
  return 'processing'
}

function payslipStatusLabel(row) {
  const key = payslipStatusKey(row)
  if (key === 'paid') return 'Paid'
  if (key === 'published') return 'Published'
  if (key === 'pending') return 'Pending'
  return 'Processing'
}

const EMPTY_TAX_DOCS = { form16: null, pf: null, salary_certificate: null, other_documents: [] }

function openEmployeeAssetUrl(fileUrl) {
  const raw = String(fileUrl || '').trim()
  if (!raw) return
  const token = typeof localStorage !== 'undefined' ? (localStorage.getItem('fa_user_token') || '') : ''
  if (/^https?:\/\//i.test(raw)) {
    window.open(raw, '_blank', 'noopener,noreferrer')
    return
  }
  const base = String(BASE_URL || '').replace(/\/+$/, '')
  const path = raw.startsWith('/') ? raw : `/${raw}`
  const sep = path.includes('?') ? '&' : '?'
  const url = token ? `${base}${path}${sep}token=${encodeURIComponent(token)}` : `${base}${path}`
  window.open(url, '_blank', 'noopener,noreferrer')
}

function reimbursementStatusKey(row) {
  const key = String(row?.status || '').trim().toLowerCase()
  if (key === 'paid') return 'paid'
  if (key === 'approved') return 'approved'
  if (key === 'rejected' || key === 'conflict') return 'rejected'
  return 'pending'
}

function reimbursementStatusLabel(row) {
  const key = reimbursementStatusKey(row)
  if (key === 'paid') return 'Paid'
  if (key === 'approved') return 'Approved'
  if (key === 'rejected') return 'Rejected'
  return 'Pending'
}

export default function PayrollPanel() {
  const [loading, setLoading] = useState(false)
  const [slips, setSlips] = useState([])
  const [summary, setSummary] = useState({
    current_month_salary: 0,
    net_pay: 0,
    pending_reimbursement: 0,
    bonus_incentives: 0,
    tax_deduction: 0,
  })
  const [reimbursements, setReimbursements] = useState([])
  const [reimbursementForm, setReimbursementForm] = useState(readDraft)
  const [submitting, setSubmitting] = useState(false)
  const [notice, setNotice] = useState({ type: '', text: '' })
  const [taxDocs, setTaxDocs] = useState(EMPTY_TAX_DOCS)

  async function loadPayroll() {
    setLoading(true)
    try {
      const [summaryResp, slipsResp, reimbResp, taxResp] = await Promise.all([
        apiFetch('/user/payroll/summary'),
        apiFetch('/user/payroll/payslips'),
        apiFetch('/user/reimbursements'),
        apiFetch('/user/payroll/tax-documents').catch(() => null),
      ])
      setSummary({
        current_month_salary: Number(summaryResp?.current_month_salary || 0),
        net_pay: Number(summaryResp?.net_pay || 0),
        pending_reimbursement: Number(summaryResp?.pending_reimbursement || 0),
        bonus_incentives: Number(summaryResp?.bonus_incentives || 0),
        tax_deduction: Number(summaryResp?.tax_deduction || 0),
      })
      setSlips(Array.isArray(slipsResp) ? slipsResp : [])
      setReimbursements(Array.isArray(reimbResp) ? reimbResp : [])
      const td = taxResp && typeof taxResp === 'object' ? taxResp : EMPTY_TAX_DOCS
      setTaxDocs({
        ...EMPTY_TAX_DOCS,
        ...td,
        other_documents: Array.isArray(td.other_documents) ? td.other_documents : [],
      })
      setNotice({ type: '', text: '' })
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to load payroll data' })
      setSlips([])
      setReimbursements([])
      setTaxDocs(EMPTY_TAX_DOCS)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadPayroll()
  }, [])

  const summaryCards = useMemo(() => ([
    { title: 'Current Month Salary', value: formatMoney(summary.current_month_salary) },
    { title: 'Net Pay', value: formatMoney(summary.net_pay) },
    { title: 'Pending Reimbursement', value: formatMoney(summary.pending_reimbursement) },
    { title: 'Bonus / Incentives', value: formatMoney(summary.bonus_incentives) },
    { title: 'Tax Deduction', value: formatMoney(summary.tax_deduction) },
  ]), [summary])

  async function downloadPayslipPdf(row) {
    try {
      const { jsPDF } = await import('jspdf')
      const pdf = new jsPDF()
      let y = 16

      const employeeName = String(row?.employee_name || 'Employee')
      const employeeId = String(row?.employee_id || '-')
      const department = String(row?.department || 'General')
      const salaryMonth = monthLabel(row?.year, row?.month)
      const earnings = Array.isArray(row?.earnings) ? row.earnings : []
      const deductions = Array.isArray(row?.deductions) ? row.deductions : []

      pdf.setFontSize(16)
      pdf.text(`${BRAND_NAME} - Salary Slip`, 14, y)
      y += 8
      pdf.setFontSize(10)
      pdf.text(`Company Name: ${BRAND_NAME}`, 14, y)
      y += 6
      pdf.text(`Employee Name: ${employeeName}`, 14, y)
      y += 6
      pdf.text(`Employee ID: ${employeeId}`, 14, y)
      y += 6
      pdf.text(`Department: ${department}`, 14, y)
      y += 6
      pdf.text(`Salary Month: ${salaryMonth}`, 14, y)
      y += 10

      pdf.setFontSize(12)
      pdf.text('Earnings', 14, y)
      y += 6
      pdf.setFontSize(10)
      earnings.forEach((item) => {
        const line = `${String(item?.name || item?.code || 'Component')}: ${formatMoney(item?.amount || 0)}`
        pdf.text(line, 14, y)
        y += 5
      })

      y += 4
      pdf.setFontSize(12)
      pdf.text('Deductions', 14, y)
      y += 6
      pdf.setFontSize(10)
      deductions.forEach((item) => {
        const line = `${String(item?.name || item?.code || 'Deduction')}: ${formatMoney(item?.amount || 0)}`
        pdf.text(line, 14, y)
        y += 5
      })

      y += 6
      pdf.setFontSize(11)
      pdf.text(`Gross Salary: ${formatMoney(row?.gross_salary || 0)}`, 14, y)
      y += 6
      pdf.text(`Total Deductions: ${formatMoney(row?.total_deductions || 0)}`, 14, y)
      y += 6
      pdf.text(`Final Net Pay: ${formatMoney(row?.net_salary || 0)}`, 14, y)
      y += 12

      pdf.text('HR Signature: ____________________', 14, y)
      pdf.save(`payslip_${employeeName.replace(/\s+/g, '_')}_${row?.year}_${row?.month}.pdf`)
    } catch {
      setNotice({ type: 'error', text: 'Unable to generate payslip PDF right now.' })
    }
  }

  async function submitReimbursement() {
    const expenseType = String(reimbursementForm.expenseType || '').trim().toLowerCase()
    const amount = Number(reimbursementForm.amount)
    const expenseDate = String(reimbursementForm.expenseDate || '').trim()
    const description = String(reimbursementForm.description || '').trim()

    if (!expenseType || !Number.isFinite(amount) || amount <= 0 || !expenseDate || !description) {
      setNotice({ type: 'error', text: 'Expense type, amount, date, and description are required.' })
      return
    }

    setSubmitting(true)
    try {
      const form = new FormData()
      form.append('expense_type', expenseType)
      form.append('amount', String(amount))
      form.append('expense_date', expenseDate)
      form.append('description', description)
      form.append('payment_method', String(reimbursementForm.paymentMethod || '').trim())
      if (reimbursementForm.attachment) form.append('bill', reimbursementForm.attachment)

      await apiFetch('/user/reimbursements', {
        method: 'POST',
        body: form,
      })

      localStorage.removeItem(REIMBURSEMENT_DRAFT_KEY)
      setReimbursementForm({
        expenseType: 'travel',
        amount: '',
        expenseDate: formatDateInput(),
        description: '',
        paymentMethod: 'Bank Transfer',
        attachment: null,
        attachmentName: '',
      })
      setNotice({ type: 'success', text: 'Reimbursement submitted and synced to Admin attendance requests.' })
      await loadPayroll()
    } catch (err) {
      setNotice({ type: 'error', text: err?.message || 'Unable to submit reimbursement' })
    } finally {
      setSubmitting(false)
    }
  }

  function saveReimbursementDraft() {
    saveDraft(reimbursementForm)
    setNotice({ type: 'success', text: 'Reimbursement draft saved.' })
  }

  return (
    <section className="employee-payroll-shell">
      <div className="employee-payroll-summary-grid">
        {summaryCards.map((card) => (
          <article key={card.title} className="card employee-payroll-summary-card">
            <p>{card.title}</p>
            <strong>{card.value}</strong>
          </article>
        ))}
      </div>

      <article className="card employee-payroll-slips-card">
        <div className="employee-payroll-section-title">
          <Wallet size={18} />
          <h3>Salary Slips</h3>
        </div>
        <div className="employee-payroll-table-wrap">
          <table className="employee-payroll-table">
            <thead>
              <tr>
                <th>Month</th>
                <th>Basic Salary</th>
                <th>Allowances</th>
                <th>Bonus</th>
                <th>Deductions</th>
                <th>PF Contribution</th>
                <th>Tax Deduction</th>
                <th>Net Salary</th>
                <th>Payment Status</th>
                <th>Payment Date</th>
                <th>Download PDF</th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={11}>Loading salary slips...</td>
                </tr>
              )}
              {!loading && slips.map((row) => {
                const earnings = Array.isArray(row?.earnings) ? row.earnings : []
                const deductions = Array.isArray(row?.deductions) ? row.deductions : []
                const basic = Number((earnings.find((e) => String(e?.code || '').toUpperCase() === 'BASIC') || {}).amount || 0)
                const allowances = earnings
                  .filter((e) => String(e?.code || '').toUpperCase() !== 'BASIC' && !['BONUS', 'INCENTIVE', 'INC'].includes(String(e?.code || '').toUpperCase()))
                  .reduce((sum, e) => sum + Number(e?.amount || 0), 0)
                const bonus = earnings
                  .filter((e) => ['BONUS', 'INCENTIVE', 'INC'].includes(String(e?.code || '').toUpperCase()))
                  .reduce((sum, e) => sum + Number(e?.amount || 0), 0)
                const pf = Number((deductions.find((d) => String(d?.code || '').toUpperCase() === 'PF') || {}).amount || row?.employer_pf || 0)
                const tax = Number((deductions.find((d) => String(d?.code || '').toUpperCase() === 'TDS') || {}).amount || 0)
                const status = payslipStatusKey(row)
                return (
                  <tr key={row.id}>
                    <td>
                      {monthLabel(row?.year, row?.month)}
                      {String(row?.payslip_kind || '').toLowerCase() === 'interim_mtd' ? (
                        <span className="employee-payslip-kind-tag" title="Interim slip: net figure is month-to-date accrued (same as admin preview)">MTD</span>
                      ) : null}
                    </td>
                    <td>{formatMoney(basic)}</td>
                    <td>{formatMoney(allowances)}</td>
                    <td>{formatMoney(bonus)}</td>
                    <td>{formatMoney(row?.total_deductions || 0)}</td>
                    <td>{formatMoney(pf)}</td>
                    <td>{formatMoney(tax)}</td>
                    <td>{formatMoney(row?.net_salary || 0)}</td>
                    <td><span className={`employee-payroll-status-badge ${status}`}>{payslipStatusLabel(row)}</span></td>
                    <td>{String(row?.paid_at || row?.generated_at || '-').slice(0, 10) || '-'}</td>
                    <td>
                      <button type="button" className="ghost" onClick={() => downloadPayslipPdf(row)}>
                        <Download size={14} /> PDF
                      </button>
                    </td>
                  </tr>
                )
              })}
              {!loading && !slips.length && (
                <tr>
                  <td colSpan={11}>No salary slips found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      <article className="card employee-payroll-reimbursement-card">
        <div className="employee-payroll-section-title">
          <FileText size={18} />
          <h3>Reimbursements</h3>
        </div>

        <div className="employee-payroll-form-grid">
          <label>
            <span>Expense Type</span>
            <select value={reimbursementForm.expenseType} onChange={(e) => setReimbursementForm((old) => ({ ...old, expenseType: e.target.value }))}>
              {EXPENSE_TYPES.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
            </select>
          </label>

          <label>
            <span>Amount</span>
            <input type="number" min="0" step="0.01" value={reimbursementForm.amount} onChange={(e) => setReimbursementForm((old) => ({ ...old, amount: e.target.value }))} />
          </label>

          <label>
            <span>Expense Date</span>
            <input type="date" value={reimbursementForm.expenseDate} onChange={(e) => setReimbursementForm((old) => ({ ...old, expenseDate: e.target.value }))} />
          </label>

          <label>
            <span>Payment Method</span>
            <select value={reimbursementForm.paymentMethod} onChange={(e) => setReimbursementForm((old) => ({ ...old, paymentMethod: e.target.value }))}>
              {PAYMENT_METHODS.map((method) => <option key={method} value={method}>{method}</option>)}
            </select>
          </label>

          <label className="employee-payroll-form-full">
            <span>Description</span>
            <textarea rows={3} value={reimbursementForm.description} onChange={(e) => setReimbursementForm((old) => ({ ...old, description: e.target.value }))} />
          </label>

          <label>
            <span>Upload Bill / Invoice</span>
            <input
              type="file"
              onChange={(e) => {
                const file = e.target?.files?.[0] || null
                setReimbursementForm((old) => ({ ...old, attachment: file, attachmentName: file?.name || '' }))
              }}
            />
            {!!reimbursementForm.attachmentName && <small>{reimbursementForm.attachmentName}</small>}
          </label>
        </div>

        <div className="employee-payroll-form-actions">
          <button type="button" onClick={submitReimbursement} disabled={submitting}>{submitting ? 'Submitting...' : 'Submit Request'}</button>
          <button type="button" className="ghost" onClick={saveReimbursementDraft}>Save Draft</button>
        </div>
      </article>

      <article className="card employee-payroll-reimbursement-history-card">
        <h3>Reimbursement History</h3>
        <div className="employee-payroll-table-wrap">
          <table className="employee-payroll-table">
            <thead>
              <tr>
                <th>Request Date</th>
                <th>Expense Type</th>
                <th>Amount</th>
                <th>Status</th>
                <th>HR Remarks</th>
                <th>Approved By</th>
                <th>Payment Date</th>
              </tr>
            </thead>
            <tbody>
              {reimbursements.map((row) => {
                const status = reimbursementStatusKey(row)
                return (
                  <tr key={row.id}>
                    <td>{String(row?.date || row?.from_date || '-')}</td>
                    <td>{String(row?.expense_type || '-').replace(/_/g, ' ')}</td>
                    <td>{formatMoney(row?.amount || 0)}</td>
                    <td><span className={`employee-payroll-status-badge ${status}`}>{reimbursementStatusLabel(row)}</span></td>
                    <td>{String(row?.review_comment || row?.rejection_reason || '-')}</td>
                    <td>{String(row?.paid_by || row?.approved_by || row?.rejected_by || '-')}</td>
                    <td>{String(row?.payment_date || '').slice(0, 10) || '-'}</td>
                  </tr>
                )
              })}
              {!reimbursements.length && (
                <tr>
                  <td colSpan={7}>No reimbursement requests found.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </article>

      <article className="card employee-payroll-documents-card">
        <h3>Tax documents</h3>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Shown when HR uploads files to your profile (name hints: Form 16, PF, salary certificate).
        </p>
        <div className="employee-payroll-doc-grid">
          <div className="employee-payroll-doc-item">
            <div>
              <p>Form 16</p>
              {!taxDocs.form16 && <p className="employee-payroll-doc-muted">Not uploaded yet</p>}
            </div>
            <button
              type="button"
              className="ghost"
              disabled={!taxDocs.form16?.file_url}
              onClick={() => openEmployeeAssetUrl(taxDocs.form16?.file_url)}
            >
              View
            </button>
          </div>
          <div className="employee-payroll-doc-item">
            <div>
              <p>PF details</p>
              {!taxDocs.pf && <p className="employee-payroll-doc-muted">Not uploaded yet</p>}
            </div>
            <button
              type="button"
              className="ghost"
              disabled={!taxDocs.pf?.file_url}
              onClick={() => openEmployeeAssetUrl(taxDocs.pf?.file_url)}
            >
              View
            </button>
          </div>
          <div className="employee-payroll-doc-item">
            <div>
              <p>Salary certificate</p>
              {!taxDocs.salary_certificate && <p className="employee-payroll-doc-muted">Not uploaded yet</p>}
            </div>
            <button
              type="button"
              className="ghost"
              disabled={!taxDocs.salary_certificate?.file_url}
              onClick={() => openEmployeeAssetUrl(taxDocs.salary_certificate?.file_url)}
            >
              View
            </button>
          </div>
        </div>
        {Array.isArray(taxDocs.other_documents) && taxDocs.other_documents.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <p style={{ fontWeight: 600, margin: '0 0 8px' }}>Other documents</p>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {taxDocs.other_documents.slice(0, 8).map((doc) => (
                <li key={doc.id} style={{ marginBottom: 6 }}>
                  <button
                    type="button"
                    className="ghost"
                    style={{ padding: 0, height: 'auto', fontWeight: 600 }}
                    onClick={() => openEmployeeAssetUrl(doc.file_url)}
                  >
                    {doc.file_name || 'Document'}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </article>

      {!!notice.text && (
        <p className={`employee-payroll-notice ${notice.type === 'error' ? 'error' : 'success'}`}>{notice.text}</p>
      )}
    </section>
  )
}
