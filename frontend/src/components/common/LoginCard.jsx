import { useState } from 'react'
import { BRAND_LOGO_SRC, BRAND_NAME } from '../../config/constants'

export default function LoginCard({ title, fields, onSubmit, message }) {
  const [loading, setLoading] = useState(false)
  const [values, setValues] = useState(() => Object.fromEntries(fields.map((f) => [f.name, f.defaultValue || ''])))

  async function submit(e) {
    e.preventDefault()
    setLoading(true)
    try {
      await onSubmit(values)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="card auth-card">
      <div className="brand-inline">
        <img src={BRAND_LOGO_SRC} alt={`${BRAND_NAME} logo`} className="brand-inline-logo" />
        <strong>{BRAND_NAME}</strong>
      </div>
      <h2>{title}</h2>
      <form onSubmit={submit} className="stack">
        {fields.map((field) => (
          <input
            key={field.name}
            type={field.type || 'text'}
            placeholder={field.placeholder}
            value={values[field.name]}
            onChange={(e) => setValues((old) => ({ ...old, [field.name]: e.target.value }))}
            autoComplete={field.autoComplete}
            required
          />
        ))}
        <button disabled={loading}>{loading ? 'Please wait...' : 'Login'}</button>
      </form>
      <p className="muted">{message}</p>
    </div>
  )
}
