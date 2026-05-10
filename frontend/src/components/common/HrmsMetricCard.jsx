import { Activity } from 'lucide-react'
import AnimatedCounter from './AnimatedCounter'

export default function HrmsMetricCard({
  icon: Icon,
  title,
  value,
  valueText = '',
  subtitle,
  contextMessage = '',
  trend = '',
  trendDirection = 'up',
  tone = 'neutral',
  loading = false,
  hasBaseline = true,
  onClick = null,
  ariaLabel = '',
  cardClassName = '',
}) {
  const numericValue = Number(value)
  const showContextMessage = !loading
    && !!contextMessage
    && !valueText
    && Number.isFinite(numericValue)
    && numericValue === 0
  const hideMeaninglessTrend = Number.isFinite(numericValue) && numericValue === 0 && !hasBaseline
  const showTrend = !!trend && !hideMeaninglessTrend
  const isClickable = typeof onClick === 'function'
  const CardTag = isClickable ? 'button' : 'article'

  return (
    <CardTag
      className={`card hrms-metric-card ${tone} ${loading ? 'is-loading' : ''} ${isClickable ? 'is-clickable' : ''} ${cardClassName}`.trim()}
      {...(isClickable ? { type: 'button', onClick, 'aria-label': ariaLabel || `${title} details` } : {})}
    >
      <div className="hrms-metric-header">
        <div className="hrms-metric-icon-wrap">{Icon ? <Icon size={18} /> : <Activity size={18} />}</div>
        {showTrend && (
          <span className={`hrms-trend-pill ${trendDirection === 'down' ? 'down' : 'up'}`}>
            {trendDirection === 'down' ? '↓' : '↑'} {trend}
          </span>
        )}
      </div>
      <p className="hrms-metric-title">{title}</p>
      <strong className="hrms-metric-value">{loading ? '—' : (valueText || <AnimatedCounter value={value} />)}</strong>
      <p className="hrms-metric-subtitle">{subtitle}</p>
      {showContextMessage && <p className="hrms-metric-context muted small">{contextMessage}</p>}
      {loading && <div className="hrms-shimmer" aria-hidden="true" />}
    </CardTag>
  )
}
