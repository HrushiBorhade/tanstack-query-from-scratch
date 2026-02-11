# TanStack Query From Scratch — Deep Dive: The Why Behind Every Decision

This document goes beyond what the code does and explains **why** it was built this way — the problems each design decision solves, the tradeoffs considered, and the reasoning you need to own this project deeply.

---

## The Core Problem This Project Solves

Every React app that talks to a server faces the same set of problems:

1. **Waterfall fetches** — components fetch independently, creating cascading spinners
2. **Stale data** — cached data silently goes out of date
3. **Duplicate requests** — three components mounting with the same data need → three HTTP calls
4. **Loading state explosion** — each component tracks its own `isLoading`, `isError`, `data`
5. **Background refetch** — user tabs away and comes back: do we show a spinner or stale data?
6. **GC** — how long do you keep data in memory after nobody needs it?
7. **Optimistic updates** — update the UI before the server confirms, roll back if it fails
8. **Retries** — transient failures should retry automatically, but not infinitely

Before libraries like React Query, every team solved each of these differently, inconsistently, and incompletely. This project re-implements the complete solution from scratch to understand exactly how it works.

---

## Why a Query Key is an Array

```ts
queryKey: ['users', { role: 'admin', page: 1 }]
```

**The problem with string keys** — if you used a string like `"users-admin-page-1"`, you'd have to manually construct and parse it everywhere. Partial invalidation (`invalidateQueries({ queryKey: ['users'] })`) would require substring matching, which is fragile.

**Why an array** — arrays are structured data. You can do prefix matching at the element level: `['users']` is a prefix of `['users', 1]` and `['users', { role: 'admin' }]`. This is how `invalidateQueries({ queryKey: ['users'] })` invalidates ALL user queries in one call.

**Why not an object** — arrays have a natural prefix relationship. Objects don't. `{ entity: 'users' }` has no clear notion of "more specific" vs "less specific".

**Why the hash sorts object keys** — `{ role: 'admin', page: 1 }` and `{ page: 1, role: 'admin' }` are the same query. JavaScript objects don't guarantee key order, so `JSON.stringify` would produce different strings. `hashQueryKey` sorts keys recursively so object key order never creates phantom cache misses.

```ts
// Without sorting:
JSON.stringify({ role: 'admin', page: 1 }) // '{"role":"admin","page":1}'
JSON.stringify({ page: 1, role: 'admin' }) // '{"page":1,"role":"admin"}'  ← different!

// With hashQueryKey sorting:
hashQueryKey([{ role: 'admin', page: 1 }]) // '[{"page":1,"role":"admin"}]'
hashQueryKey([{ page: 1, role: 'admin' }]) // '[{"page":1,"role":"admin"}]'  ← same ✓
```

---

## Why the Dual-Axis State Machine

```ts
QueryStatus:  pending | success | error
FetchStatus:  fetching | paused | idle
```

**The single-axis approach and why it fails** — early React Query versions had one status field. The problem: what do you call "we have data, and we're refreshing it in the background"? There's no clean single word for that. Teams had to bolt on a separate `isFetching` boolean, which could get out of sync with the main status.

**The two-axis insight** — "what data do we have?" and "what is the network doing?" are genuinely independent questions. Separating them into two orthogonal fields means every combination is representable and unambiguous:

| `status` | `fetchStatus` | Meaning |
|----------|---------------|---------|
| `pending` | `idle` | First ever load hasn't started yet |
| `pending` | `fetching` | First ever load is in flight — show a spinner |
| `pending` | `paused` | Offline, waiting to fetch for the first time |
| `success` | `idle` | Fresh data, nothing happening |
| `success` | `fetching` | Stale data, refetch in background — show data, not a spinner |
| `success` | `paused` | Offline, refetch is queued |
| `error` | `idle` | Failed, nothing retrying |
| `error` | `fetching` | Failed before, now retrying |

**Why this matters for UX** — the `isLoading` flag (`status === 'pending' && fetchStatus === 'fetching'`) is the "first time ever loading" state. The `isRefetching` flag (`fetchStatus === 'fetching' && status !== 'pending'`) is "has data, silently updating". These let you build UI that never shows a spinner when you already have data to show.

---

## Why a Pure Reducer Function

```ts
function reducer<TData, TError>(
  state: QueryState<TData, TError>,
  action: QueryAction<TData, TError>,
): QueryState<TData, TError> {
  switch (action.type) {
    case 'fetch': return { ...state, fetchStatus: 'fetching', ... }
    case 'success': return { ...state, data: action.data, status: 'success', ... }
    // ...
  }
}
```

**The alternative** — you could write methods that directly mutate the state object: `this.#state.fetchStatus = 'fetching'`. This works but has three problems:

1. **Impossible to test in isolation** — you'd have to instantiate a full `Query` to test a state transition
2. **Hard to reason about** — the state can be modified from anywhere in the class
3. **Easy to introduce inconsistency** — forgetting to reset `fetchFailureCount` when a fetch succeeds, etc.

**Why a pure reducer solves all three** — it's a plain function. You can test every transition with a one-liner: `expect(reducer(pendingState, { type: 'success', data: 'x' })).toMatchObject({ status: 'success', data: 'x' })`. All state transitions are in one place. All fields that need to change for a given action are changed together.

**This is the same pattern as Redux** — for the same reasons. The Query class is essentially a mini Redux store that happens to own its own dispatch function (`#dispatch`) and exposes its state reactively.

---

## Why Request Deduplication Lives in the Promise

```ts
async fetch(): Promise<TData> {
  // If already fetching, return the SAME promise — don't start a new request
  if (this.state.fetchStatus !== 'idle') {
    if (this.#retryer) {
      this.#retryer.continue()
      return this.#retryer.promise  // ← same promise object, zero new network calls
    }
  }
  // ...create new Retryer...
  return this.#retryer.promise
}
```

**The problem** — when a React page renders, 10 components might all call `useQuery(['users'])` simultaneously. Without deduplication, that's 10 network requests.

**Why promises are the right deduplication primitive** — a Promise is a value that represents an eventual result. Multiple callers can all `.then()` the same Promise and they all get the same resolved value. No extra coordination needed. The Retryer creates one Promise. Every `query.fetch()` call after the first returns that same Promise. When it resolves, all 10 callers receive the data simultaneously.

**The key insight**: it's not that we're preventing 10 fetches by checking some boolean — it's that we're returning the same Promise object. The language runtime handles fan-out to all callers automatically.

---

## Why the Retryer is a Separate Class

You might think "why not just put retry logic in the Query?" — here's why it's separated:

**Retryer owns cancellability** — it needs to track `#status: string` (not boolean) because `cancel()` can be called at any `await` boundary from outside. A string field that `#run()` checks at every checkpoint is the cleanest way to signal "stop what you're doing" across async code.

**Retryer owns the public promise** — created in the constructor (before `start()` is called). This is subtle but important: callers can attach `.then()`/`.catch()` handlers to `retryer.promise` before any async work begins. If you created the promise inside `start()`, there'd be a window where the caller doesn't yet have a promise to attach to.

**Mutations also need a Retryer** — by separating it, both `Query` and `Mutation` share the same retry/backoff/cancellation engine without duplicating code.

**The silent cancel subtlety** — `cancel({ silent: true })` does NOT reject the promise. It just wakes up any sleeping `await` and sets status to `'cancelled'`. The `#run()` loop exits at its next checkpoint without calling `onError`. This is used internally when a query is cancelled due to a component unmounting — we don't want to trigger error state or surface an error to the user, we just want the fetch to stop.

---

## Why Subscribable Uses a Set, Not an Array

```ts
protected listeners: Set<TListener>
```

**Array approach** — `listeners.push(fn)` to add, `listeners = listeners.filter(l => l !== fn)` to remove. O(1) add, O(n) remove.

**Set approach** — `listeners.add(fn)` is O(1) add, `listeners.delete(fn)` is O(1) remove, and **automatic deduplication**.

The deduplication matters: if `useQuery` re-renders and accidentally subscribes the same listener twice, the Array approach would call it twice on every notification. The Set approach silently handles it correctly. This is especially important for React's StrictMode which double-invokes effects.

---

## Why the NotifyManager Uses setTimeout, Not Microtasks

```ts
let scheduleFn = (cb) => setTimeout(cb, 0)
```

**Microtask (Promise/queueMicrotask) approach** — runs between JavaScript tasks, before any I/O or rendering. Very fast but can create subtle ordering issues with React's render cycle in older React versions.

**Macrotask (setTimeout 0) approach** — runs as a separate task, after all current microtasks (Promise chains) complete. This means the entire fetch completion chain — including all `.then()` handlers and state updates — finishes before the notification flush runs.

**The practical effect** — when `queryFn` resolves, there's a chain of `.then()` calls inside the Retryer and Query. If notifications fired as microtasks, they might fire before some of that chain completes. Using `setTimeout(0)` guarantees the entire synchronous resolution chain completes first, then listeners are notified.

**Why it's replaceable** — `setScheduler()` lets you swap it for tests (`vi.useFakeTimers()` needs this) or tighter scheduling environments. The default is conservative and correct; you can optimize if you know your environment.

---

## Why the Cache Uses Interfaces to Break Circular Imports

This is the most architecturally interesting part of the codebase.

**The circular dependency problem:**
```
query.ts needs to call cache.notify() and cache.remove()
queryCache.ts needs to import Query (to store it in the Map)
→ query.ts imports queryCache.ts imports query.ts → circular!
```

**The naive fix** — "just use `import type`". This works for TypeScript type annotations but fails at runtime if you actually need to call methods.

**The real fix — local interfaces:**

`query.ts` defines a minimal interface describing only what it needs from the cache:
```ts
// in query.ts
export interface QueryCacheInterface {
  notify(event: QueryCacheNotifyEvent): void
  remove(query: Query): void
}
```

`queryCache.ts` imports `QueryCacheInterface` from `query.ts` and its `QueryCache` class implicitly satisfies it (structural typing). `query.ts` never imports `queryCache.ts`.

**The dependency graph becomes a DAG (no cycles):**
```
query.ts        defines QueryCacheInterface, uses it as a parameter type
queryCache.ts   imports Query (concrete), imports QueryCacheInterface (type)
                QueryCache implements QueryCacheInterface structurally
```

This pattern repeats for `QueryObserverInterface` (in query.ts), `QueryClientInterface` (in queryCache.ts and queryObserver.ts separately), and `MutationCacheInterface` (in mutation.ts). Each file defines the minimal interface it needs from its collaborators, rather than importing the full class.

**Why this matters** — circular imports in TypeScript/JavaScript can cause modules to initialize in the wrong order, leading to `undefined` where you expect a class. Breaking cycles at the interface level is the professional solution.

---

## Why GC is Deferred, Not Immediate

```ts
// When the last observer unsubscribes:
if (!this.hasListeners()) {
  this.scheduleGc()  // start a 5-minute timer
}
```

**Immediate removal** — destroy the query the moment the last component unmounts. Simple, uses less memory.

**Why immediate removal is wrong** — consider navigating from `/users` to `/settings` and back to `/users` in under a second. With immediate removal: `/users` unmounts, data is deleted, `/users` mounts again, spinner shows while re-fetching. With deferred GC (5 minutes): `/users` unmounts, data stays in memory, `/users` mounts again, instantly shows data while background-refetching.

**The 5-minute default** — long enough to cover typical navigation patterns, short enough that memory doesn't grow unboundedly. A user who never returns to a page will have that data cleaned up within 5 minutes.

**Why `Infinity` on the server** — during SSR, there's no browser GC cycle. If you GC'd queries during a server render, you'd lose data that other parts of the server render might still need. `Infinity` means "never GC" — the entire server-side query cache lives for the duration of the request and is then garbage-collected by the JS engine when the request object falls out of scope.

**Why `updateGcTime` takes the maximum** — if component A sets `gcTime: 1000` (1 second) and component B sets `gcTime: 300000` (5 minutes) for the same query, the query must live for at least 5 minutes to satisfy component B. Taking the minimum would silently break component B's expectation.

---

## Why `useSyncExternalStore` Instead of `useState` + `useEffect`

```ts
// What you might write naively:
const [result, setResult] = useState(() => observer.getOptimisticResult(options))
useEffect(() => {
  return observer.subscribe((newResult) => setResult(newResult))
}, [observer])
```

This has a **tearing problem** in React 18 concurrent mode. Between when React starts rendering and when it commits, external state can change. React might render a component with snapshot A, then another component with snapshot B (which changed during the render), resulting in an inconsistent UI — components reading different versions of the same data in the same render.

```ts
// The correct approach:
const result = useSyncExternalStore(
  observer.subscribe,                          // subscribe
  () => observer.getOptimisticResult(options), // getSnapshot — called during render
  () => observer.getOptimisticResult(options), // getServerSnapshot — SSR
)
```

`useSyncExternalStore` is React's official API for external stores. React calls `getSnapshot` during render AND before committing to check if the snapshot changed. If it changed during render (due to a concurrent update), React re-renders the component with the new snapshot — no tearing.

**The `getServerSnapshot` argument** — on the server, `subscribe` never runs (there are no state changes during SSR). React calls `getServerSnapshot` to get the initial value for hydration. Without it, server and client renders might produce different HTML, causing hydration mismatches.

---

## Why `getOptimisticResult` Exists

```ts
// Called on every render, not just when state changes:
() => observer.getOptimisticResult(options)
```

The name is misleading at first. "Optimistic" here means "computed from current options without needing a subscription to fire". Its purpose is to handle this scenario:

1. Component renders with `staleTime: 0`
2. Observer computes result — data is stale, returns `isStale: true`
3. Component re-renders with `staleTime: 60000`
4. Observer hasn't received a notification (state didn't change)
5. But the result should now be `isStale: false` because `staleTime` changed

`getOptimisticResult` re-derives the full result from current options on every render. This means option changes take effect immediately in the snapshot without needing a separate notification cycle.

---

## Why Mutations Default to `retry: 0`

```ts
// In mutation.ts:
// retry defaults to 0: mutations should not retry by default because they
// perform side-effects.
```

Queries are **idempotent** — fetching `/api/users` twice gives you the same users. You can safely retry a failed query.

Mutations are **not idempotent** — `POST /api/payments` creates a payment. If the first request succeeded but the response was lost in transit, retrying creates a duplicate payment. Defaulting to 0 retries forces developers to explicitly opt into retry logic and think about whether their mutation is safe to retry.

---

## Why Mutations Default to `gcTime: 0`

Query data needs to survive navigation (5-minute default). Mutation results don't — once a mutation is done, you don't navigate back to "the state where this mutation hadn't happened yet". There's no value in keeping finished mutation state in memory.

`gcTime: 0` means as soon as the last observer unsubscribes (`useMutation` unmounts), a `setTimeout(callback, 0)` fires and removes the mutation from cache. This is "GC immediately on next tick" rather than "GC after N minutes".

---

## Why `onMutate` Returns a Context

```ts
onMutate: (variables) => {
  const previousTodos = queryClient.getQueryData(['todos'])
  queryClient.setQueryData(['todos'], (old) => [...old, variables]) // optimistic update
  return { previousTodos }  // ← this is the "context"
},
onError: (error, variables, context) => {
  queryClient.setQueryData(['todos'], context.previousTodos) // rollback
},
```

**Without context threading** — you'd need to capture `previousTodos` in a closure. That works for simple cases but breaks for concurrent mutations: if two mutations fire before either completes, each closure captures the state at its own point in time, and rollbacks can conflict.

**With context threading** — the context is stored in the mutation's state object (`MutationState.context`). It's serializable. Each mutation instance independently carries its own rollback data. No closure, no sharing, no conflicts.

**Why it's stored in state via dispatch** — the `setContext` action writes it to `this.state.context` before the mutationFn is awaited. This means even if the process is interrupted between `onMutate` and `onError`, the context is in the serialized state and could theoretically be recovered (relevant for React Native offline persistence).

---

## Why the QueryClient Uses Ref-Counting for Mount

```ts
mount(): void {
  this.#mountCount++
  if (this.#mountCount === 1) {
    // Only subscribe to focus/online events on the first mount
    this.#unsubscribeFocus = focusManager.subscribe(...)
    this.#unsubscribeOnline = onlineManager.subscribe(...)
  }
}

unmount(): void {
  this.#mountCount--
  if (this.#mountCount <= 0) {
    // Only unsubscribe when all mounts are gone
    this.#unsubscribeFocus?.()
    this.#unsubscribeOnline?.()
  }
}
```

**The scenario** — you might render two `<QueryClientProvider>` components sharing the same `QueryClient` instance (advanced SSR patterns, testing). Without ref-counting, the second mount would subscribe to focus events again, causing double notifications on focus. The first unmount would unsubscribe, leaving the second provider without focus events.

**With ref-counting** — subscribe once when count goes 0→1, unsubscribe once when count goes 1→0. Idempotent regardless of how many providers mount.

---

## Why `QueryCache.build()` is the Only Way to Create Queries

```ts
// The only valid way to create a Query:
const query = cache.build(client, { queryKey: ['users'] })

// This would bypass all invariants:
const query = new Query(...)  // never do this
```

`build()` enforces the key invariant: **one Query instance per unique hash**. If you called `new Query()` directly, you could create two Query objects with the same hash and they'd both exist in memory but only one would be in the Map — the other would be unreachable and its updates would never propagate.

`build()` checks the Map first. If the hash exists, it returns the existing instance. This is the **Flyweight pattern** — sharing one heavyweight object (Query with its state, Retryer, observers) across all callers that reference the same key.

---

## Why `matchesQueryKey` Does Element-Level Comparison

```ts
// Bug (old approach — string prefix matching):
hashQueryKey(['todo']).startsWith(hashQueryKey(['to']).replace(/\]$/, ''))
// '["todo"]'.startsWith('["to"') → TRUE — incorrect!

// Fix (element-level matching):
target.every((element, index) =>
  hashQueryKey([element]) === hashQueryKey([queryKey[index]])
)
// hashQueryKey(['to']) === hashQueryKey(['todo'])? → FALSE — correct!
```

The string prefix approach had a subtle bug: `["todo"]` starts with `["to"` because `"todo"` starts with `"to"`. String prefixes don't respect JSON structure — they can match across element boundaries.

The fix treats the query key as a structured array. For prefix matching, every element in the filter must exactly match the corresponding element in the query key — comparing the hash of individual elements, not the combined string.

---

## Why `FocusManager` Stores `#focused` State

```ts
#focused: boolean | undefined = undefined

isFocused(): boolean {
  if (this.#focused !== undefined) return this.#focused  // ← test override
  return document.visibilityState !== 'hidden'            // ← real browser
}
```

In tests, there's no real browser `document.visibilityState`. Without the stored field, calling `focusManager.setFocused(false)` would broadcast the change to listeners but `isFocused()` would still read `document.visibilityState` and return the DOM's answer (which in jsdom is always `'visible'`).

The `#focused` field acts as an override: when explicitly set (by tests or by the application code calling `setFocused()`), it takes precedence over the DOM. When `undefined` (the default), falls back to the DOM. This is the **null object / optional override** pattern — undefined means "I haven't set an explicit override, use the real value".

---

## Why `#dispatch` Wraps Everything in `notifyManager.batch()`

```ts
#dispatch(action: QueryAction<TData, TError>): void {
  const nextState = reducer(this.state, action)
  this.state = nextState

  notifyManager.batch(() => {
    this.#observers.forEach((observer) => observer.onQueryUpdate())
    this.#cache.notify({ type: 'updated', query: this as unknown as Query, action })
  })
}
```

A single user action (e.g. a button click that triggers a mutation which then invalidates 3 queries) could cause dozens of `#dispatch` calls across multiple Query instances. Without batching:
- Each dispatch calls `onQueryUpdate()` on each observer
- Each `onQueryUpdate()` calls the listener registered by `useSyncExternalStore`
- Each listener call triggers a React state update
- Each React state update queues a re-render
- Result: 30 re-renders for one button click

With `notifyManager.batch()`:
- All dispatches within the same synchronous call stack share one batch
- All notifications queue up instead of firing
- `setTimeout(0)` fires after the call stack clears
- React's `batchNotifyFn` wraps the entire flush in React's batching
- Result: 1 re-render for one button click

---

## Why TypeScript Native `#` Private Fields Over `private` Keyword

```ts
class Query {
  #state: QueryState        // ← native private field
  private options: ...      // ← TypeScript-only private
}
```

TypeScript's `private` keyword is erased at compile time. At runtime, `query.options` is accessible to any JavaScript code. This matters for:

1. **Security** — internal state can't be mutated by external code
2. **Framework integrity** — accidental mutation of `#state` from outside would corrupt the state machine
3. **Correctness** — the JavaScript engine enforces it, not just the TypeScript compiler

Native `#` fields also have better tree-shaking and minification characteristics — bundlers can rename them aggressively.

---

## Why the `select` Option Exists

```ts
const { data } = useQuery({
  queryKey: ['user', id],
  queryFn: fetchUser,
  select: (user) => user.name,  // transform the data
})
// data is now string, not User
```

**Without `select`** — you'd apply the transform in the component: `const name = data?.name`. But this means every re-render recomputes it, and more importantly, the component re-renders whenever ANY field of `user` changes, not just `name`.

**With `select`** — the `QueryObserver` applies the transform and memoizes the result. If `user.email` changes but `user.name` doesn't, the component won't re-render because `select(newData) === select(oldData)` (same reference returned).

This is a structural optimization: each component subscribes to exactly the slice of data it needs, and only re-renders when that slice changes.

---

## Why `placeholderData` Is Not Stored in Cache

```ts
placeholderData: (previousData) => previousData  // show previous page's data while new page loads
```

`placeholderData` is a component-level concern, not a cache-level concern. The cache stores the real data for `['todos', { page: 2 }]`. While that query is loading, the component wants to show `['todos', { page: 1 }]` data to avoid a flash of empty content. That's a display decision specific to this component.

If we stored placeholder data in the cache, it would pollute the canonical data for other components that might not want placeholder behavior. By keeping it in the `QueryObserver`, each component independently decides what to show while real data loads — without affecting what the cache reports as truth.

---

## Summary: The Design Philosophy

Every decision in this codebase follows three principles:

1. **Separation of concerns at layer boundaries** — each layer has one job. The Retryer knows nothing about React. The QueryCache knows nothing about rendering. The QueryClient knows nothing about HTTP.

2. **Explicit state machines over ad-hoc flags** — instead of `this.isLoading = true; this.isFetching = true;` spread through the code, all state transitions go through the reducer. You always know which fields change together and why.

3. **Defer work, batch notifications, share results** — request deduplication (one network call for N observers), notification batching (one render for N state changes), and deferred GC (five minutes of free fast-navigation) are all the same idea: avoid work until you know exactly how much of it is needed.

These aren't just good ideas for a query library — they're patterns that apply to any stateful, event-driven system: real-time dashboards, collaborative editing tools, streaming data pipelines, distributed systems.
