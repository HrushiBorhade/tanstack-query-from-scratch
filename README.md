# TanStack Query — From Scratch

A ground-up TypeScript implementation of [TanStack Query](https://tanstack.com/query) (formerly React Query), built to deeply understand async state management, the observer pattern, request deduplication, and React 18 internals.

> 137 tests passing &nbsp;|&nbsp; 0 TypeScript errors &nbsp;|&nbsp; 0 ESLint warnings &nbsp;|&nbsp; 177 kB bundle (55 kB gzip)

---

## Overview

This project re-implements the core of TanStack Query from first principles — no source code referenced, only the public API and behaviour as a specification. Every subsystem is written in TypeScript with native `#` private fields, strict types, and full test coverage.

The goal is not a drop-in replacement. It is an educational artefact: a codebase where every design decision has a documented reason.

---

## Architecture

The implementation is split into 7 layers. Each layer only depends on the one below it.

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 7 │ React Bindings                                     │
│          │  useQuery · useMutation · QueryClientProvider      │
├──────────────────────────────────────────────────────────────┤
│  Layer 6 │ QueryClient                                        │
│          │  Public façade / API surface                       │
├──────────────────────────────────────────────────────────────┤
│  Layer 5 │ Observers                                          │
│          │  QueryObserver · MutationObserver                  │
├──────────────────────────────────────────────────────────────┤
│  Layer 4 │ Caches                                             │
│          │  QueryCache · MutationCache                        │
├──────────────────────────────────────────────────────────────┤
│  Layer 3 │ State Machines                                     │
│          │  Query · Mutation                                  │
├──────────────────────────────────────────────────────────────┤
│  Layer 2 │ Infrastructure                                     │
│          │  Retryer · FocusManager · OnlineManager            │
├──────────────────────────────────────────────────────────────┤
│  Layer 1 │ Primitives                                         │
│          │  types · utils · Subscribable · NotifyManager      │
│          │  Removable                                         │
└──────────────────────────────────────────────────────────────┘
```

---

## Features Implemented

| Feature | Details |
|---|---|
| **Request deduplication** | N components with the same query key → 1 network request |
| **Background refetching** | Stale data shown instantly while a silent refetch runs |
| **Garbage collection** | Deferred removal with configurable `gcTime` window |
| **Exponential backoff** | Configurable `retry` count and `retryDelay` function |
| **Focus refetching** | Stale queries refetch when the browser tab regains focus |
| **Online refetching** | Paused fetches resume when network connectivity is restored |
| **Optimistic updates** | `onMutate` context threading to `onError`/`onSettled` for rollback |
| **Query invalidation** | Prefix-matched `invalidateQueries` with active-observer refetch |
| **Notification batching** | N state changes in one event → 1 React render via `notifyManager` |
| **`useSyncExternalStore`** | Concurrent-mode safe, tearing-free, SSR-compatible bindings |
| **Dual-axis state** | `QueryStatus` (pending/success/error) orthogonal to `FetchStatus` (fetching/paused/idle) |

---

## Getting Started

**Prerequisites:** Node.js 18+

```bash
# Install dependencies
npm install

# Start the interactive demo
npm run dev

# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Type-check without emitting
npm run typecheck

# Build for production
npm run build
```

---

## Project Structure

```
src/
├── core/
│   ├── types.ts              Layer 1 — All TypeScript interfaces and type aliases
│   ├── utils.ts              Layer 1 — hashQueryKey, matchesQueryKey, helpers
│   ├── subscribable.ts       Layer 1 — Observer-pattern base class
│   ├── notifyManager.ts      Layer 1 — Batched notification scheduler
│   ├── removable.ts          Layer 1 — Garbage-collection base class
│   ├── retryer.ts            Layer 2 — Retry engine with backoff and cancellation
│   ├── focusManager.ts       Layer 2 — Browser tab visibility detection
│   ├── onlineManager.ts      Layer 2 — Network connectivity detection
│   ├── query.ts              Layer 3 — Query state machine
│   ├── mutation.ts           Layer 3 — Mutation state machine
│   ├── queryCache.ts         Layer 4 — Map<hash, Query> with typed event emission
│   ├── mutationCache.ts      Layer 4 — Map<id, Mutation> with typed event emission
│   ├── queryObserver.ts      Layer 5 — Query → React component bridge
│   ├── mutationObserver.ts   Layer 5 — Mutation → React component bridge
│   ├── queryClient.ts        Layer 6 — Public API façade
│   └── index.ts              Re-exports
├── react/
│   ├── QueryClientProvider.tsx   Context provider + mount/unmount lifecycle
│   ├── useQueryClient.ts         useContext wrapper
│   ├── useQuery.ts               useSyncExternalStore + QueryObserver
│   ├── useMutation.ts            useSyncExternalStore + MutationObserver
│   └── index.ts                  Re-exports
└── demo/                         Interactive demo app (Vite + React)
tests/
├── utils.test.ts
├── subscribable.test.ts
├── query.test.ts
├── queryCache.test.ts
├── mutation.test.ts
└── queryClient.test.ts
```

---

## Key Design Decisions

### Dual-axis query state

`QueryStatus` and `FetchStatus` are independent axes. A query can be `status='success'` and `fetchStatus='fetching'` simultaneously — this is a background refetch. The component renders cached data immediately while the silent update runs.

```
QueryStatus:   pending | success | error    — do we have data?
FetchStatus:   fetching | paused | idle     — is a request in flight?
```

### Request deduplication

`Query.fetch()` checks whether a `Retryer` is already running. If so, it returns the existing `Retryer.promise` rather than creating a new one. 50 components mounting with the same query key produce exactly 1 network request.

### Notification batching

`notifyManager` queues all observer callbacks triggered by a single event and flushes them in one `setTimeout(0)`. The React adapter replaces the flush function with React's own batching primitive, collapsing every queued state update into a single render pass.

### Observer-driven GC

`Removable` schedules garbage collection only when the last observer unsubscribes. If any component re-mounts within the `gcTime` window, the pending timeout is cancelled and data is served from memory. This is what makes navigation feel instant.

### `useSyncExternalStore` over `useState` + `useEffect`

React 18's `useSyncExternalStore` is tearing-safe (no stale reads between render and commit), SSR-compatible via a separate `getServerSnapshot`, and avoids the stale-closure bugs common in manually wired `useEffect` subscriptions.

---

## Data Flow

A complete trace of a single `useQuery(['users'])` call:

```
1.  Component renders → useQuery(['users']) called
2.  QueryObserver created → subscribes to QueryCache
3.  useSyncExternalStore calls getOptimisticResult()
4.  Observer checks: is data stale? should fetch on mount?
5.  Yes → observer calls query.fetch()
6.  query.fetch() checks: is a Retryer already running?
    → No: creates Retryer, dispatches { type: 'fetch' }
    → Yes: returns existing Retryer.promise (deduplication)
7.  Retryer calls queryFn({ queryKey, signal })
8.  queryFn resolves → Retryer calls onSuccess(data)
9.  Query dispatches { type: 'success' }
10. Reducer computes new state: status='success', fetchStatus='idle'
11. Query notifies all observers via onQueryUpdate()
12. notifyManager batches and schedules the notifications
13. useSyncExternalStore re-reads snapshot → new result object
14. React re-renders with the new data
```

---

## Documentation

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — detailed per-file walkthrough of every layer
- [`DEEP_DIVE.md`](./DEEP_DIVE.md) — deep dive into internals and non-obvious decisions
- [`PLAN.md`](./PLAN.md) — original implementation plan and task breakdown
- [`TANSTACK_QUERY_REFERENCE.md`](./TANSTACK_QUERY_REFERENCE.md) — API reference and behaviour notes

---

## Tech Stack

| Tool | Version | Purpose |
|---|---|---|
| TypeScript | 5.6 | Strict types, native `#` private fields |
| React | 18.3 | `useSyncExternalStore`, concurrent mode |
| Vite | 6.0 | Dev server and production bundler |
| Vitest | 2.1 | Unit testing with jsdom environment |
| ESLint + Prettier | 9 / 3 | Linting and formatting |
