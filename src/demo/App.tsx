import { QueryClient } from '@core/index'
import { QueryClientProvider } from '@react/QueryClientProvider'
import { BasicQuery } from './components/BasicQuery'
import { StaleTimeDemo } from './components/StaleTimeDemo'
import { BackgroundRefetchDemo } from './components/BackgroundRefetchDemo'
import { MutationDemo } from './components/MutationDemo'
import { OptimisticUpdateDemo } from './components/OptimisticUpdateDemo'
import { RetryDemo } from './components/RetryDemo'
import { DependentQueryDemo } from './components/DependentQueryDemo'
import { GarbageCollectionDemo } from './components/GarbageCollectionDemo'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      gcTime: 5 * 60 * 1000, // 5 min
    },
  },
})

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div style={{ maxWidth: '800px', margin: '0 auto', padding: '20px', fontFamily: 'system-ui, sans-serif' }}>
        <h1 style={{ borderBottom: '2px solid #0ea5e9', paddingBottom: '8px' }}>
          TanStack Query — Built from Scratch
        </h1>
        <p style={{ color: '#555', marginBottom: '24px' }}>
          Framework-agnostic query caching, deduplication, background refetch, retry, and mutations — implemented without any third-party query library.
        </p>

        <div style={{ display: 'grid', gap: '24px' }}>
          <BasicQuery />
          <StaleTimeDemo />
          <BackgroundRefetchDemo />
          <MutationDemo />
          <OptimisticUpdateDemo />
          <RetryDemo />
          <DependentQueryDemo />
          <GarbageCollectionDemo />
        </div>
      </div>
    </QueryClientProvider>
  )
}
