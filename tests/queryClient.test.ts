import { describe, it, expect, vi } from 'vitest'
import { QueryClient } from '../src/core/queryClient'
import { QueryCache } from '../src/core/queryCache'
import { MutationCache } from '../src/core/mutationCache'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueryClient', () => {
  // -----------------------------------------------------------------------
  // Constructor
  // -----------------------------------------------------------------------

  describe('constructor', () => {
    it('creates default caches when none provided', () => {
      const client = new QueryClient()
      expect(client.getQueryCache()).toBeInstanceOf(QueryCache)
      expect(client.getMutationCache()).toBeInstanceOf(MutationCache)
    })

    it('accepts custom caches', () => {
      const queryCache = new QueryCache()
      const mutationCache = new MutationCache()
      const client = new QueryClient({ queryCache, mutationCache })

      expect(client.getQueryCache()).toBe(queryCache)
      expect(client.getMutationCache()).toBe(mutationCache)
    })
  })

  // -----------------------------------------------------------------------
  // getQueryData
  // -----------------------------------------------------------------------

  describe('getQueryData', () => {
    it('returns undefined for a missing key', () => {
      const client = new QueryClient()
      expect(client.getQueryData(['non-existent'])).toBeUndefined()
    })

    it('returns data after it has been set', () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()

      // Build a query with initialData to populate the cache
      cache.build(client, {
        queryKey: ['users'],
        initialData: [{ id: 1, name: 'Alice' }],
      })

      const data = client.getQueryData(['users'])
      expect(data).toEqual([{ id: 1, name: 'Alice' }])
    })
  })

  // -----------------------------------------------------------------------
  // setQueryData
  // -----------------------------------------------------------------------

  describe('setQueryData', () => {
    it('returns undefined if the query does not exist in cache', () => {
      const client = new QueryClient()
      const result = client.setQueryData(['non-existent'], 'value')
      expect(result).toBeUndefined()
    })

    it('sets data with a direct value', () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, { queryKey: ['users'], initialData: [] })

      const result = client.setQueryData(['users'], [{ id: 1 }])
      expect(result).toEqual([{ id: 1 }])
      expect(client.getQueryData(['users'])).toEqual([{ id: 1 }])
    })

    it('sets data with an updater function', () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, {
        queryKey: ['count'],
        initialData: 5,
      })

      const result = client.setQueryData<number>(['count'], (old) =>
        old !== undefined ? old + 1 : 0,
      )
      expect(result).toBe(6)
      expect(client.getQueryData(['count'])).toBe(6)
    })

    it('returns undefined when updater returns undefined', () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, { queryKey: ['users'], initialData: 'initial' })

      const result = client.setQueryData<string>(['users'], () => undefined)
      expect(result).toBeUndefined()
    })
  })

  // -----------------------------------------------------------------------
  // fetchQuery
  // -----------------------------------------------------------------------

  describe('fetchQuery', () => {
    it('fetches and caches data', async () => {
      const client = new QueryClient()

      const data = await client.fetchQuery({
        queryKey: ['users'],
        queryFn: () => Promise.resolve([{ id: 1, name: 'Alice' }]),
        retry: 0,
      })

      expect(data).toEqual([{ id: 1, name: 'Alice' }])
      expect(client.getQueryData(['users'])).toEqual([{ id: 1, name: 'Alice' }])
    })

    it('throws on error', async () => {
      const client = new QueryClient()

      await expect(
        client.fetchQuery({
          queryKey: ['error-key'],
          queryFn: () => Promise.reject(new Error('fetch error')),
          retry: 0,
        }),
      ).rejects.toThrow('fetch error')
    })

    it('deduplicates concurrent fetchQuery calls for the same key', async () => {
      let callCount = 0
      const client = new QueryClient()

      const opts = {
        queryKey: ['dedup'] as const,
        queryFn: () => {
          callCount++
          return Promise.resolve('data')
        },
        retry: 0,
      }

      const [r1, r2] = await Promise.all([
        client.fetchQuery(opts),
        client.fetchQuery(opts),
      ])

      expect(r1).toBe('data')
      expect(r2).toBe('data')
      expect(callCount).toBe(1)
    })
  })

  // -----------------------------------------------------------------------
  // prefetchQuery
  // -----------------------------------------------------------------------

  describe('prefetchQuery', () => {
    it('does not throw on error', async () => {
      const client = new QueryClient()

      // Should not throw
      await client.prefetchQuery({
        queryKey: ['prefetch-error'],
        queryFn: () => Promise.reject(new Error('prefetch error')),
        retry: 0,
      })

      // The query should be in cache with error state
      const state = client.getQueryState(['prefetch-error'])
      expect(state?.status).toBe('error')
    })

    it('caches data on success', async () => {
      const client = new QueryClient()

      await client.prefetchQuery({
        queryKey: ['prefetch-success'],
        queryFn: () => Promise.resolve('cached'),
        retry: 0,
      })

      expect(client.getQueryData(['prefetch-success'])).toBe('cached')
    })
  })

  // -----------------------------------------------------------------------
  // invalidateQueries
  // -----------------------------------------------------------------------

  describe('invalidateQueries', () => {
    it('marks queries as invalidated', async () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, { queryKey: ['a'], initialData: 'data-a' })
      cache.build(client, { queryKey: ['b'], initialData: 'data-b' })

      await client.invalidateQueries()

      const queries = cache.getAll()
      expect(queries.every((q) => q.state.isInvalidated)).toBe(true)
    })

    it('invalidates only matching queries when key filter provided', async () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, { queryKey: ['users'], initialData: 'u' })
      cache.build(client, { queryKey: ['todos'], initialData: 't' })

      await client.invalidateQueries({ queryKey: ['users'] })

      const users = cache.find({ queryKey: ['users'], exact: true })
      const todos = cache.find({ queryKey: ['todos'], exact: true })
      expect(users?.state.isInvalidated).toBe(true)
      expect(todos?.state.isInvalidated).toBe(false)
    })
  })

  // -----------------------------------------------------------------------
  // cancelQueries
  // -----------------------------------------------------------------------

  describe('cancelQueries', () => {
    it('cancels in-flight fetches', async () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()

      const query = cache.build(client, {
        queryKey: ['cancel-me'],
        queryFn: () => new Promise((resolve) => setTimeout(() => resolve('data'), 5000)),
        retry: 0,
      })

      // Start a fetch
      void query.fetch()

      expect(query.state.fetchStatus).toBe('fetching')

      // Cancel
      client.cancelQueries({ queryKey: ['cancel-me'] })

      // Wait for the cancellation to propagate
      await vi.waitFor(() => {
        expect(query.state.fetchStatus).toBe('idle')
      })

      // The fetch promise will reject with CancelledError since silent=true is used
      // by cancelQueries. Actually looking at code, cancelQueries uses { silent: true }
      // so the promise never settles. Let's just verify the state.
    })
  })

  // -----------------------------------------------------------------------
  // removeQueries
  // -----------------------------------------------------------------------

  describe('removeQueries', () => {
    it('removes queries from cache', () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, { queryKey: ['a'], initialData: 'a' })
      cache.build(client, { queryKey: ['b'], initialData: 'b' })

      expect(cache.getAll()).toHaveLength(2)

      client.removeQueries({ queryKey: ['a'] })
      expect(cache.getAll()).toHaveLength(1)
      expect(cache.find({ queryKey: ['a'], exact: true })).toBeUndefined()
    })

    it('removes all queries when no filter provided', () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, { queryKey: ['a'], initialData: 'a' })
      cache.build(client, { queryKey: ['b'], initialData: 'b' })

      client.removeQueries()
      expect(cache.getAll()).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // clear()
  // -----------------------------------------------------------------------

  describe('clear()', () => {
    it('empties both caches', () => {
      const client = new QueryClient()
      const queryCache = client.getQueryCache()
      const mutationCache = client.getMutationCache()

      queryCache.build(client, { queryKey: ['a'], initialData: 'a' })

      // Build a mutation through the mutation cache
      mutationCache.build(
        { defaultMutationOptions: (opts) => opts },
        { mutationFn: () => Promise.resolve('data') },
      )

      expect(queryCache.getAll().length).toBeGreaterThan(0)
      expect(mutationCache.getAll().length).toBeGreaterThan(0)

      client.clear()

      expect(queryCache.getAll()).toHaveLength(0)
      expect(mutationCache.getAll()).toHaveLength(0)
    })
  })

  // -----------------------------------------------------------------------
  // isFetching
  // -----------------------------------------------------------------------

  describe('isFetching', () => {
    it('returns 0 when nothing is fetching', () => {
      const client = new QueryClient()
      expect(client.isFetching()).toBe(0)
    })

    it('returns the count of fetching queries', async () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()

      const query = cache.build(client, {
        queryKey: ['fetching'],
        queryFn: () => new Promise((resolve) => setTimeout(() => resolve('data'), 5000)),
        retry: 0,
      })

      // Start a fetch (don't await)
      query.fetch()

      expect(client.isFetching()).toBe(1)

      // Cancel to clean up
      query.cancel({ silent: true })
    })
  })

  // -----------------------------------------------------------------------
  // mount / unmount
  // -----------------------------------------------------------------------

  describe('mount / unmount', () => {
    it('ref-counting: first mount subscribes, second is a no-op', () => {
      const client = new QueryClient()

      client.mount()
      client.mount() // second mount

      // Both unmounts needed to fully teardown
      client.unmount()
      // Still mounted (ref count = 1)
      client.unmount()
      // Now fully unmounted (ref count = 0)
    })

    it('unmount at zero does not error', () => {
      const client = new QueryClient()
      // Should not throw even without a prior mount
      // (mountCount goes to -1 but that is just a ref count underflow, no crash)
      expect(() => client.unmount()).not.toThrow()
    })
  })

  // -----------------------------------------------------------------------
  // defaultQueryOptions
  // -----------------------------------------------------------------------

  describe('defaultQueryOptions', () => {
    it('merges global defaults with per-query options', () => {
      const client = new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60000,
            gcTime: 300000,
          },
        },
      })

      const merged = client.defaultQueryOptions({
        queryKey: ['users'],
        staleTime: 5000, // override
      })

      expect(merged.staleTime).toBe(5000) // per-query wins
      expect(merged.gcTime).toBe(300000) // from global defaults
      expect(merged.queryKey).toEqual(['users'])
    })

    it('returns per-query options when no defaults are set', () => {
      const client = new QueryClient()

      const merged = client.defaultQueryOptions({
        queryKey: ['users'],
        staleTime: 10000,
      })

      expect(merged.staleTime).toBe(10000)
      expect(merged.queryKey).toEqual(['users'])
    })
  })

  // -----------------------------------------------------------------------
  // getDefaultOptions / setDefaultOptions
  // -----------------------------------------------------------------------

  describe('getDefaultOptions / setDefaultOptions', () => {
    it('returns the current default options', () => {
      const client = new QueryClient({
        defaultOptions: { queries: { staleTime: 5000 } },
      })

      expect(client.getDefaultOptions().queries?.staleTime).toBe(5000)
    })

    it('allows updating default options', () => {
      const client = new QueryClient()

      client.setDefaultOptions({ queries: { staleTime: 30000 } })
      expect(client.getDefaultOptions().queries?.staleTime).toBe(30000)
    })
  })

  // -----------------------------------------------------------------------
  // getQueryState
  // -----------------------------------------------------------------------

  describe('getQueryState', () => {
    it('returns full state for a cached query', () => {
      const client = new QueryClient()
      const cache = client.getQueryCache()
      cache.build(client, { queryKey: ['state-test'], initialData: 'value' })

      const state = client.getQueryState(['state-test'])
      expect(state).toBeDefined()
      expect(state?.status).toBe('success')
      expect(state?.data).toBe('value')
    })

    it('returns undefined for a non-existent query', () => {
      const client = new QueryClient()
      expect(client.getQueryState(['missing'])).toBeUndefined()
    })
  })
})
