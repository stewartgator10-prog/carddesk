import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import CardDeskPro from './CardDeskPro.jsx'
import AuthGate from './AuthGate.jsx'

// The consent page for AI app connections (Claude app connector) has its own small screen.
const OAuthConsent = lazy(() => import('./OAuthConsent.jsx'))
const isConsent = window.location.pathname.startsWith('/oauth/consent')

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>{(session) => (isConsent
      ? <Suspense fallback={null}><OAuthConsent session={session} /></Suspense>
      : <CardDeskPro key={session.user.id} session={session} />)}</AuthGate>
  </React.StrictMode>,
)
