/**
 * Slim contextual banner so admins and employees always see which company scope applies.
 */
export default function CurrentCompanyBanner({ companyName }) {
  const label = String(companyName || '').trim()
  if (!label) return null
  return (
    <div className="hrms-current-company-banner" role="status" aria-live="polite">
      <span className="hrms-current-company-label">Current Company:</span>
      <span className="hrms-current-company-name">{label}</span>
    </div>
  )
}
