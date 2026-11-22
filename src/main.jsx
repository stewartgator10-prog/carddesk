import React from 'react'
import ReactDOM from 'react-dom/client'
import CardDeskPro from './CardDeskPro.jsx'
import AuthGate from './AuthGate.jsx'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>{(session) => <CardDeskPro key={session.user.id} session={session} />}</AuthGate>
  </React.StrictMode>,
)
