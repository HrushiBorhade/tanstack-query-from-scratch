# TanStack Query From Scratch — Complete Project Overview

This document explains the **entire project** in one place: what it is, how it’s built, and how data flows from a React component to the server and back. It includes Mermaid diagrams for the architecture, components, and full request flow.

---

## 1. What This Project Is

This repo is a **from-scratch TypeScript reimplementation** of [TanStack Query](https://tanstack.com/query) (formerly React Query). The goal is **educational**: to understand async state management, the observer pattern, request deduplication, and React 18 internals by building the core yourself.

- **Not** a drop-in replacement — it’s a learning artifact.
- **No** copying of the original source; only the public API and behavior were used as a spec.
- **137 tests**, 0 TypeScript errors, 0 ESLint warnings.

**Problems it solves (that every React + server app hits):**

| Problem | How this project handles it |
|--------|------------------------------|
| Duplicate requests | Same `queryKey` → one shared `Query` → one network call (request deduplication) |
| Stale data | `staleTime`, background refetch, focus/online refetch |
| Loading state mess | Single `QueryState` with derived flags: `isLoading`, `isRefetching`, etc. |
| “Do we show spinner or old data?” | Dual-axis state: `QueryStatus` (data) + `FetchStatus` (network) |
| N re-renders for N observers | `notifyManager` batches all observer callbacks into one React render |
| Data when user navigates back | Deferred GC: data stays in cache for `gcTime` after last observer leaves |
| Optimistic updates | Mutation lifecycle: `onMutate` → context → `onError`/`onSettled` for rollback |
| Retries | `Retryer` with exponential backoff and cancellation |

---

## 2. The 7-Layer Architecture

The system is split into **7 layers**. Each layer **only depends on the layer below**. Nothing in Layer 1 imports from Layer 2; nothing in Layer 4 imports from Layer 5.

```mermaid
flowchart TB
  subgraph L7["Layer 7 — React Bindings"]
    useQuery["useQuery"]
    useMutation["useMutation"]
    QueryClientProvider["QueryClientProvider"]
  end

  subgraph L6["Layer 6 — QueryClient"]
    QC["QueryClient (public API façade)"]
  end

  subgraph L5["Layer 5 — Observers"]
    QObs["QueryObserver"]
    MObs["MutationObserver"]
  end

  subgraph L4["Layer 4 — Caches"]
    QCache["QueryCache"]
    MCache["MutationCache"]
  end

  subgraph L3["Layer 3 — State Machines"]
    Query["Query"]
    Mutation["Mutation"]
  end

  subgraph L2["Layer 2 — Infrastructure"]
    Retryer["Retryer"]
    FocusManager["FocusManager"]
    OnlineManager["OnlineManager"]
  end

  subgraph L1["Layer 1 — Primitives"]
    types["types"]
    utils["utils"]
    Subscribable["Subscribable"]
    NotifyManager["NotifyManager"]
    Removable["Removable"]
  end

  L7 --> L6
  L6 --> L5
  L5 --> L4
  L4 --> L3
  L3 --> L2
  L2 --> L1
```

**What each layer does:**

| Layer | Responsibility |
|-------|----------------|
| **1 — Primitives** | Types, `hashQueryKey`/`matchesQueryKey`, observer base (`Subscribable`), notification batching (`NotifyManager`), GC base (`Removable`). No React, no network. |
| **2 — Infrastructure** | `Retryer` (retries, backoff, cancel), `FocusManager` (tab focus), `OnlineManager` (navigator.onLine). |
| **3 — State Machines** | `Query` (cache entry + reducer + fetch lifecycle) and `Mutation` (one-off async action + lifecycle hooks). |
| **4 — Caches** | `QueryCache` = Map of `Query` by key; `MutationCache` = Map of `Mutation`. Single source of truth, event emission. |
| **5 — Observers** | `QueryObserver` / `MutationObserver`: bridge from cache entry to “something that subscribes.” Compute rich result (e.g. `QueryObserverResult`), decide when to refetch. |
| **6 — QueryClient** | Public API: `fetchQuery`, `getQueryData`, `setQueryData`, `invalidateQueries`, `cancelQueries`, etc. Holds both caches; on mount subscribes to focus/online. |
| **7 — React Bindings** | `QueryClientProvider`, `useQuery`, `useMutation`. Use `useSyncExternalStore` + observer; no direct cache access. |

---

## 3. Main Components and How They Connect

```mermaid
flowchart LR
  subgraph React["React tree"]
    Component["Component"]
    useQuery["useQuery()"]
  end

  subgraph Observer["Layer 5"]
    QObs["QueryObserver"]
  end

  subgraph Cache["Layer 4"]
    QCache["QueryCache"]
    Query["Query"]
  end

  subgraph Infra["Layer 2"]
    Retryer["Retryer"]
  end

  subgraph Prim["Layer 1"]
    NotifyManager["NotifyManager"]
    Subscribable["Subscribable"]
  end

  Component --> useQuery
  useQuery --> QObs
  QObs -->|"subscribe / getOptimisticResult"| Query
  QObs -->|"build() / find"| QCache
  QCache --> Query
  Query --> Retryer
  Query --> Subscribable
  Query --> NotifyManager
  QObs --> Subscribable
```

- **QueryCache**: Only place that creates `Query` (via `build()`). Map key = `hashQueryKey(queryKey)`.
- **Query**: One per logical “query key.” Holds state (reducer), runs fetch via `Retryer`, extends `Subscribable` (observers) and `Removable` (GC).
- **QueryObserver**: One per `useQuery` call. Subscribes to a `Query`, computes `QueryObserverResult`, decides refetch (mount, focus, reconnect, interval).
- **useQuery**: Gets `QueryClient` from context, creates/gets `QueryObserver`, uses `useSyncExternalStore(observer.subscribe, getSnapshot, getServerSnapshot)` and syncs options in `useEffect`.

---

## 4. Query State: Two Axes

State is split into two independent axes so “we have data” and “a request is in flight” can vary independently (e.g. background refetch).

```mermaid
stateDiagram-v2
  direction LR
  [*] --> pending: no data yet
  pending --> success: data received
  pending --> error: error received
  success --> success: background refetch
  success --> error: refetch failed
  error --> success: retry succeeded
  error --> error: retry again / give up

  note right of pending
    QueryStatus: pending | success | error
    (do we have data?)
  end note

  note right of success
    FetchStatus: fetching | paused | idle
    (is a request in flight?)
  end note
```

| You have… | Meaning |
|-----------|--------|
| `status: 'success'`, `fetchStatus: 'idle'` | Fresh data, no request. |
| `status: 'success'`, `fetchStatus: 'fetching'` | Background refetch: show current data, no spinner. |
| `status: 'pending'`, `fetchStatus: 'fetching'` | First load: show loading. |
| `status: 'error'`, `fetchStatus: 'fetching'` | Retrying after error. |

Derived flags like `isLoading` and `isRefetching` are computed from these two axes in the observer result.

---

## 5. End-to-End Flow: One `useQuery` Call

This is the full path from “component renders with `useQuery(['users'])`” to “component re-renders with data.”

```mermaid
sequenceDiagram
  participant Component
  participant useQuery
  participant QueryObserver
  participant QueryCache
  participant Query
  participant Retryer
  participant queryFn
  participant NotifyManager
  participant React

  Component->>useQuery: render, useQuery(['users'])
  useQuery->>QueryObserver: new QueryObserver(client, options)
  useQuery->>QueryObserver: subscribe(onStoreChange)
  QueryObserver->>QueryCache: build(client, options)
  QueryCache->>QueryCache: hashQueryKey → get or create Query
  QueryCache-->>QueryObserver: Query
  QueryObserver->>Query: addObserver(observer)

  useQuery->>QueryObserver: getOptimisticResult(options)
  QueryObserver->>Query: state (stale? should fetch on mount?)
  alt should fetch
    QueryObserver->>Query: fetch()
    Query->>Query: #dispatch({ type: 'fetch' })
    Query->>Retryer: new Retryer(...)
    Query->>Retryer: start()
    Retryer->>queryFn: queryFn({ queryKey, signal })
    queryFn-->>Retryer: data
    Retryer->>Query: onSuccess(data)
    Query->>Query: setData(data) → #dispatch({ type: 'success', data })
    Query->>Query: reducer → new state
    Query->>NotifyManager: batch(() => { ... })
    Query->>QueryObserver: observer.onQueryUpdate() for each observer
    QueryObserver->>QueryObserver: getOptimisticResult() → new result
    QueryObserver->>React: listener(newResult)
    NotifyManager->>React: flush batched updates
    React->>Component: re-render with result
  end
```

**Step-by-step (short):**

1. Component renders → `useQuery(['users'])` runs.
2. `useQuery` creates (or reuses) a `QueryObserver` and subscribes to it via `useSyncExternalStore`.
3. Observer gets the right `Query` from `QueryCache.build()` (same key ⇒ same `Query` instance).
4. Observer subscribes to that `Query` (`addObserver`).
5. `getOptimisticResult(options)` runs (for snapshot). Observer decides: stale or should fetch on mount? If yes → `query.fetch()`.
6. `Query.fetch()`: if no in-flight fetch, creates `Retryer`, dispatches `fetch`, runs `queryFn`.
7. `queryFn` resolves → Retryer `onSuccess(data)` → `Query.setData(data)` → `#dispatch({ type: 'success', data })`.
8. Reducer updates state; `Query` notifies all observers inside `notifyManager.batch()`.
9. Each observer’s `onQueryUpdate()` runs; they notify their listeners (the one from `useSyncExternalStore`).
10. Batched flush runs → React sees store change → re-reads snapshot → component re-renders with new result.

---

## 6. Request Deduplication and Notifications

**Deduplication:** Many components, same key ⇒ one `Query` ⇒ one `fetch()`. If `fetch()` is already in progress, it returns the **same** `Retryer.promise`; no second network call.

```mermaid
flowchart LR
  subgraph Components
    A["useQuery(['users'])"]
    B["useQuery(['users'])"]
    C["useQuery(['users'])"]
  end

  subgraph Cache
    Query["Query (key: ['users'])"]
  end

  subgraph Network
    Retryer["Retryer"]
    API["API"]
  end

  A --> Query
  B --> Query
  C --> Query
  Query --> Retryer
  Retryer --> API
```

**Notification batching:** One state change (e.g. one fetch success) can trigger many observer callbacks. Without batching, each would schedule a React update → N re-renders. `NotifyManager` queues those callbacks and flushes them once (e.g. in one `setTimeout(0)` or React’s batch), so you get **one** render for that event.

---

## 7. Garbage Collection (Deferred Removal)

Queries are not removed as soon as the last component unmounts. They stay for `gcTime` (e.g. 5 minutes). If the user comes back within that window, the same `Query` is still in the cache and can show data immediately (and optionally refetch in the background).

```mermaid
sequenceDiagram
  participant Observer
  participant Query
  participant Removable
  participant QueryCache

  Observer->>Query: removeObserver(observer)
  Query->>Query: observer count → 0?
  alt last observer
    Query->>Removable: scheduleGc()  [setTimeout(gcTime)]
    Note over Removable: wait gcTime ms
    Removable->>Query: optionalRemove()
    Query->>Query: still no observers?
    Query->>QueryCache: remove(this)
  else new observer before timeout
    Observer->>Query: addObserver(observer)
    Query->>Removable: clearGcTimeout()
  end
```

---

## 8. Mutation Flow (Simplified)

Mutations don’t cache by key; they’re one-off actions. Lifecycle: `onMutate` (optional optimistic update) → `mutationFn` → `onSuccess` or `onError` → `onSettled`. The return value of `onMutate` is passed as `context` to `onError` and `onSettled` so you can roll back.

```mermaid
sequenceDiagram
  participant Component
  participant useMutation
  participant MutationObserver
  participant MutationCache
  participant Mutation
  participant mutationFn

  Component->>useMutation: mutate(variables)
  useMutation->>MutationObserver: mutate(variables)
  MutationObserver->>MutationCache: build(options)
  MutationCache->>Mutation: new Mutation()
  Mutation->>Mutation: onMutate() → context
  Mutation->>mutationFn: mutationFn(variables)
  alt success
    mutationFn-->>Mutation: data
    Mutation->>Mutation: onSuccess(data)
    Mutation->>Mutation: onSettled(data, null)
  else error
    mutationFn-->>Mutation: error
    Mutation->>Mutation: onError(error) — can use context to rollback
    Mutation->>Mutation: onSettled(undefined, error)
  end
  Mutation->>MutationObserver: notify
  MutationObserver->>Component: new result
```

---

## 9. Design Patterns Used

| Pattern | Where | Purpose |
|--------|--------|--------|
| **Observer (pub/sub)** | `Subscribable` | Decouple state changes from who reacts (Query ↔ observers, cache ↔ DevTools). |
| **State machine** | `Query` / `Mutation` reducer | All transitions in one pure function; easy to test and reason about. |
| **Deferred GC** | `Removable` | Keep data for `gcTime` after last observer; fast back-navigation. |
| **Request deduplication** | `Query.fetch()` + `Retryer.promise` | N observers ⇒ 1 network request. |
| **Notification batching** | `NotifyManager` | N state changes ⇒ 1 React render. |
| **Façade** | `QueryClient` | Single public API over caches and options. |
| **useSyncExternalStore** | `useQuery` / `useMutation` | Safe subscription to external store (no tearing, SSR-friendly). |
| **Context threading** | Mutation `onMutate` → `onError` / `onSettled` | Optimistic updates and rollback. |
| **Interfaces to break cycles** | `QueryCacheInterface` in `query.ts`, etc. | Avoid circular imports while keeping type safety. |

---

## 10. File Map (Where to Look)

| Layer | Files |
|-------|--------|
| 1 | `types.ts`, `utils.ts`, `subscribable.ts`, `notifyManager.ts`, `removable.ts` |
| 2 | `retryer.ts`, `focusManager.ts`, `onlineManager.ts` |
| 3 | `query.ts`, `mutation.ts` |
| 4 | `queryCache.ts`, `mutationCache.ts` |
| 5 | `queryObserver.ts`, `mutationObserver.ts` |
| 6 | `queryClient.ts` |
| 7 | `QueryClientProvider.tsx`, `useQuery.ts`, `useMutation.ts`, `useQueryClient.ts` |

For more detail: **ARCHITECTURE.md** (per-file walkthrough of every layer).

---

## Summary

- **What:** A from-scratch TanStack Query–style library in TypeScript for learning.
- **How:** 7 layers (Primitives → Infrastructure → State Machines → Caches → Observers → QueryClient → React Bindings), with observer pattern, pure reducers, request deduplication, notification batching, and deferred GC.
- **Flow:** Component → `useQuery` → `QueryObserver` → `QueryCache.build()` → `Query` → `Retryer` → `queryFn`; state updates go through reducer → observers → `NotifyManager` → one React render.

The Mermaid diagrams above (layers, components, sequence, state, GC, mutation) give a visual map of this flow and how the pieces fit together.
