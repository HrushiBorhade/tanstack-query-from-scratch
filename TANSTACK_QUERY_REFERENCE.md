# TanStack Query (React Query) -- Complete API & Concepts Reference

---

## 1. CORE CONCEPTS

### What TanStack Query Is

TanStack Query is a library for **fetching, caching, synchronizing, and updating server state** in React applications. It is NOT a general-purpose state manager -- it is purpose-built for the unique challenges of server state.

### The Problem It Solves

Server state is fundamentally different from client state because it:
- **Exists remotely** in locations you do not control
- **Requires async APIs** to fetch and update
- **Has shared ownership** -- other users/processes can change it without your knowledge
- **Can become stale** in your application if you do nothing

These properties create hard problems: caching, request deduplication, background updates, staleness detection, pagination, garbage collection, and structural sharing of results.

### Three Pillars

1. **Queries** -- Declarative data fetching tied to unique keys. Read operations.
2. **Mutations** -- Imperative side effects that create/update/delete data. Write operations.
3. **Query Invalidation** -- The mechanism to mark cached data as stale and trigger refetches.

---

## 2. QUERY KEYS

Query keys are the **identity** of every query. They determine cache entries and enable invalidation.

### Rules

- Must be **arrays** at the top level: `['todos']`, `['todo', 5]`
- Must be **serializable** via `JSON.stringify`
- Must be **unique** to the query's data

### Key Types

```ts
// Simple list
useQuery({ queryKey: ['todos'], ... })

// Individual item
useQuery({ queryKey: ['todo', 5], ... })

// Filtered/parameterized
useQuery({ queryKey: ['todos', { type: 'done' }], ... })

// With multiple variables
useQuery({ queryKey: ['todo', 5, { preview: true }], ... })
```

### Hashing & Comparison

**Object key order does NOT matter** -- these are all identical:
```ts
['todos', { status, page }]
['todos', { page, status }]
['todos', { page, status, other: undefined }]
```

**Array position DOES matter** -- these are different:
```ts
['todos', status, page]  // !== ['todos', page, status]
```

### Dependent Variables Rule

Any variable that **changes** and is used in the query function MUST appear in the query key. This ensures queries are cached independently and refetch automatically when variables change.

```ts
useQuery({
  queryKey: ['todos', { status, page }],
  queryFn: () => fetchTodos(status, page),
})
```

---

## 3. QUERIES IN DEPTH

### What a Query Is

A query is a declarative dependency on an asynchronous data source, tied to a unique key. It requires:
1. A **query key** (for caching and identity)
2. A **query function** (returns a Promise that resolves data or throws)

### Query States (Two Dimensions)

**Status** (do we have data?):
| Status | Boolean | Meaning |
|--------|---------|---------|
| `'pending'` | `isPending` | No data yet (first fetch in progress or query disabled) |
| `'error'` | `isError` | Query function threw an error |
| `'success'` | `isSuccess` | Data successfully resolved and available |

**FetchStatus** (is the queryFn running?):
| FetchStatus | Boolean | Meaning |
|-------------|---------|---------|
| `'fetching'` | `isFetching` | Currently executing the query function |
| `'paused'` | `isPaused` | Query wanted to fetch but is paused (offline) |
| `'idle'` | -- | Not currently fetching |

**Why two dimensions?** Because a query can be in `status: 'success'` AND `fetchStatus: 'fetching'` simultaneously (background refetch with stale data shown). The status tells you about DATA availability; the fetchStatus tells you about QUERY FUNCTION execution.

### Derived Flags

- `isLoading` = `isPending && isFetching` (first fetch is in-flight, no cached data)
- `isRefetching` = `!isPending && isFetching` (background refetch, data already available)

### Recommended Render Pattern

```tsx
const { isPending, isError, data, error } = useQuery({ ... })

if (isPending) return <Loading />
if (isError) return <Error message={error.message} />
// At this point, status === 'success' is guaranteed
return <DataView data={data} />
```

---

## 4. IMPORTANT DEFAULT BEHAVIORS (AND WHY)

### staleTime: 0 (immediate staleness)

**Default:** Data is considered stale the instant it arrives in the cache.
**Why:** Ensures data is always as fresh as possible. If you know data changes infrequently, increase `staleTime` to reduce network traffic.

### gcTime: 5 minutes (300,000 ms)

**Default:** Inactive (no observers/subscribers) query data remains in cache for 5 minutes before garbage collection.
**Why:** Balances memory usage against the probability of data reuse. Allows navigating back to a page and seeing cached data instantly.

### Automatic Refetch Triggers (on stale data)

Stale queries automatically refetch when:
1. **New query instance mounts** (`refetchOnMount: true`)
2. **Window regains focus** (`refetchOnWindowFocus: true`)
3. **Network reconnects** (`refetchOnReconnect: true`)

**Why:** Keeps data synchronized with the server automatically. Users returning to tabs or recovering from network loss get fresh data without manual intervention.

### retry: 3 (with exponential backoff)

**Default:** Failed queries retry 3 times on the client (0 on the server) with exponential backoff.
**Why:** Transient network failures are common. Automatic retries prevent unnecessary error states from brief connectivity blips.

### Structural Sharing: enabled

**Default:** Query results are structurally shared -- unchanged parts of the data tree keep the same object references.
**Why:** Optimizes React renders. If only part of the data changed, unchanged subtrees keep referential identity, helping `useMemo`, `useCallback`, and React's reconciler avoid unnecessary work. Only works with JSON-compatible values.

### refetchInterval: off

**Default:** Queries do not poll automatically.
**Note:** When enabled, `refetchInterval` operates independently of `staleTime`.

---

## 5. THE QUERY LIFECYCLE

```
1. FRESH        Query fetched, data within staleTime window
                 No automatic refetches triggered.
                    |
                    | staleTime expires
                    v
2. STALE        Data is stale. Refetches triggered by:
                 - Component mount
                 - Window focus
                 - Network reconnect
                 - Explicit invalidation
                    |
                    | All observers/subscribers unmount
                    v
3. INACTIVE     No components watching this query.
                 gcTime countdown begins (default: 5 min).
                 Data still in cache -- new mount gets instant data + background refetch.
                    |
                    | gcTime expires
                    v
4. GARBAGE      Cache entry removed entirely.
   COLLECTED    Next mount triggers fresh fetch with loading state.
```

### Detailed Caching Scenario

1. **First mount:** `useQuery({ queryKey: ['todos'] })` -- hard loading state, network request. Data cached under `['todos']`.
2. **Second mount (same key):** Data returned **immediately from cache**. Background refetch triggered (if stale). Both instances update together.
3. **All instances unmount:** Query becomes inactive. gcTime countdown starts (5 min default).
4. **Remount before gcTime:** Cached data returned instantly. Background refetch fires. No loading spinner.
5. **gcTime expires:** Cached data deleted. Next mount is a fresh fetch with loading state.

---

## 6. WINDOW FOCUS REFETCHING

**Behavior:** When a user leaves your app (switches tabs) and returns, TanStack Query automatically refetches all stale queries in the background.

**Implementation:** Listens to `document.visibilitychange` event and refetches when `document.visibilityState === 'visible'`.

**Disable globally:**
```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
    },
  },
})
```

**Disable per-query:**
```ts
useQuery({
  queryKey: ['todos'],
  queryFn: fetchTodos,
  refetchOnWindowFocus: false,
})
```

**Custom focus events:**
```ts
import { focusManager } from '@tanstack/react-query'

focusManager.setEventListener((handleFocus) => {
  // Custom logic -- call handleFocus(true/false)
})
```

**React Native:** Use `AppState` module instead:
```ts
focusManager.setFocused(appState === 'active')
```

---

## 7. BACKGROUND FETCHING INDICATORS

### isFetching vs isPending

- `isPending` / `status === 'pending'` -- initial hard-loading state (no cached data)
- `isFetching` -- ANY fetch is in-flight, including background refetches

```tsx
function Todos() {
  const { status, data, isFetching } = useQuery({
    queryKey: ['todos'],
    queryFn: fetchTodos,
  })

  // Show spinner on initial load
  if (status === 'pending') return <Spinner />

  // Show subtle indicator during background refetch
  return (
    <div>
      {isFetching && <SmallRefreshIndicator />}
      <TodoList data={data} />
    </div>
  )
}
```

### Global Fetching Indicator

```tsx
import { useIsFetching } from '@tanstack/react-query'

function GlobalLoadingIndicator() {
  const isFetching = useIsFetching()  // number of queries currently fetching
  return isFetching ? <GlobalSpinner /> : null
}
```

---

## 8. QUERY INVALIDATION

### What It Does

`invalidateQueries` does two things:
1. Marks matching queries as **stale** (overrides any staleTime configuration)
2. **Refetches** any queries that are currently rendered/active

### Matching Strategies

**Invalidate ALL queries:**
```ts
queryClient.invalidateQueries()
```

**Prefix matching (default):**
```ts
// Invalidates ['todos'], ['todos', 1], ['todos', { type: 'done' }], etc.
queryClient.invalidateQueries({ queryKey: ['todos'] })
```

**Exact matching:**
```ts
// Only invalidates ['todos'] -- not ['todos', 1]
queryClient.invalidateQueries({ queryKey: ['todos'], exact: true })
```

**Partial key matching with parameters:**
```ts
// Invalidates ['todos', { type: 'done' }] but not ['todos', { type: 'active' }]
queryClient.invalidateQueries({ queryKey: ['todos', { type: 'done' }] })
```

**Predicate-based matching:**
```ts
queryClient.invalidateQueries({
  predicate: (query) =>
    query.queryKey[0] === 'todos' && query.queryKey[1]?.version >= 10,
})
```

### Philosophy

TanStack Query uses **targeted invalidation + background refetching + atomic updates** rather than normalized caches. This is simpler and avoids the complexity of cache normalization.

---

## 9. MUTATIONS IN DEPTH

### What a Mutation Is

Mutations handle **write operations** -- create, update, delete data, or perform server-side effects. Unlike queries, mutations are imperative (you call `mutate()` to trigger them).

### Mutation States

| Status | Boolean | Meaning |
|--------|---------|---------|
| `'idle'` | `isIdle` | Fresh/reset state, not yet called |
| `'pending'` | `isPending` | Currently executing |
| `'error'` | `isError` | Mutation failed |
| `'success'` | `isSuccess` | Mutation succeeded |

### Lifecycle Callbacks

```ts
useMutation({
  mutationFn: createTodo,
  onMutate: (variables) => {
    // Fires BEFORE mutationFn executes
    // Ideal for optimistic updates
    // Return value becomes "context" for onError/onSettled
  },
  onSuccess: (data, variables, context) => {
    // Fires on success
    // Common: invalidate queries here
  },
  onError: (error, variables, context) => {
    // Fires on failure
    // Common: roll back optimistic updates using context
  },
  onSettled: (data, error, variables, context) => {
    // Fires regardless of success/failure
    // Common: cleanup, invalidation
  },
})
```

**Callback order:** `useMutation` callbacks fire first, then `mutate()` call-specific callbacks.

**Promise chaining:** If callbacks return promises, subsequent callbacks wait for completion.

### mutate() vs mutateAsync()

```ts
// Fire-and-forget (void return)
mutation.mutate(variables, { onSuccess, onError, onSettled })

// Awaitable promise
const data = await mutation.mutateAsync(variables)
```

### Mutation Scopes

```ts
useMutation({
  mutationFn: updateTodo,
  scope: { id: 'todo-updates' },
  // All mutations with scope 'todo-updates' run serially (queued)
})
```

### Common Pattern: Invalidation After Mutation

```ts
const queryClient = useQueryClient()

const mutation = useMutation({
  mutationFn: createTodo,
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['todos'] })
  },
})
```

---

## 10. COMPLETE useQuery API REFERENCE

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `queryKey` | `unknown[]` | **required** | Unique key for caching. Deterministically hashed. |
| `queryFn` | `(context: QueryFunctionContext) => Promise<TData>` | **required** | Async function that returns data or throws. Context includes `queryKey`, `signal`, `meta`. |
| `enabled` | `boolean \| (query) => boolean` | `true` | Controls whether query runs automatically. `false` = disabled (won't fetch on mount/focus/etc). |
| `staleTime` | `number \| 'static' \| ((query) => number \| 'static')` | `0` | Milliseconds before data considered stale. `Infinity` or `'static'` = never stale. |
| `gcTime` | `number \| Infinity` | `300000` (5 min) | Milliseconds unused cache data kept in memory. `Infinity` = never GC'd. |
| `retry` | `boolean \| number \| (failureCount, error) => boolean` | `3` (client), `0` (server) | Number of retries on failure. `false` = no retries. |
| `retryDelay` | `number \| (attempt, error) => number` | Exponential backoff | Delay between retries. |
| `retryOnMount` | `boolean` | `true` | Whether to retry failed queries on mount. |
| `refetchInterval` | `number \| false \| ((query) => number \| false)` | `false` | Polling interval in ms. |
| `refetchIntervalInBackground` | `boolean` | `false` | Continue polling when tab is backgrounded. |
| `refetchOnMount` | `boolean \| 'always' \| ((query) => boolean \| 'always')` | `true` | Refetch stale queries on mount. `'always'` = refetch even if fresh. |
| `refetchOnWindowFocus` | `boolean \| 'always' \| ((query) => boolean \| 'always')` | `true` | Refetch stale queries on window focus. |
| `refetchOnReconnect` | `boolean \| 'always' \| ((query) => boolean \| 'always')` | `true` | Refetch stale queries on network reconnect. |
| `select` | `(data: TData) => unknown` | -- | Transform/select from cached data. Does NOT affect cache, only what component receives. |
| `initialData` | `TData \| () => TData` | -- | Seed the cache. Treated as if it was fetched (persisted to cache). Considered stale unless `staleTime` set. |
| `initialDataUpdatedAt` | `number \| () => number` | -- | Timestamp (ms) of when initialData was last fresh. Used to determine staleness. |
| `placeholderData` | `TData \| (previousValue, previousQuery) => TData` | -- | Shown while pending. NOT persisted to cache. `isPlaceholderData` flag set to true. Previous query's data can be passed via callback. |
| `networkMode` | `'online' \| 'always' \| 'offlineFirst'` | `'online'` | Controls fetch behavior relative to network status. |
| `notifyOnChangeProps` | `string[] \| 'all'` | -- | Only re-render when listed properties change. Optimization for reducing renders. |
| `structuralSharing` | `boolean \| (oldData, newData) => unknown` | `true` | Preserve referential identity for unchanged data. Custom function for non-JSON data. |
| `throwOnError` | `boolean \| (error, query) => boolean` | `false` | Throw to nearest error boundary instead of returning error state. |
| `meta` | `Record<string, unknown>` | -- | Arbitrary metadata accessible in query lifecycle (queryFn context, cache callbacks). |
| `queryKeyHashFn` | `(queryKey) => string` | -- | Custom hash function for the query key. |
| `subscribed` | `boolean` | `true` | If false, this useQuery instance does not subscribe to cache updates. |
| `queryClient` | `QueryClient` | -- | Use a specific QueryClient instead of the one from context. |

### Return Values

| Property | Type | Description |
|----------|------|-------------|
| `data` | `TData` | Last successfully resolved data. |
| `error` | `TError \| null` | Error object if query encountered an error. |
| `status` | `'pending' \| 'error' \| 'success'` | Current status. |
| `isPending` | `boolean` | `status === 'pending'` |
| `isSuccess` | `boolean` | `status === 'success'` |
| `isError` | `boolean` | `status === 'error'` |
| `isLoadingError` | `boolean` | Failed during first fetch (no prior data). |
| `isRefetchError` | `boolean` | Failed during a refetch (prior data may exist). |
| `fetchStatus` | `'fetching' \| 'paused' \| 'idle'` | Current fetch activity. |
| `isFetching` | `boolean` | `fetchStatus === 'fetching'` |
| `isPaused` | `boolean` | `fetchStatus === 'paused'` |
| `isLoading` | `boolean` | `isPending && isFetching` (first fetch in-flight). |
| `isRefetching` | `boolean` | `!isPending && isFetching` (background refetch). |
| `isStale` | `boolean` | Data exceeds staleTime or has been invalidated. |
| `isPlaceholderData` | `boolean` | Currently showing placeholder data. |
| `isFetched` | `boolean` | Query has been fetched at least once. |
| `isFetchedAfterMount` | `boolean` | Fetched after this component mounted. |
| `isEnabled` | `boolean` | Query observer is enabled. |
| `dataUpdatedAt` | `number` | Timestamp when data was last successfully fetched. |
| `errorUpdatedAt` | `number` | Timestamp when error last occurred. |
| `failureCount` | `number` | Consecutive failure count. Resets on success. |
| `failureReason` | `TError \| null` | Error from the last retry failure. |
| `errorUpdateCount` | `number` | Total count of all errors over the query lifetime. |
| `refetch` | `(options?) => Promise<UseQueryResult>` | Manually trigger a refetch. Options: `{ throwOnError, cancelRefetch }`. |
| `promise` | `Promise<TData>` | Stable promise that resolves with query data (for Suspense). |

---

## 11. COMPLETE useMutation API REFERENCE

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `mutationFn` | `(variables: TVariables) => Promise<TData>` | **required** | The async function to perform the mutation. |
| `mutationKey` | `unknown[]` | -- | Optional key for inheriting defaults via `setMutationDefaults`. |
| `onMutate` | `(variables) => Promise<TContext> \| TContext` | -- | Fires before mutationFn. Return value available as context in other callbacks. |
| `onSuccess` | `(data, variables, context) => Promise \| void` | -- | Fires on success. |
| `onError` | `(error, variables, context) => Promise \| void` | -- | Fires on error. |
| `onSettled` | `(data, error, variables, context) => Promise \| void` | -- | Fires on success OR error. |
| `retry` | `boolean \| number \| (failureCount, error) => boolean` | `0` | Retries on failure. Default is NO retries (unlike queries). |
| `retryDelay` | `number \| (attempt, error) => number` | -- | Delay between retries. |
| `gcTime` | `number \| Infinity` | `300000` (5 min) | How long unused mutation data stays in cache. |
| `networkMode` | `'online' \| 'always' \| 'offlineFirst'` | `'online'` | Controls mutation behavior relative to network. |
| `throwOnError` | `boolean \| (error) => boolean` | `false` | Throw to error boundary. |
| `scope` | `{ id: string }` | unique id | Mutations with same scope.id run **serially** (queued). Default: parallel. |
| `meta` | `Record<string, unknown>` | -- | Arbitrary metadata on the mutation cache entry. |
| `queryClient` | `QueryClient` | -- | Use specific QueryClient. |

### Return Values

| Property | Type | Description |
|----------|------|-------------|
| `mutate` | `(variables, { onSuccess?, onError?, onSettled? }) => void` | Trigger mutation. Void return -- use callbacks for side effects. |
| `mutateAsync` | `(variables, { onSuccess?, onError?, onSettled? }) => Promise<TData>` | Trigger mutation. Returns awaitable promise. |
| `status` | `'idle' \| 'pending' \| 'error' \| 'success'` | Current mutation status. |
| `isIdle` | `boolean` | Not yet called or has been reset. |
| `isPending` | `boolean` | Currently executing. |
| `isSuccess` | `boolean` | Last mutation succeeded. |
| `isError` | `boolean` | Last mutation failed. |
| `isPaused` | `boolean` | Mutation is paused (offline). |
| `data` | `TData \| undefined` | Last successfully resolved data. |
| `error` | `TError \| null` | Error from last mutation. |
| `variables` | `TVariables \| undefined` | Variables passed to the last `mutate` call. |
| `failureCount` | `number` | Consecutive failures. Resets on success. |
| `failureReason` | `TError \| null` | Error from last retry. |
| `submittedAt` | `number` | Timestamp when mutation was submitted. |
| `reset` | `() => void` | Reset mutation to idle state (clear data, error, variables). |

### Key Differences from useQuery

| Aspect | useQuery | useMutation |
|--------|----------|-------------|
| Trigger | Automatic (on mount, focus, etc.) | Manual (`mutate()`) |
| Default retry | 3 | 0 |
| Has `idle` status | No | Yes |
| Caching | Cached by queryKey | Not cached by default |
| Refetching | Automatic on stale | N/A |
| Return | Declarative data | Imperative mutate function |

---

## 12. COMPLETE QueryClient API REFERENCE

### Constructor

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5000, gcTime: 300000, retry: 3, ... },
    mutations: { retry: 0, ... },
  },
})
```

### Query Fetching Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `fetchQuery(options)` | `Promise<TData>` | Fetch and cache a query. Uses same options as `useQuery` (minus UI-specific ones). If cached data exists and is not stale, returns it without fetching. |
| `prefetchQuery(options)` | `Promise<void>` | Like fetchQuery but does not return data or throw errors. Fire-and-forget pre-loading. |
| `fetchInfiniteQuery(options)` | `Promise<InfiniteData>` | Infinite query variant of fetchQuery. |
| `prefetchInfiniteQuery(options)` | `Promise<void>` | Infinite query variant of prefetchQuery. |
| `ensureQueryData(options)` | `Promise<TData>` | Returns cached data if available, otherwise fetches. Has `revalidateIfStale` option. |
| `ensureInfiniteQueryData(options)` | `Promise<InfiniteData>` | Infinite variant of ensureQueryData. |

### Data Access Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getQueryData(queryKey)` | `TData \| undefined` | **Synchronous.** Get cached data for a query key. Returns undefined if not cached. |
| `getQueriesData(filters)` | `[QueryKey, TData \| undefined][]` | Get data for multiple queries matching filters. |
| `getQueryState(queryKey)` | `QueryState \| undefined` | **Synchronous.** Get the full state object (status, data, error, timestamps, etc.) for a query. |

### Data Mutation Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `setQueryData(queryKey, updater)` | -- | **Synchronous.** Immediately update cached data. `updater` can be a value or `(oldData) => newData` function. If updater returns `undefined`, data is not updated. |
| `setQueriesData(filters, updater)` | -- | Update data for multiple queries matching filters. |

### Cache Management Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `invalidateQueries(filters?, options?)` | `Promise<void>` | Mark queries as stale + refetch active ones. Options: `{ throwOnError, cancelRefetch }`. |
| `refetchQueries(filters?, options?)` | `Promise<void>` | Force refetch matching queries (regardless of staleness). Options: `{ throwOnError, cancelRefetch }`. |
| `cancelQueries(filters?)` | -- | Cancel in-flight queries. Uses AbortController signal. |
| `removeQueries(filters?)` | -- | Remove queries from cache entirely (data gone). |
| `resetQueries(filters?, options?)` | `Promise<void>` | Reset queries to initial state. If `initialData` was provided, resets to that. Otherwise status becomes `pending`. |
| `clear()` | -- | Remove ALL queries and mutations from all caches. Nuclear option. |

### Status Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `isFetching(filters?)` | `number` | Count of queries currently fetching. |
| `isMutating(filters?)` | `number` | Count of mutations currently executing. |

### Configuration Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `getDefaultOptions()` | `DefaultOptions` | Get globally configured default options. |
| `setDefaultOptions(options)` | -- | Dynamically set default options for all queries/mutations. |
| `getQueryDefaults(queryKey)` | `QueryOptions` | Get defaults for queries matching a key. |
| `setQueryDefaults(queryKey, options)` | -- | Set default options for specific query keys. Matched by prefix. |
| `getMutationDefaults(mutationKey)` | `MutationOptions` | Get defaults for mutations matching a key. |
| `setMutationDefaults(mutationKey, options)` | -- | Set default options for specific mutation keys. |

### Cache Access

| Method | Returns | Description |
|--------|---------|-------------|
| `getQueryCache()` | `QueryCache` | Access the underlying query cache instance. |
| `getMutationCache()` | `MutationCache` | Access the underlying mutation cache instance. |

### Utility

| Method | Returns | Description |
|--------|---------|-------------|
| `resumePausedMutations()` | -- | Resume mutations that were paused due to offline state. |

### QueryFilters Object

Used by invalidateQueries, refetchQueries, cancelQueries, removeQueries, etc.:

```ts
{
  queryKey?: QueryKey,      // Match by key prefix (or exact with exact: true)
  exact?: boolean,          // Only match exact key (no prefix matching)
  type?: 'active' | 'inactive' | 'all',  // Filter by observer status
  stale?: boolean,          // Filter by staleness
  fetchStatus?: FetchStatus,
  predicate?: (query: Query) => boolean,  // Custom matching function
}
```

---

## 13. PROVIDER SETUP

```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,           // default
      gcTime: 1000 * 60 * 5,  // 5 minutes (default)
      retry: 3,               // default
      refetchOnWindowFocus: true,  // default
      refetchOnMount: true,        // default
      refetchOnReconnect: true,    // default
    },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
    </QueryClientProvider>
  )
}
```

---

## 14. COMMON PATTERNS

### Dependent Queries

```tsx
const { data: user } = useQuery({
  queryKey: ['user', userId],
  queryFn: () => fetchUser(userId),
})

const { data: projects } = useQuery({
  queryKey: ['projects', user?.id],
  queryFn: () => fetchProjects(user.id),
  enabled: !!user?.id,  // only runs when user.id is available
})
```

### Optimistic Updates

```tsx
useMutation({
  mutationFn: updateTodo,
  onMutate: async (newTodo) => {
    await queryClient.cancelQueries({ queryKey: ['todos'] })
    const previousTodos = queryClient.getQueryData(['todos'])
    queryClient.setQueryData(['todos'], (old) => [...old, newTodo])
    return { previousTodos }  // context for rollback
  },
  onError: (err, newTodo, context) => {
    queryClient.setQueryData(['todos'], context.previousTodos)
  },
  onSettled: () => {
    queryClient.invalidateQueries({ queryKey: ['todos'] })
  },
})
```

### Invalidation After Mutation

```tsx
const queryClient = useQueryClient()

const mutation = useMutation({
  mutationFn: createTodo,
  onSuccess: () => {
    // Invalidates all queries starting with ['todos']
    queryClient.invalidateQueries({ queryKey: ['todos'] })
  },
})
```

### Placeholder Data from Previous Query

```tsx
useQuery({
  queryKey: ['todo', todoId],
  queryFn: () => fetchTodo(todoId),
  placeholderData: (previousData) => previousData,  // keep previous todo visible while new one loads
})
```

### Polling

```tsx
useQuery({
  queryKey: ['notifications'],
  queryFn: fetchNotifications,
  refetchInterval: 5000,  // poll every 5 seconds
  refetchIntervalInBackground: true,  // continue polling in background tabs
})
```

---

## 15. MENTAL MODEL SUMMARY

```
                    +-----------+
                    |  QueryKey |  Identity & cache key
                    +-----+-----+
                          |
                    +-----v-----+
                    |  QueryFn  |  Promise-returning async function
                    +-----+-----+
                          |
                    +-----v-----+
     staleTime=0 -> |   FRESH   |  Data just fetched, within staleTime
                    +-----+-----+
                          |  staleTime expires
                    +-----v-----+
       auto-refetch |   STALE   |  Background refetch on mount/focus/reconnect
         triggers   +-----+-----+
                          |  all observers unmount
                    +-----v-----+
        gcTime=5min |  INACTIVE  |  No subscribers, GC countdown running
                    +-----+-----+
                          |  gcTime expires
                    +-----v-----+
                    |  GARBAGE   |  Entry removed from cache
                    | COLLECTED  |
                    +-----+-----+

    invalidateQueries() -> forces STALE + triggers refetch of active queries
    setQueryData()      -> directly updates cache (no network request)
    removeQueries()     -> immediately removes from cache
    resetQueries()      -> resets to initial state (initialData or pending)
```

### Key Insight: Stale-While-Revalidate

TanStack Query's core strategy is **stale-while-revalidate**: serve cached (potentially stale) data immediately to the user, then refetch in the background and swap in fresh data when it arrives. This creates the perception of instant responses while keeping data fresh.
