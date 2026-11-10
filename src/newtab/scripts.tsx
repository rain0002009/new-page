import React from 'react'
import ReactDOM from 'react-dom/client'
import NewtabApp from './NewTabApp'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import './styles.css'

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 1000 } } })

const root = ReactDOM.createRoot(document.getElementById('root')!)

root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}><NewtabApp /></QueryClientProvider>
  </React.StrictMode>
)
