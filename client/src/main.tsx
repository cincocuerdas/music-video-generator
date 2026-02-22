import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import 'sileo/styles.css'
import App from './App.tsx'
import { ensureDevAuthToken } from './services/authBootstrap.ts'

void ensureDevAuthToken().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
