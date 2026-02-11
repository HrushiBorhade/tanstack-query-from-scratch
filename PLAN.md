# Building TanStack Query From Scratch — Implementation Plan

## Why This Project Will Stand Out

When a CTO or tech lead sees this on your resume/GitHub, they'll understand you know:
1. **The Observer Pattern** — the backbone of every reactive UI library
2. **Stale-While-Revalidate** — the caching strategy that powers production apps
3. **State Machines** — managing complex async lifecycles without bugs
4. **Request Deduplication** — preventing wasted network calls
5. **Garbage Collection** — memory management in long-running SPAs
6. **Framework-Agnostic Architecture** — separating core logic from React bindings

This isn't just "I used React Query" — it's "I understand WHY React Query exists and HOW it works internally."

---

## Architecture Overview

We'll follow the **exact same layered architecture** as the real TanStack Query:

```
┌─────────────────────────────────────────────────┐
│                  React Layer                     │
│  useQuery() · useMutation() · QueryClientProvider│
│        Uses useSyncExternalStore                 │
├─────────────────────────────────────────────────┤
│               Observer Layer                     │
│     QueryObserver · MutationObserver             │
│   Bridge between cache and React components      │
│   Handles: staleness, refetch decisions,         │
│            result computation, subscriptions     │
├─────────────────────────────────────────────────┤
│                 Core Layer                        │
│    QueryClient · QueryCache · MutationCache      │
│    Query · Mutation · Subscribable · Removable   │
│   Handles: caching, fetching, state machine,     │
│            deduplication, GC, retry, notifications│
└─────────────────────────────────────────────────┘
```

### Why This Layered Architecture Matters

The real TanStack Query supports React, Vue, Solid, Svelte, and Angular — all from the **same core**. The core has zero framework dependencies. React is just one "adapter." We'll build the same separation because:

1. It proves you understand **separation of concerns** at an architectural level
2. It makes the code testable without React
3. It's the pattern used in production by libraries like Zustand, Jotai, Redux Toolkit

---

## What We'll Build (Features That Matter)

### Must-Have (These demonstrate deep understanding)

| Feature | Why It Impresses |
|---------|-----------------|
| **QueryClient + QueryCache + Query** | Shows you understand the 3-layer cache architecture |
| **Observer Pattern (QueryObserver)** | The core pattern — proves you understand reactive systems |
| **useSyncExternalStore integration** | Modern React 18+ pattern, not the hacky useState+useEffect approach |
| **Stale-While-Revalidate (staleTime)** | THE core value proposition of React Query |
| **Garbage Collection (gcTime)** | Memory management — shows production thinking |
| **Request Deduplication** | Multiple components, same key = one network request |
| **Background Refetching** | Data stays fresh without blocking UI |
| **Window Focus Refetching** | Real-world UX optimization |
| **Retry with Exponential Backoff** | Production error handling |
| **useMutation with lifecycle hooks** | onMutate, onSuccess, onError, onSettled |
| **Query Invalidation** | How mutations trigger query refreshes |
| **Optimistic Updates** | The killer feature for great UX |
| **enabled option** | Dependent/conditional queries |
| **Notification Batching** | Prevents render cascades |
| **TypeScript Throughout** | Full generic type safety |

### Won't Build (Diminishing returns for interview purposes)

| Feature | Why Skip |
|---------|---------|
| Infinite queries / pagination | Complex but mechanical, not architecturally interesting |
| Suspense integration | React-specific, not core architecture |
| SSR / Hydration | Infrastructure concern, not query logic |
| DevTools | UI work, not architecture |
| Persistence / offline | Storage concern, not query logic |
| Structural sharing (replaceEqualDeep) | Optimization detail, not core concept |
| Tracked properties (Proxy) | Nice optimization, but obscures the core pattern |

---

## Implementation Phases

### Phase 1: The Foundation — Subscribable + NotifyManager
**Files:** `src/core/subscribable.ts`, `src/core/notifyManager.ts`, `src/core/types.ts`

The `Subscribable` base class is the foundation of the entire observer pattern:

```typescript
// The real TanStack Query uses this exact pattern
class Subscribable<TListener extends Function> {
  protected listeners: Set<TListener>

  subscribe(listener: TListener): () => void  // returns unsubscribe
  hasListeners(): boolean
  protected onSubscribe(): void   // hook for subclasses
  protected onUnsubscribe(): void // hook for subclasses
}
```

The `NotifyManager` singleton batches notifications to prevent render cascades:

```typescript
// When multiple queries update in the same tick, we batch all
// React re-renders into a single update
notifyManager.batch(() => {
  query1.setState(...)  // queued, not executed
  query2.setState(...)  // queued, not executed
})  // <-- all notifications flush here, single React render
```

**Key concept to explain in interview:** "Every observable in the system — QueryCache, QueryObserver, FocusManager — extends the same Subscribable base class. This gives us a consistent subscription/unsubscription pattern with automatic cleanup."

---

### Phase 2: The Query — State Machine + Fetching + Dedup
**Files:** `src/core/query.ts`, `src/core/retryer.ts`, `src/core/removable.ts`

The `Query` is a cache entry with its own state machine. Two orthogonal axes:

```
QueryStatus (data state):     FetchStatus (network state):
  'pending'  → no data yet      'idle'     → not fetching
  'success'  → has data          'fetching' → request in-flight
  'error'    → last fetch failed 'paused'   → waiting for network
```

These are **independent**. A query can be `status: 'success'` AND `fetchStatus: 'fetching'` — that's a background refetch. This is the key insight that makes React Query's UX so good.

State transitions via a reducer:
```
Initial → fetch() dispatched → { status: 'pending', fetchStatus: 'fetching' }
  → queryFn resolves → { status: 'success', fetchStatus: 'idle', data: ... }
  → queryFn rejects → retry? → { fetchStatus: 'fetching' } (retry in progress)
                     → no retry → { status: 'error', fetchStatus: 'idle', error: ... }

Background refetch (data already exists):
  fetch() → { status: 'success' (unchanged!), fetchStatus: 'fetching' }
  → resolves → { status: 'success', fetchStatus: 'idle', data: newData }
```

Request deduplication:
```typescript
// If a fetch is already in-flight, return the existing promise
// instead of starting a new one
fetch() {
  if (this.state.fetchStatus !== 'idle' && this.retryer) {
    return this.retryer.promise  // dedup!
  }
  // ... start new fetch
}
```

The `Retryer` handles retry logic with exponential backoff:
```
Attempt 1 fails → wait 1s → retry
Attempt 2 fails → wait 2s → retry
Attempt 3 fails → wait 4s → retry
Attempt 4 fails → give up (default: 3 retries)

Backoff formula: Math.min(1000 * 2^failureCount, 30000)
```

The `Removable` base class provides garbage collection:
```typescript
// When the last observer unsubscribes, start a GC timer
// Default: 5 minutes. If no one re-subscribes, remove from cache
scheduleGc() {
  this.gcTimeout = setTimeout(() => {
    this.optionalRemove()  // remove from QueryCache
  }, this.gcTime)
}
```

**Key concept to explain:** "The dual-axis state machine is what makes React Query special. Most data-fetching solutions have a single loading state. But separating 'do I have data?' from 'am I currently fetching?' is what enables background refetching without losing the existing UI."

---

### Phase 3: The Cache — QueryCache + MutationCache
**Files:** `src/core/queryCache.ts`, `src/core/mutationCache.ts`

The `QueryCache` is a `Map<string, Query>` with event emission:

```typescript
class QueryCache extends Subscribable<QueryCacheListener> {
  private queries: Map<string, Query>

  // Find or create a query by key
  build(client, options): Query {
    const queryHash = hashQueryKey(options.queryKey)
    let query = this.queries.get(queryHash)
    if (!query) {
      query = new Query({ cache: this, ...options })
      this.queries.set(queryHash, query)
      this.notify({ type: 'added', query })  // DevTools hook
    }
    return query
  }

  // Remove a query (called by GC)
  remove(query): void {
    this.queries.delete(query.queryHash)
    this.notify({ type: 'removed', query })
  }
}
```

Query key hashing: `JSON.stringify` with sorted object keys for stability:
```typescript
hashQueryKey(['todos', { status: 'done', page: 1 }])
// → '["todos",{"page":1,"status":"done"}]'
// Object keys sorted! So { page: 1, status: 'done' } === { status: 'done', page: 1 }
```

**Key concept:** "The cache is just a Map. The magic isn't in the data structure — it's in the lifecycle management around it: when to fetch, when to refetch, when to garbage collect, and how to notify observers."

---

### Phase 4: The QueryClient — Facade + Coordination
**Files:** `src/core/queryClient.ts`

The `QueryClient` is the public API. It owns the caches and coordinates everything:

```typescript
class QueryClient {
  private queryCache: QueryCache
  private mutationCache: MutationCache
  private defaultOptions: DefaultOptions

  // Core methods we'll implement:
  fetchQuery(options)           // fetch + return promise
  prefetchQuery(options)        // fetch without waiting (for preloading)
  getQueryData(queryKey)        // sync cache read
  setQueryData(queryKey, data)  // manual cache write (for optimistic updates)
  invalidateQueries(filters)    // mark queries stale + refetch active ones
  cancelQueries(filters)        // cancel in-flight fetches
  removeQueries(filters)        // remove from cache entirely

  // Lifecycle (called by QueryClientProvider)
  mount()    // subscribe to FocusManager + OnlineManager
  unmount()  // unsubscribe
}
```

**Key concept:** "QueryClient is a facade. It doesn't do the work itself — it delegates to QueryCache, Query, and QueryObserver. This is the Facade pattern in practice."

---

### Phase 5: The Observer — Bridge to React
**Files:** `src/core/queryObserver.ts`, `src/core/mutationObserver.ts`

The `QueryObserver` is the most complex piece. It sits between a Query and a React component:

```
Component → useQuery() → QueryObserver → Query (in cache)
                ↑                            |
                └────── notifications ───────┘
```

Responsibilities:
1. **Subscribe to the correct Query** (create it if needed)
2. **Decide when to fetch**: on mount? on window focus? on interval?
3. **Compute the result** from raw Query state (add derived fields like `isLoading`, `isRefetching`)
4. **Notify the component** only when relevant state changes
5. **Handle staleTime**: is the data fresh enough to skip fetching?
6. **Handle refetchInterval**: set up polling if configured

```typescript
class QueryObserver extends Subscribable<QueryObserverListener> {
  private currentQuery: Query
  private currentResult: QueryObserverResult

  // Called when the Query's state changes
  onQueryUpdate(): void {
    this.updateResult()
    if (this.hasResultChanged()) {
      this.notify()  // triggers React re-render
    }
  }

  // Should we fetch when this observer mounts?
  shouldFetchOnMount(): boolean {
    return (
      this.currentQuery.isStaleByTime(this.options.staleTime) &&
      // ... other conditions (enabled, not already fetching, etc.)
    )
  }

  // Should we fetch when window regains focus?
  shouldFetchOnWindowFocus(): boolean {
    return this.options.refetchOnWindowFocus !== false &&
           this.currentQuery.isStaleByTime(this.options.staleTime)
  }
}
```

**Key concept:** "The observer pattern decouples the cache from React. The Query doesn't know or care about React — it just holds state and notifies observers. The observer doesn't know about the DOM — it just transforms state and notifies listeners. React's useSyncExternalStore just needs a subscribe function and a getSnapshot function, which the observer provides."

---

### Phase 6: React Bindings
**Files:** `src/react/QueryClientProvider.tsx`, `src/react/useQuery.ts`, `src/react/useMutation.ts`, `src/react/useQueryClient.ts`

The React layer is surprisingly thin — it's just glue:

```typescript
// useQuery.ts — the entire hook
function useQuery(options) {
  const client = useQueryClient()

  // Create observer once (persists across re-renders)
  const [observer] = useState(() =>
    new QueryObserver(client, client.defaultQueryOptions(options))
  )

  // Subscribe via React 18's useSyncExternalStore
  const result = useSyncExternalStore(
    useCallback((onStoreChange) => {
      return observer.subscribe(notifyManager.batchCalls(onStoreChange))
    }, [observer]),
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  )

  // Update observer options when they change
  useEffect(() => {
    observer.setOptions(client.defaultQueryOptions(options))
  }, [options])

  return result
}
```

**Why `useSyncExternalStore` instead of `useState` + `useEffect`?**
- It's the React 18+ recommended way to subscribe to external stores
- It prevents "tearing" in concurrent mode (different components showing different states)
- It's what the real TanStack Query v5 uses
- Using useState+useEffect is the "old way" — shows you know the modern approach

```typescript
// QueryClientProvider.tsx
function QueryClientProvider({ client, children }) {
  useEffect(() => {
    client.mount()    // subscribes to focus + online events
    return () => client.unmount()
  }, [client])

  return (
    <QueryClientContext.Provider value={client}>
      {children}
    </QueryClientContext.Provider>
  )
}
```

---

### Phase 7: FocusManager + OnlineManager
**Files:** `src/core/focusManager.ts`, `src/core/onlineManager.ts`

Singletons that track browser state and notify the system:

```typescript
class FocusManager extends Subscribable<FocusListener> {
  setup() {
    // Listen to visibilitychange event
    window.addEventListener('visibilitychange', () => {
      this.setFocused(document.visibilityState !== 'hidden')
    })
  }

  setFocused(focused: boolean) {
    this.focused = focused
    this.listeners.forEach(listener => listener(focused))
  }
}
```

When `QueryClient.mount()` is called, it subscribes:
```typescript
mount() {
  focusManager.subscribe((focused) => {
    if (focused) this.queryCache.onFocus()  // refetch stale queries
  })
  onlineManager.subscribe((online) => {
    if (online) this.queryCache.onOnline()  // resume paused queries
  })
}
```

**Key concept:** "Window focus refetching is not magic. It's a visibility change event → FocusManager notification → QueryCache iterates queries → each Query asks its observers 'should I refetch?' → if data is stale, yes."

---

### Phase 8: Mutations + Optimistic Updates
**Files:** `src/core/mutation.ts`, `src/core/mutationObserver.ts`

Mutations are simpler than queries — no caching, no staleness, no background refetch. But they have lifecycle hooks that enable optimistic updates:

```typescript
// The mutation lifecycle:
onMutate(variables)     // BEFORE the request — set optimistic data here
  → mutationFn(variables)  // the actual API call
    → onSuccess(data)      // request succeeded
    → onError(error)       // request failed — rollback optimistic data
  → onSettled(data, error) // always runs (like finally)
```

Optimistic update flow:
```typescript
useMutation({
  mutationFn: updateTodo,
  onMutate: async (newTodo) => {
    // 1. Cancel in-flight queries (prevent overwrite)
    await queryClient.cancelQueries({ queryKey: ['todos'] })

    // 2. Snapshot previous value (for rollback)
    const previous = queryClient.getQueryData(['todos'])

    // 3. Optimistically update cache
    queryClient.setQueryData(['todos'], (old) => [...old, newTodo])

    // 4. Return snapshot for rollback
    return { previous }
  },
  onError: (err, newTodo, context) => {
    // Rollback on error
    queryClient.setQueryData(['todos'], context.previous)
  },
  onSettled: () => {
    // Refetch to ensure server truth
    queryClient.invalidateQueries({ queryKey: ['todos'] })
  },
})
```

**Key concept:** "Optimistic updates are just three steps: snapshot the cache, update it immediately, and rollback on error. The mutation lifecycle hooks (onMutate/onError/onSettled) are what make this pattern ergonomic."

---

### Phase 9: Demo App
**Files:** `src/demo/` — a small React app showcasing everything

The demo should prove every feature works with real, interactive examples:

1. **Basic Query** — fetch and display data with loading/error states
2. **Shared Cache** — two components with the same query key, proving deduplication
3. **Stale Time** — mount/unmount a component, showing cached data vs refetch
4. **Background Refetch** — show "Refreshing..." indicator while stale data displays
5. **Window Focus Refetch** — switch tabs and come back, watch data refresh
6. **Mutation + Invalidation** — add an item, watch the list auto-refresh
7. **Optimistic Update** — add an item that appears instantly, rollback on error
8. **Retry** — simulate a flaky API, show retry attempts
9. **Dependent Queries** — fetch user, then fetch user's posts (enabled option)
10. **GC Demo** — unmount a component, watch the query disappear after gcTime

---

## File Structure

```
tanstack-query-from-scratch/
├── src/
│   ├── core/                    # Framework-agnostic core (the impressive part)
│   │   ├── types.ts             # All TypeScript types and interfaces
│   │   ├── utils.ts             # hashQueryKey, isServer, sleep, etc.
│   │   ├── subscribable.ts      # Base class for observer pattern
│   │   ├── removable.ts         # Base class for GC
│   │   ├── notifyManager.ts     # Notification batching singleton
│   │   ├── focusManager.ts      # Window focus tracking singleton
│   │   ├── onlineManager.ts     # Network status tracking singleton
│   │   ├── retryer.ts           # Retry with exponential backoff
│   │   ├── query.ts             # Query state machine + fetching
│   │   ├── queryCache.ts        # Map of queries + event emission
│   │   ├── queryObserver.ts     # Bridge: Query → React component
│   │   ├── mutation.ts          # Mutation state machine
│   │   ├── mutationCache.ts     # Collection of mutations
│   │   ├── mutationObserver.ts  # Bridge: Mutation → React component
│   │   ├── queryClient.ts       # Public API facade
│   │   └── index.ts             # Core barrel exports
│   │
│   ├── react/                   # React adapter (thin layer)
│   │   ├── QueryClientProvider.tsx
│   │   ├── useQueryClient.ts
│   │   ├── useQuery.ts
│   │   ├── useMutation.ts
│   │   └── index.ts             # React barrel exports
│   │
│   ├── demo/                    # Demo app proving it works
│   │   ├── App.tsx
│   │   ├── main.tsx
│   │   ├── api.ts               # Mock API with configurable latency/errors
│   │   └── examples/
│   │       ├── BasicQuery.tsx
│   │       ├── SharedCache.tsx
│   │       ├── StaleTime.tsx
│   │       ├── BackgroundRefetch.tsx
│   │       ├── WindowFocus.tsx
│   │       ├── MutationInvalidation.tsx
│   │       ├── OptimisticUpdate.tsx
│   │       ├── RetryDemo.tsx
│   │       ├── DependentQueries.tsx
│   │       └── GarbageCollection.tsx
│   │
│   └── index.ts                 # Main entry point
│
├── tests/                       # Tests for core logic
│   ├── query.test.ts
│   ├── queryCache.test.ts
│   ├── queryObserver.test.ts
│   ├── mutation.test.ts
│   ├── retryer.test.ts
│   └── queryClient.test.ts
│
├── package.json
├── tsconfig.json
├── vite.config.ts
└── README.md                    # Architecture explanation (for GitHub visitors)
```

---

## Implementation Order

We build bottom-up, so each layer is testable independently:

| Order | Phase | Files | Can Test Without React? |
|-------|-------|-------|------------------------|
| 1 | Types + Utils | types.ts, utils.ts | Yes |
| 2 | Subscribable | subscribable.ts | Yes |
| 3 | NotifyManager | notifyManager.ts | Yes |
| 4 | Removable | removable.ts | Yes |
| 5 | Retryer | retryer.ts | Yes |
| 6 | Query | query.ts | Yes |
| 7 | QueryCache | queryCache.ts | Yes |
| 8 | FocusManager + OnlineManager | focusManager.ts, onlineManager.ts | Yes |
| 9 | QueryClient | queryClient.ts | Yes |
| 10 | QueryObserver | queryObserver.ts | Yes |
| 11 | Mutation + MutationCache + MutationObserver | mutation.ts, mutationCache.ts, mutationObserver.ts | Yes |
| 12 | React: QueryClientProvider + useQueryClient | QueryClientProvider.tsx, useQueryClient.ts | Needs React |
| 13 | React: useQuery | useQuery.ts | Needs React |
| 14 | React: useMutation | useMutation.ts | Needs React |
| 15 | Demo App | demo/* | Full app |

---

## Key Interview Talking Points

After building this, you'll be able to confidently explain:

### Architecture Questions
- "Why did you separate core from React?" → Framework-agnostic design, same pattern as Zustand/Jotai/TanStack
- "What design patterns did you use?" → Observer, Facade, State Machine, Strategy (for retry)
- "How does the observer pattern work here?" → Subscribable base → Query holds observers → observers notify React via useSyncExternalStore
- "Why useSyncExternalStore instead of useState?" → Prevents tearing in concurrent mode, React 18+ recommended pattern

### Caching Questions
- "How does cache invalidation work?" → Mark query as `isInvalidated`, refetch if there are active observers
- "How do you handle stale data?" → Stale-while-revalidate: show cached data immediately, refetch in background
- "How does garbage collection work?" → Timer starts when last observer unsubscribes, default 5 min, clears cache entry

### Performance Questions
- "How do you prevent unnecessary re-renders?" → Notification batching via NotifyManager
- "How do you deduplicate requests?" → Same queryHash → same Query instance → return existing retryer promise
- "How do you handle race conditions?" → The retryer's promise is the single source of truth; stale responses are ignored

### Real-world Questions
- "When would you use React Query vs. SWR vs. Redux?" → RQ has more features (mutations, optimistic updates, query invalidation), SWR is simpler, Redux is for client state
- "How do optimistic updates work?" → Snapshot cache → update optimistically → rollback on error → invalidate on settle
- "How does window focus refetching work?" → visibilitychange event → FocusManager → QueryCache.onFocus() → refetch stale queries

---

## Tech Stack for the Project

- **TypeScript** — full generic type safety
- **React 18+** — for useSyncExternalStore
- **Vite** — fast dev server + build
- **Vitest** — for testing core logic
- **No other dependencies** — the whole point is building from scratch

---

## References Studied

1. **Official TanStack Query source** — github.com/TanStack/query (query-core + react-query packages)
2. **Philip Fabianek's implementation** — 130 lines capturing the essential architecture
3. **tigerabrodi/react-query-from-scratch** — most feature-complete community build (GC, optimistic updates, dedup)
4. **gerhardsletten/react-query-lite** — closest to real architecture with proper Observer pattern
5. **wtlin1228/react-query-lite** — Tanner Linsley's own 150-line talk companion code
6. **MarioLegenda/react-query-lite** — explicit state machine approach
7. **TkDodo's "Inside React Query" blog series** — the definitive architectural reference
8. **TanStack Query official docs** — complete API reference for useQuery, useMutation, QueryClient
