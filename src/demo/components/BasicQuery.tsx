import { useQuery } from '@react/useQuery'
import { api } from '../api'

export function BasicQuery() {
  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['todos'],
    queryFn: () => api.fetchTodos(),
  })

  return (
    <section>
      <h2>1. Basic Query {isFetching && !isLoading && <span style={{fontSize:'0.75rem',color:'#888'}}>(refreshing…)</span>}</h2>
      {isLoading && <p>Loading…</p>}
      {isError && <p style={{color:'red'}}>Error: {String(error)}</p>}
      {data && (
        <ul>
          {data.map((t) => (
            <li key={t.id} style={{textDecoration: t.completed ? 'line-through' : 'none'}}>
              {t.title}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
