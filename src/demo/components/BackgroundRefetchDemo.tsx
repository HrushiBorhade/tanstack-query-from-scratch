import { useQuery } from '@react/useQuery'
import { api } from '../api'

export function BackgroundRefetchDemo() {
  const { data, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ['todos', 'bg'],
    queryFn: () => api.fetchTodos(400),
    staleTime: 0,
  })

  return (
    <section>
      <h2>3. Background Refetch on Focus</h2>
      <p style={{fontSize:'0.85rem',color:'#555'}}>Switch to another tab, wait a moment, then come back. The cache will auto-refresh.</p>
      <p>
        Status: {isFetching ? '\u27f3 fetching\u2026' : '\u2713 idle'} |{' '}
        Last updated: <strong>{dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : 'never'}</strong>
      </p>
      <p>{data?.length ?? 0} todos cached</p>
    </section>
  )
}
