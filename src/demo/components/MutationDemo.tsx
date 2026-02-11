import { useState } from 'react'
import { useQuery } from '@react/useQuery'
import { useMutation } from '@react/useMutation'
import { useQueryClient } from '@react/useQueryClient'
import { api, type Todo } from '../api'

export function MutationDemo() {
  const qc = useQueryClient()
  const [newTitle, setNewTitle] = useState('')

  const { data: todos = [], isLoading } = useQuery<Todo[]>({
    queryKey: ['todos', 'mutation-demo'],
    queryFn: () => api.fetchTodos(500),
  })

  const addMutation = useMutation({
    mutationFn: (title: string) => api.addTodo(title),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['todos', 'mutation-demo'] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: (id: number) => api.toggleTodo(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['todos', 'mutation-demo'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.deleteTodo(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['todos', 'mutation-demo'] })
    },
  })

  return (
    <section>
      <h2>4. Mutations + Cache Invalidation</h2>
      {isLoading ? (
        <p>Loading…</p>
      ) : (
        <ul>
          {todos.map((t) => (
            <li key={t.id} style={{marginBottom:'4px'}}>
              <span style={{textDecoration: t.completed ? 'line-through' : 'none', marginRight:'8px'}}>
                {t.title}
              </span>
              <button onClick={() => toggleMutation.mutate(t.id)} disabled={toggleMutation.isPending}>
                {t.completed ? 'Undo' : 'Done'}
              </button>{' '}
              <button onClick={() => deleteMutation.mutate(t.id)} disabled={deleteMutation.isPending}>
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}
      <div style={{marginTop:'8px'}}>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="New todo title"
          style={{marginRight:'8px', padding:'4px 8px'}}
        />
        <button
          onClick={() => { addMutation.mutate(newTitle); setNewTitle('') }}
          disabled={!newTitle || addMutation.isPending}
        >
          {addMutation.isPending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {addMutation.isError && <p style={{color:'red'}}>Error: {String(addMutation.error)}</p>}
    </section>
  )
}
