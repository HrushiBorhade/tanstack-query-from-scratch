// Shared helpers
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface Todo {
  id: number
  title: string
  completed: boolean
}

let todos: Todo[] = [
  { id: 1, title: 'Buy groceries', completed: false },
  { id: 2, title: 'Walk the dog', completed: true },
  { id: 3, title: 'Read a book', completed: false },
]
let nextId = 4

// Simulated failure toggle (for RetryDemo)
let shouldFail = true

export const api = {
  async fetchTodos(latency = 800): Promise<Todo[]> {
    await delay(latency)
    return [...todos]
  },

  async fetchTodo(id: number, latency = 600): Promise<Todo> {
    await delay(latency)
    const todo = todos.find((t) => t.id === id)
    if (!todo) throw new Error(`Todo ${id} not found`)
    return { ...todo }
  },

  async addTodo(title: string, latency = 500): Promise<Todo> {
    await delay(latency)
    const todo: Todo = { id: nextId++, title, completed: false }
    todos = [...todos, todo]
    return todo
  },

  async toggleTodo(id: number, latency = 400): Promise<Todo> {
    await delay(latency)
    const idx = todos.findIndex((t) => t.id === id)
    if (idx === -1) throw new Error(`Todo ${id} not found`)
    todos = todos.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
    return { ...todos[idx]!, completed: !todos[idx]!.completed }
  },

  async deleteTodo(id: number, latency = 400): Promise<void> {
    await delay(latency)
    todos = todos.filter((t) => t.id !== id)
  },

  // Used by RetryDemo — fails twice then succeeds
  async unreliableFetch(): Promise<string> {
    await delay(600)
    if (shouldFail) {
      shouldFail = false
      throw new Error('Network error (simulated)')
    }
    shouldFail = true
    return 'Loaded after retries!'
  },
}
