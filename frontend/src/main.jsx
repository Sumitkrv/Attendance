import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { queryClient, QueryClientProvider } from './hooks/useApiQueries'
import { CompanyProvider } from './context/CompanyContext'
// import './i18n'  // Temporarily commented out until npm install succeeds
import App from './App'
import './styles.css'

class RootErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error) {
    // Keep a visible trace for local debugging when app boot fails.
    // eslint-disable-next-line no-console
    console.error('Root render failed:', error)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    const text = String(this.state.error?.message || 'Unknown render error')
    return (
      <main className="page center" style={{ padding: 20 }}>
        <div className="card auth-card" style={{ maxWidth: 640 }}>
          <h2>App failed to render</h2>
          <p className="muted">{text}</p>
          <div className="row" style={{ gap: 10 }}>
            <button
              type="button"
              className="ghost"
              onClick={() => {
                try {
                  localStorage.removeItem('fa_admin_token')
                  localStorage.removeItem('fa_user_token')
                } catch {
                  // no-op
                }
                window.location.reload()
              }}
            >
              Clear session & reload
            </button>
            <button type="button" onClick={() => window.location.reload()}>Reload</button>
          </div>
        </div>
      </main>
    )
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <RootErrorBoundary>
    <QueryClientProvider client={queryClient}>
      <CompanyProvider>
        <HashRouter
          future={{
            v7_startTransition: true,
            v7_relativeSplatPath: true,
          }}
        >
          <App />
        </HashRouter>
      </CompanyProvider>
    </QueryClientProvider>
  </RootErrorBoundary>
)
