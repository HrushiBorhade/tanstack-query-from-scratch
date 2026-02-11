import { useState } from 'react'
import { useQuery } from '@react/useQuery'
import { api } from '../api'

function TodoList({ label }: { label: string }) {
  const { data, isLoading, dataUpdatedAt } = useQuery({
    queryKey: ['todos'],
    queryFn: () => api.fetchTodos(),
    staleTime: 5000,
  })
  return (
    <div style={{border:'1px solid #ccc', padding:'8px', marginBottom:'8px', borderRadius:'4px'}}>
      <strong>{label}</strong>
      {isLoading ? <p>Loading…</p> : <p>&#10003; {data?.length} todos (updated {new Date(dataUpdatedAt).toLocaleTimeString()})</p>}
    </div>
  )
}

export function StaleTimeDemo() {
  const [showSecond, setShowSecond] = useState(false)
  return (
    <section>
      <h2>2. Shared Cache / StaleTime (5s)</h2>
      <p style={{fontSize:'0.85rem',color:'#555'}}>Second instance reuses the same cache entry — no extra fetch for 5 seconds.</p>
      <TodoList label="Instance A" />
      {showSecond && <TodoList label="Instance B (mounted after A)" />}
      <button onClick={() => setShowSecond((v) => !v)}>
        {showSecond ? 'Unmount B' : 'Mount Instance B'}
      </button>
    </section>
  )
}
