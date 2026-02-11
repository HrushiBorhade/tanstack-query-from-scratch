import { useState } from 'react'
import { useQuery } from '@react/useQuery'
import { useQueryClient } from '@react/useQueryClient'
import { api } from '../api'

function GcQuery() {
  const { data, isLoading } = useQuery({
    queryKey: ['todos', 'gc-demo'],
    queryFn: () => api.fetchTodos(400),
    gcTime: 3000, // 3 seconds after unmount → removed from cache
    staleTime: 60000,
  })
  return isLoading ? <p>Loading…</p> : <p>&#10003; {data?.length} todos cached (gcTime = 3s)</p>
}

export function GarbageCollectionDemo() {
  const [mounted, setMounted] = useState(true)
  const qc = useQueryClient()
  const hasCachedData = qc.getQueryData(['todos', 'gc-demo']) !== undefined

  return (
    <section>
      <h2>8. Garbage Collection</h2>
      <p style={{fontSize:'0.85rem',color:'#555'}}>Unmount the component. After 3s the cache entry is removed.</p>
      {mounted && <GcQuery />}
      <p>Cache state: {hasCachedData ? 'data in cache' : 'cache cleared'}</p>
      <button onClick={() => setMounted((v) => !v)}>
        {mounted ? 'Unmount (start GC timer)' : 'Remount'}
      </button>
    </section>
  )
}
