import { useState } from 'react'
import { useQuery } from '@react/useQuery'
import { useMutation } from '@react/useMutation'
import { useQueryClient } from '@react/useQueryClient'
import { api, type Todo } from '../api'

export function OptimisticUpdateDemo() {
  const qc = useQueryClient()
  const [forceError, setForceError] = useState(false)

  const { data: todos = [], isLoading } = useQuery<Todo[]>({
    queryKey: ['todos', 'optimistic'],
    queryFn: () => api.fetchTodos(600),
  })

  const toggleMutation = useMutation<Todo, Error, number, { previousTodos: Todo[] }>({
    mutationFn: async (id: number) => {
      if (forceError) throw new Error('Simulated server error')
      return api.toggleTodo(id)
    },
    onMutate: async (id) => {
      // Cancel outgoing refetches
      qc.cancelQueries({ queryKey: ['todos', 'optimistic'] })
      // Snapshot current data for rollback
      const previousTodos = qc.getQueryData<Todo[]>(['todos', 'optimistic']) ?? []
      // Optimistically update
      qc.setQueryData<Todo[]>(['todos', 'optimistic'], (old) =>
        (old ?? []).map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)),
      )
      return { previousTodos }
    },
    onError: (_err, _id, context) => {
      // Rollback on failure
      if (context?.previousTodos) {
        qc.setQueryData(['todos', 'optimistic'], context.previousTodos)
      }
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['todos', 'optimistic'] })
    },
  })

  return (
    <section>
      <h2>5. Optimistic Updates</h2>
      <label style={{fontSize:'0.85rem', display:'block', marginBottom:'8px'}}>
        <input type="checkbox" checked={forceError} onChange={(e) => setForceError(e.target.checked)} />{' '}
        Force error (to demo rollback)
      </label>
      {isLoading ? (
        <p>Loading…</p>
      ) : (
        <ul>
          {todos.map((t) => (
            <li key={t.id} style={{marginBottom:'4px'}}>
              <input
                type="checkbox"
                checked={t.completed}
                onChange={() => toggleMutation.mutate(t.id)}
                style={{marginRight:'8px'}}
              />
              <span style={{textDecoration: t.completed ? 'line-through' : 'none'}}>
                {t.title}
              </span>
            </li>
          ))}
        </ul>
      )}
      {toggleMutation.isError && (
        <p style={{color:'red'}}>Rolled back: {String(toggleMutation.error)}</p>
      )}
    </section>
  )
}
