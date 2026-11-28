import React, { Suspense, lazy } from 'react'
import '@fontsource-variable/nunito'
import '@fontsource/zen-maru-gothic/latin-700.css'
import '@fontsource/zen-maru-gothic/latin-900.css'
import './theme.css'
import ReactDOM from 'react-dom/client'
import CardDeskPro from './CardDeskPro.jsx'
import AuthGate from './AuthGate.jsx'
import { IS_TYCHE } from './brand.jsx'

// The consent page for AI app connections (Claude app connector) has its own small screen.
const OAuthConsent = lazy(() => import('./OAuthConsent.jsx'))
const Home = lazy(() => import('./Home.jsx'))
const path = window.location.pathname
const isConsent = path.startsWith('/oauth/consent')

// Tyche Cards: the public homepage lives at /, /pricing and /legal/*; the app at /app.
// Links that belong to the app but arrive at / (eBay connect, email confirmation, old ?tab= links)
// are passed on to /app. The founder site (CardDesk) keeps the app at /.
const appBound = /[?&](tab|ebay|code|error|error_description|billing)=/.test(window.location.search) || /access_token|type=recovery/.test(window.location.hash)
if (IS_TYCHE && path === '/' && appBound) window.location.replace(`/app${window.location.search}${window.location.hash}`)
const isHome = IS_TYCHE && !appBound && (path === '/' || path === '/pricing' || path.startsWith('/legal/'))

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isHome
      ? <Suspense fallback={null}><Home /></Suspense>
      : <AuthGate>{(session) => (isConsent
        ? <Suspense fallback={null}><OAuthConsent session={session} /></Suspense>
        : <CardDeskPro key={session.user.id} session={session} />)}</AuthGate>}
  </React.StrictMode>,
)
