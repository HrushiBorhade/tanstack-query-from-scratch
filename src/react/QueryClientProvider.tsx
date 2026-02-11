import { createContext, useContext, useEffect, type ReactNode } from 'react'
import { QueryClient } from '@core/index'

const QueryClientContext = createContext<QueryClient | null>(null)

export function QueryClientProvider({
  client,
  children,
}: {
  client: QueryClient
  children: ReactNode
}) {
  useEffect(() => {
    client.mount()
    return () => client.unmount()
  }, [client])

  return (
    <QueryClientContext.Provider value={client}>
      {children}
    </QueryClientContext.Provider>
  )
}

export function useQueryClient(): QueryClient {
  const client = useContext(QueryClientContext)
  if (!client) {
    throw new Error('useQueryClient must be used within a QueryClientProvider')
  }
  return client
}
