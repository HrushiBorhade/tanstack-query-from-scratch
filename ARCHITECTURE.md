# TanStack Query — From Scratch: Architecture & Code Walkthrough

## Build Status

| Check | Result |
|-------|--------|
| TypeScript | 0 errors |
| ESLint | 0 warnings |
| Vite bundle | 177 kB (55 kB gzip), 55 modules |
| Tests | 137 / 137 passing |

---

## System Architecture

The project re-implements TanStack Query (React Query) from scratch in 7 layers, where each layer only depends on the one below it.

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 7 │ React Bindings                                     │
│          │  useQuery, useMutation, QueryClientProvider        │
├──────────────────────────────────────────────────────────────┤
│  Layer 6 │ QueryClient                                        │
│          │  Public façade / API surface                       │
├──────────────────────────────────────────────────────────────┤
│  Layer 5 │ Observers                                          │
│          │  QueryObserver, MutationObserver                   │
├──────────────────────────────────────────────────────────────┤
│  Layer 4 │ Caches                                             │
│          │  QueryCache, MutationCache                         │
├──────────────────────────────────────────────────────────────┤
│  Layer 3 │ State Machines                                     │
│          │  Query, Mutation                                   │
├──────────────────────────────────────────────────────────────┤
│  Layer 2 │ Infrastructure                                     │
│          │  Retryer, FocusManager, OnlineManager              │
├──────────────────────────────────────────────────────────────┤
│  Layer 1 │ Primitives                                         │
│          │  types, utils, Subscribable, NotifyManager,        │
│          │  Removable                                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Layer 1 — Primitives

### `src/core/types.ts`

Zero runtime code — purely TypeScript interfaces. Defines the shared vocabulary for the entire system.

**`QueryKey`** — `ReadonlyArray<unknown>`. Every query is identified by a stable array like `['users', 1]` or `['users', { role: 'admin' }]`.

**Dual-axis query state** — the central design insight of TanStack Query. `QueryStatus` and `FetchStatus` are orthogonal axes:

```
QueryStatus:   pending | success | error
               (do we have data?)

FetchStatus:   fetching | paused | idle
               (is a network request happening right now?)
```

A query can be `status='success'` and `fetchStatus='fetching'` at the same time — this is a background refetch. The component can show the old data while the new one loads.

**`QueryState`** — the full serializable state stored per query:

```ts
interface QueryState<TData, TError> {
  data: TData | undefined
  dataUpdatedAt: number       // Unix ms timestamp
  error: TError | null
  errorUpdatedAt: number
  fetchFailureCount: number   // retry counter
  fetchFailureReason: TError | null
  fetchStatus: FetchStatus
  isInvalidated: boolean      // manually invalidated?
  status: QueryStatus
}
```

**`QueryObserverResult`** — the rich object returned to `useQuery`. It adds ~15 derived boolean convenience flags on top of `QueryState`:

| Flag | Derived from |
|------|-------------|
| `isLoading` | `status === 'pending' && fetchStatus === 'fetching'` |
| `isFetching` | `fetchStatus === 'fetching'` |
| `isError` | `status === 'error'` |
| `isSuccess` | `status === 'success'` |
| `isRefetching` | `fetchStatus === 'fetching' && status !== 'pending'` |
| `isPaused` | `fetchStatus === 'paused'` |
| `isPlaceholderData` | showing `placeholderData`, not real cache data |

---

### `src/core/utils.ts`

Pure helper functions with no side effects.

**`hashQueryKey(key)`** — serializes a `QueryKey` to a stable string used as the `Map` key in the cache. Sorts object keys recursively before `JSON.stringify`, so key insertion order never matters:

```ts
hashQueryKey(['users', { role: 'admin', page: 1 }])
// === hashQueryKey(['users', { page: 1, role: 'admin' }])
// both → '["users",{"page":1,"role":"admin"}]'
```

**`matchesQueryKey(queryKey, target, exact)`** — prefix-matching for filter operations. Used by `invalidateQueries`, `cancelQueries`, `removeQueries`, etc. With `exact=false`, it checks if every element in `target` matches the corresponding element in `queryKey` using per-element hashing. This prevents the substring bug where filter `['to']` would incorrectly match query `['todo']`.

```ts
matchesQueryKey(['users', 1], ['users'], false)  // true — prefix match
matchesQueryKey(['users', 1], ['users'], true)   // false — not exact
matchesQueryKey(['users', 1], ['todos'], false)  // false — no match
```

---

### `src/core/subscribable.ts`

The observer-pattern base class that every observable entity extends:

```
QueryCache, MutationCache, QueryObserver, MutationObserver,
FocusManager, OnlineManager  →  all extend Subscribable<TListener>
```

Key design choices:
- **`Set<TListener>`** — O(1) add/remove, automatic deduplication (subscribing the same function twice is a no-op)
- **Returns unsubscribe function** — matches the React `useEffect` cleanup pattern and the signature `useSyncExternalStore` expects
- **`onSubscribe()` / `onUnsubscribe()` hooks** — subclasses override these to start/stop side-effects *only while there is at least one active listener* (e.g. add window event listeners, schedule refetch intervals)

```ts
const unsub = cache.subscribe((event) => console.log(event))
// later...
unsub()  // removes the listener, calls onUnsubscribe()
```

---

### `src/core/notifyManager.ts`

Solves the **render cascade problem**. Without batching, when one fetch completes, every component observing that query would re-render individually (N re-renders for N observers). With batching, all notifications from one event are collapsed into one React render pass.

**How it works:**

1. All `#dispatch` calls inside a Query/Mutation wrap in `notifyManager.batch()`
2. Inside the transaction, `schedule(fn)` pushes callbacks onto a queue instead of executing immediately
3. When the outermost `batch()` returns, `flush()` drains the queue via `setTimeout(0)` — after the current call stack finishes
4. The flush runs inside `batchNotifyFn`, which the React adapter replaces with React's batching primitive, collapsing all state updates into **one render**

**Customisation points:**

```ts
notifyManager.setScheduler(fn)          // replace setTimeout with queueMicrotask, rAF, etc.
notifyManager.setNotifyFunction(fn)      // wrap individual notification calls (DevTools)
notifyManager.setBatchNotifyFunction(fn) // replace entire flush (React adapter)
```

**`batchCalls(fn)`** — wraps a callback so every call is automatically scheduled. Used to wrap the `onStoreChange` passed to `useSyncExternalStore`:

```ts
const stableOnChange = notifyManager.batchCalls(onStoreChange)
observer.subscribe(stableOnChange)
```

---

### `src/core/removable.ts`

Abstract base class for garbage collection. Both `Query` and `Mutation` extend it.

**Why deferred GC?** — If a user navigates away from a page and quickly comes back, query data is still in memory and shown instantly while a background refetch happens. This is one of the key UX features of TanStack Query. The `gcTime` window (default 5 minutes in browsers, `Infinity` on server) controls how long this "fast navigation" window lasts.

**Lifecycle:**

```
last observer unsubscribes
  → scheduleGc() starts a setTimeout(gcTime)
  → gcTime ms later: optionalRemove() fires
      → checks no new observer subscribed → removes from cache

new observer subscribes before timeout fires
  → clearGcTimeout() cancels the pending removal
```

**`updateGcTime()`** always takes the maximum of all observers' `gcTime` values — the most conservative (longest) one wins, so data isn't evicted while any observer still expects it.

---

## Layer 2 — Infrastructure

### `src/core/retryer.ts`

The retry engine. Wraps a single async `fn` and owns the entire lifecycle: initial attempt, exponential-backoff retries, offline pausing, and cancellation.

**Key design:** `promise` is created in the constructor (before `start()` is called) so callers can attach `.then`/`.catch` handlers before any async work begins.

**`#run()` — the recursive retry loop:**

```
attempt fn()
  ├── success → call onSuccess(), resolve promise
  └── error   → check shouldRetry?
                  ├── no → call onError(), reject promise
                  └── yes → sleep(retryDelay), check cancelled, recurse
```

Cancellation is checked at every `await` boundary so the loop exits promptly after `cancel()` is called. With `cancel({ silent: true })`, the Retryer stops without rejecting its promise — the Query is responsible for transitioning its own state (dispatching `{ type: 'cancel' }` to set `fetchStatus: 'idle'`).

**Retry policy** — configurable as a number, boolean, or function:

```ts
retry: 3                                   // retry 3 times
retry: false                               // never retry
retry: (count, error) => count < 5        // custom logic
retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 30_000)  // exponential backoff
```

---

### `src/core/focusManager.ts`

Detects browser tab visibility changes via `document.visibilityState` and `visibilitychange` events. When the tab regains focus, notifies all subscribers — which causes stale queries to refetch.

Stores a `#focused: boolean | undefined` field so `setFocused(false)` in tests overrides the real DOM state. `isFocused()` checks the stored override first, falling back to the DOM.

---

### `src/core/onlineManager.ts`

Detects network connectivity via `navigator.onLine` and `online`/`offline` window events. When the network comes back, it notifies the `QueryCache`, which calls `onOnline()` on all paused queries to resume their Retryers.

---

## Layer 3 — State Machines

### `src/core/query.ts`

The heart of the system. A `Query` is the unit of cached data. It extends both `Subscribable` (for observers) and `Removable` (for GC).

**State machine** — driven by a pure `reducer(state, action)` function with no side effects:

| Action | State change |
|--------|-------------|
| `fetch` | `fetchStatus → 'fetching'`; if no data yet: `status → 'pending'` |
| `success` | `data` set, `status → 'success'`, `fetchStatus → 'idle'`, `isInvalidated → false` |
| `error` | `error` set, `status → 'error'`, `fetchStatus → 'idle'` |
| `cancel` | `fetchStatus → 'idle'` |
| `pause` | `fetchStatus → 'paused'` |
| `continue` | `fetchStatus → 'fetching'` |
| `invalidate` | `isInvalidated → true` |
| `setState` | merge arbitrary partial state (used by `setQueryData`) |

**Request deduplication** — `fetch()` checks if `fetchStatus !== 'idle'`. If a `Retryer` is already running, it returns `this.#retryer.promise` directly:

```ts
// 50 components mount and call useQuery with the same key
// → 50 calls to query.fetch()
// → 1 network request
// → all 50 components get the same data
```

**Observer lifecycle** — `addObserver`/`removeObserver` track which `QueryObserver` instances are watching. When the last observer unsubscribes, GC is scheduled. When a fetch completes, all observers are notified via `onQueryUpdate()`.

---

### `src/core/mutation.ts`

Simpler than `Query` — mutations don't cache results or deduplicate. State machine:

```
idle → pending (execute called)
         ├── success (mutationFn resolved)
         └── error   (mutationFn rejected)
any  → idle    (reset called)
```

**Context threading** — the return value of `onMutate` is passed as the `context` argument to every subsequent lifecycle hook:

```ts
onMutate: (variables) => {
  // apply optimistic update to the UI
  const snapshot = queryClient.getQueryData(['todos'])
  queryClient.setQueryData(['todos'], (old) => [...old, variables])
  return { snapshot }  // ← this becomes "context"
},
onError: (error, variables, context) => {
  // roll back the optimistic update
  queryClient.setQueryData(['todos'], context.snapshot)
},
onSettled: () => {
  // always refetch to sync with server
  queryClient.invalidateQueries({ queryKey: ['todos'] })
}
```

**Hook execution order** — per-mutation hooks fire first, then global `MutationCache.config` hooks:

```
onMutate → mutationFn → [onSuccess | onError] → onSettled
                         ↑ per-mutation hooks
then:                    [onSuccess | onError] → onSettled
                         ↑ global cache-level hooks
```

---

## Layer 4 — Caches

### `src/core/queryCache.ts`

A `Map<QueryHash, Query>` with typed event emission. The single source of truth for all query data in the application.

**`build(client, options)`** — the only way to create queries. Enforces query identity:

```ts
const q1 = cache.build(client, { queryKey: ['users'] })
const q2 = cache.build(client, { queryKey: ['users'] })
q1 === q2  // true — same hash, same instance returned
```

**`findAll(filters)`** — returns all matching queries. Supports filtering by:
- `type`: `'active'` (has observers), `'inactive'` (no observers), `'all'`
- `queryKey`: exact or prefix match
- `stale`: whether data is older than `staleTime`
- `fetchStatus`: current network activity
- `predicate`: custom function for complex filtering

**Event system** — emits typed events that propagate up to `QueryClient` subscribers:

| Event type | Fired when |
|------------|-----------|
| `added` | A new query is built |
| `removed` | A query is removed from cache |
| `observerAdded` | An observer subscribes to a query |
| `observerRemoved` | An observer unsubscribes from a query |
| `updated` | Query state changes |

---

### `src/core/mutationCache.ts`

A `Map<string, Mutation>` with the same event system. Simpler than `QueryCache` since mutations don't need key-based deduplication or staleness tracking.

---

## Layer 5 — Observers

### `src/core/queryObserver.ts`

The bridge between a cached `Query` and a React component. One `QueryObserver` is created per `useQuery` call.

**Core responsibilities:**

1. **Subscribe/unsubscribe** from the underlying `Query` — this drives the GC lifecycle (query stays alive as long as any observer is subscribed)
2. **Compute `QueryObserverResult`** from raw `QueryState` — adds all derived boolean flags, applies `select` transforms, handles `placeholderData`
3. **Decide when to refetch** — checks staleness and `refetchOn*` options:
   - `shouldFetchOnMount()` — refetch if stale (or `refetchOnMount: 'always'`)
   - `shouldFetchOnWindowFocus()` — same check but triggered by focus events
   - `shouldFetchOnReconnect()` — same check but triggered by online events
4. **Track `isFetchedAfterMount`** — resets to false on construction so the UI knows if data is "fresh from this session"

**`getOptimisticResult()`** — computes what the result *would be* given the current options, without mutating state. Called by `useQuery` on every render to provide `useSyncExternalStore`'s snapshot:

```ts
// Inside useQuery:
const result = useSyncExternalStore(
  observer.subscribe,
  () => observer.getOptimisticResult(options),  // ← called on every render
  () => observer.getOptimisticResult(options),  // ← SSR snapshot
)
```

---

### `src/core/mutationObserver.ts`

Simpler bridge between a `Mutation` and `useMutation`. Wraps the raw `MutationState` with two callable functions:

- **`mutate(variables, options?)`** — fire-and-forget. Errors are surfaced via the result object, not thrown. Safe to call in event handlers.
- **`mutateAsync(variables, options?)`** — returns a `Promise`. Throws on error. Use when you need to await the result or chain with other async operations.

---

## Layer 6 — QueryClient

The public API façade. Holds a `QueryCache` and `MutationCache`, plus global default options. This is what your application code interacts with.

| Method | What it does |
|--------|-------------|
| `fetchQuery(opts)` | Builds/finds a query, calls `query.fetch()`, awaits and returns data |
| `prefetchQuery(opts)` | Same as `fetchQuery` but swallows errors (used for SSR pre-population) |
| `getQueryData(key)` | Returns `query.state.data` without triggering a fetch |
| `getQueryState(key)` | Returns the full `QueryState` |
| `setQueryData(key, updater)` | Writes directly into the cache; `updater` can be a value or `(old) => new` function |
| `invalidateQueries(filters)` | Marks matching queries as stale, then refetches any with active observers |
| `cancelQueries(filters)` | Calls `query.cancel()` on all matching in-flight queries |
| `removeQueries(filters)` | Removes matching queries from the cache entirely |
| `isFetching(filters)` | Counts queries with `fetchStatus === 'fetching'` |
| `isMutating()` | Counts mutations with `status === 'pending'` |
| `clear()` | Empties both `QueryCache` and `MutationCache` |
| `mount()` / `unmount()` | Ref-counted — wires up `FocusManager` and `OnlineManager` event listeners |
| `defaultQueryOptions(opts)` | Merges global `defaultOptions.queries` with per-query options |

**`mount()` / `unmount()` ref-counting** — if multiple `<QueryClientProvider>` instances share the same client, each mount increments a counter and only the first actually subscribes to focus/online events. Unmounts decrement; teardown only happens at zero.

---

## Layer 7 — React Bindings

### `src/react/QueryClientProvider.tsx`

```tsx
export function QueryClientProvider({ client, children }) {
  useEffect(() => {
    client.mount()
    return () => client.unmount()
  }, [client])

  return (
    <QueryClientContext.Provider value={client}>
      {children}
    </QueryClientContext.Provider>
  )
}
```

On mount: calls `client.mount()` which subscribes to `FocusManager` and `OnlineManager`. On unmount: calls `client.unmount()` to unsubscribe. Passes the `QueryClient` instance via Context.

---

### `src/react/useQuery.ts`

Uses React 18's `useSyncExternalStore` — the correct way to subscribe to external stores in concurrent mode:

```ts
export function useQuery(options) {
  const client = useQueryClient()
  const observer = useMemo(
    () => new QueryObserver(client, options),
    [client]
  )

  const result = useSyncExternalStore(
    observer.subscribe,                              // subscribe fn
    () => observer.getOptimisticResult(options),     // getSnapshot
    () => observer.getOptimisticResult(options),     // getServerSnapshot (SSR)
  )

  useEffect(() => {
    // Keep observer options in sync on every render (no deps array)
    observer.setOptions(options)
  })

  return result
}
```

**Why `useSyncExternalStore` and not `useState` + `useEffect`?**
1. **Tearing-safe** — React can't render with stale data between the render and commit phases
2. **SSR-compatible** — the `getServerSnapshot` argument handles server rendering
3. **Avoids stale-closure bugs** — the snapshot function is called fresh on every render

---

### `src/react/useMutation.ts`

Same pattern — `useSyncExternalStore` against a `MutationObserver`. Returns a result with `mutate` (fire-and-forget, errors in result object) and `mutateAsync` (throws on error).

---

## Key Design Patterns

| Pattern | Where used | Why |
|---------|-----------|-----|
| Observer (Pub/Sub) | `Subscribable` | Decouples state changes from UI reactions |
| State Machine (reducer) | `query.ts`, `mutation.ts` | Explicit transitions, pure function — trivial to test |
| Garbage Collection | `Removable` | Keeps data alive for fast navigation, cleans up idle data |
| Request Deduplication | `Query.fetch()` + `Retryer.promise` | N observers → 1 network request |
| Notification Batching | `notifyManager` | N state changes → 1 React render |
| Façade | `QueryClient` | Simple surface over complex internals |
| `useSyncExternalStore` | `useQuery`, `useMutation` | Concurrent-mode safe external store subscription |
| Context Threading | `Mutation` lifecycle hooks | `onMutate` return value flows to `onError`/`onSettled` for optimistic updates |
| Double-cast (`as unknown as T`) | Cache Map boundaries | Escape TypeScript generic variance where the runtime type is correct but TS can't verify it |
| Native `#` private fields | All classes | True runtime privacy, not just TypeScript-level |

---

## Data Flow — A Single `useQuery` Call

```
1. Component renders → useQuery(['users']) called
2. QueryObserver created → subscribes to QueryCache
3. useSyncExternalStore calls getOptimisticResult()
   → QueryObserver checks: is data stale? should fetch on mount?
4. If yes: QueryObserver calls query.fetch()
5. query.fetch() checks: is a fetch already in progress?
   → No: creates new Retryer, dispatches { type: 'fetch' }
   → Yes: returns existing Retryer.promise (deduplication)
6. Retryer calls queryFn({ queryKey, signal })
7. queryFn resolves → Retryer calls onSuccess(data)
8. query.setData(data) → dispatches { type: 'success' }
9. reducer computes new state: status='success', fetchStatus='idle'
10. query notifies all observers via onQueryUpdate()
11. notifyManager batches and schedules the notification
12. useSyncExternalStore re-reads snapshot → new result object
13. React re-renders with the new data
```

---

## File Structure

```
src/
├── core/
│   ├── types.ts           Layer 1 — All TypeScript types
│   ├── utils.ts           Layer 1 — hashQueryKey, matchesQueryKey, helpers
│   ├── subscribable.ts    Layer 1 — Observer base class
│   ├── notifyManager.ts   Layer 1 — Batched notification scheduler
│   ├── removable.ts       Layer 1 — GC base class
│   ├── retryer.ts         Layer 2 — Retry engine with backoff & cancellation
│   ├── focusManager.ts    Layer 2 — Browser tab focus detection
│   ├── onlineManager.ts   Layer 2 — Network connectivity detection
│   ├── query.ts           Layer 3 — Query state machine
│   ├── mutation.ts        Layer 3 — Mutation state machine
│   ├── queryCache.ts      Layer 4 — Map<hash, Query> + event emission
│   ├── mutationCache.ts   Layer 4 — Map<id, Mutation> + event emission
│   ├── queryObserver.ts   Layer 5 — Query → React bridge
│   ├── mutationObserver.ts Layer 5 — Mutation → React bridge
│   ├── queryClient.ts     Layer 6 — Public API façade
│   └── index.ts           Re-exports
├── react/
│   ├── QueryClientProvider.tsx  Context provider + mount lifecycle
│   ├── useQueryClient.ts        useContext wrapper
│   ├── useQuery.ts              useSyncExternalStore + QueryObserver
│   ├── useMutation.ts           useSyncExternalStore + MutationObserver
│   └── index.ts                 Re-exports
└── demo/                        Interactive demo app
tests/
├── utils.test.ts
├── subscribable.test.ts
├── query.test.ts
├── queryCache.test.ts
├── mutation.test.ts
└── queryClient.test.ts
```
