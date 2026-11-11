import React from 'react'
import ReactDOM from 'react-dom/client'
import NewtabApp, { stateKey } from './NewTabApp'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { readLocalSnapshot } from '../core/local-workspace'
import './styles.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 1000 } } })

const root = ReactDOM.createRoot(document.getElementById('root')!)

async function start() {
  // Seed the first render from disk without waiting for the background worker.
  // Mark it stale so the normal snapshot query refreshes it after rendering.
  const local = await readLocalSnapshot().catch(() => undefined)
  if (local) queryClient.setQueryData(stateKey, local, { updatedAt: 0 })
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}><NewtabApp /></QueryClientProvider>
    </React.StrictMode>
  )
}
void start()
