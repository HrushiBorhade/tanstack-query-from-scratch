import { useQuery } from '@react/useQuery'
import { api } from '../api'

export function DependentQueryDemo() {
  // Step 1: fetch all todos
  const { data: todos, isLoading: loadingAll } = useQuery({
    queryKey: ['todos', 'dep'],
    queryFn: () => api.fetchTodos(500),
  })

  // Step 2: fetch detail of first todo only after list loads
  const firstId = todos?.[0]?.id
  const { data: detail, isLoading: loadingDetail } = useQuery({
    queryKey: ['todo', firstId],
    queryFn: () => api.fetchTodo(firstId!),
    enabled: firstId !== undefined,
  })

  return (
    <section>
      <h2>7. Dependent Queries</h2>
      <p style={{fontSize:'0.85rem',color:'#555'}}>Detail query only fires after the list query resolves.</p>
      {loadingAll && <p>Loading todos list…</p>}
      {todos && !loadingDetail && !detail && <p>Loading detail for todo #{firstId}…</p>}
      {detail && (
        <div>
          <p>List loaded: {todos?.length} todos</p>
          <p>Detail for first todo: <strong>"{detail.title}"</strong> — {detail.completed ? '\u2713 done' : '\u25cb pending'}</p>
        </div>
      )}
    </section>
  )
}
