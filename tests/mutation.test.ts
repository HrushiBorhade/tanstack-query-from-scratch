import { describe, it, expect, vi } from 'vitest'
import { Mutation } from '../src/core/mutation'
import type { MutationCacheInterface, MutationObserverInterface } from '../src/core/mutation'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a Mutation with sensible defaults for testing.
 */
function createMutation<TData = string, TError = Error, TVariables = string, TContext = unknown>(
  opts?: {
    mutationFn?: (variables: TVariables) => Promise<TData>
    onMutate?: (variables: TVariables) => TContext | Promise<TContext | undefined> | undefined
    onSuccess?: (data: TData, variables: TVariables, context: TContext | undefined) => void
    onError?: (error: TError, variables: TVariables, context: TContext | undefined) => void
    onSettled?: (
      data: TData | undefined,
      error: TError | null,
      variables: TVariables,
      context: TContext | undefined,
    ) => void
    retry?: number
    gcTime?: number
    cacheConfig?: MutationCacheInterface['config']
  },
): {
  mutation: Mutation<TData, TError, TVariables, TContext>
  cache: MutationCacheInterface
} {
  const cache: MutationCacheInterface = {
    config: opts?.cacheConfig ?? {},
    notify: vi.fn(),
    remove: vi.fn(),
  }

  const mutation = new Mutation<TData, TError, TVariables, TContext>({
    mutationCache: cache,
    options: {
      mutationFn: opts?.mutationFn,
      onMutate: opts?.onMutate,
      onSuccess: opts?.onSuccess,
      onError: opts?.onError,
      onSettled: opts?.onSettled,
      retry: opts?.retry ?? 0,
      gcTime: opts?.gcTime,
    },
  })

  return { mutation, cache }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Mutation', () => {
  // -----------------------------------------------------------------------
  // Initial state
  // -----------------------------------------------------------------------

  describe('initial state', () => {
    it('starts with status="idle"', () => {
      const { mutation } = createMutation()
      expect(mutation.state.status).toBe('idle')
      expect(mutation.state.data).toBeUndefined()
      expect(mutation.state.error).toBeNull()
      expect(mutation.state.variables).toBeUndefined()
      expect(mutation.state.context).toBeUndefined()
      expect(mutation.state.failureCount).toBe(0)
      expect(mutation.state.isPaused).toBe(false)
      expect(mutation.state.submittedAt).toBe(0)
    })
  })

  // -----------------------------------------------------------------------
  // Execute transitions: success
  // -----------------------------------------------------------------------

  describe('execute (success)', () => {
    it('transitions: idle -> pending -> success', async () => {
      const { mutation } = createMutation<string, Error, string>({
        mutationFn: (vars) => Promise.resolve(`result-${vars}`),
      })

      expect(mutation.state.status).toBe('idle')

      const data = await mutation.execute('input')

      expect(data).toBe('result-input')
      expect(mutation.state.status).toBe('success')
      expect(mutation.state.data).toBe('result-input')
      expect(mutation.state.variables).toBe('input')
      expect(mutation.state.error).toBeNull()
      expect(mutation.state.submittedAt).toBeGreaterThan(0)
    })
  })

  // -----------------------------------------------------------------------
  // Execute transitions: error
  // -----------------------------------------------------------------------

  describe('execute (error)', () => {
    it('transitions: idle -> pending -> error', async () => {
      const testError = new Error('mutation failed')
      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.reject(testError),
      })

      expect(mutation.state.status).toBe('idle')

      await expect(mutation.execute('input')).rejects.toThrow('mutation failed')

      expect(mutation.state.status).toBe('error')
      expect(mutation.state.error).toBe(testError)
      expect(mutation.state.variables).toBe('input')
    })
  })

  // -----------------------------------------------------------------------
  // Lifecycle hooks
  // -----------------------------------------------------------------------

  describe('lifecycle hooks', () => {
    it('calls onMutate, onSuccess, onSettled in order on success', async () => {
      const callOrder: string[] = []

      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.resolve('result'),
        onMutate: () => {
          callOrder.push('onMutate')
          return undefined
        },
        onSuccess: () => {
          callOrder.push('onSuccess')
        },
        onSettled: () => {
          callOrder.push('onSettled')
        },
      })

      await mutation.execute('input')

      expect(callOrder).toEqual(['onMutate', 'onSuccess', 'onSettled'])
    })

    it('calls onMutate, onError, onSettled in order on error', async () => {
      const callOrder: string[] = []

      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.reject(new Error('fail')),
        onMutate: () => {
          callOrder.push('onMutate')
          return undefined
        },
        onError: () => {
          callOrder.push('onError')
        },
        onSettled: () => {
          callOrder.push('onSettled')
        },
      })

      await mutation.execute('input').catch(() => {})

      expect(callOrder).toEqual(['onMutate', 'onError', 'onSettled'])
    })
  })

  // -----------------------------------------------------------------------
  // Context threading
  // -----------------------------------------------------------------------

  describe('context threading', () => {
    it('passes onMutate return value as context to onError and onSettled', async () => {
      let errorContext: unknown
      let settledContext: unknown

      const { mutation } = createMutation<string, Error, string, { rollback: string }>({
        mutationFn: () => Promise.reject(new Error('fail')),
        onMutate: () => ({ rollback: 'undo-data' }),
        onError: (_error, _vars, context) => {
          errorContext = context
        },
        onSettled: (_data, _error, _vars, context) => {
          settledContext = context
        },
      })

      await mutation.execute('input').catch(() => {})

      expect(errorContext).toEqual({ rollback: 'undo-data' })
      expect(settledContext).toEqual({ rollback: 'undo-data' })
    })

    it('passes context to onSuccess and onSettled on success', async () => {
      let successContext: unknown
      let settledContext: unknown

      const { mutation } = createMutation<string, Error, string, { optimistic: boolean }>({
        mutationFn: () => Promise.resolve('result'),
        onMutate: () => ({ optimistic: true }),
        onSuccess: (_data, _vars, context) => {
          successContext = context
        },
        onSettled: (_data, _error, _vars, context) => {
          settledContext = context
        },
      })

      await mutation.execute('input')

      expect(successContext).toEqual({ optimistic: true })
      expect(settledContext).toEqual({ optimistic: true })
    })
  })

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe('reset()', () => {
    it('returns to idle state', async () => {
      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.resolve('result'),
      })

      await mutation.execute('input')
      expect(mutation.state.status).toBe('success')

      mutation.reset()
      expect(mutation.state.status).toBe('idle')
      expect(mutation.state.data).toBeUndefined()
      expect(mutation.state.error).toBeNull()
      expect(mutation.state.variables).toBeUndefined()
      expect(mutation.state.context).toBeUndefined()
      expect(mutation.state.failureCount).toBe(0)
      expect(mutation.state.submittedAt).toBe(0)
    })

    it('resets after error state', async () => {
      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.reject(new Error('fail')),
      })

      await mutation.execute('input').catch(() => {})
      expect(mutation.state.status).toBe('error')

      mutation.reset()
      expect(mutation.state.status).toBe('idle')
      expect(mutation.state.error).toBeNull()
    })
  })

  // -----------------------------------------------------------------------
  // Observer management
  // -----------------------------------------------------------------------

  describe('observer management', () => {
    it('addObserver registers an observer', () => {
      const { mutation } = createMutation()
      const observer: MutationObserverInterface = {
        onMutationUpdate: vi.fn(),
      }

      // addObserver does not throw
      mutation.addObserver(observer)
      // We can verify by checking that the observer is called on dispatch
    })

    it('removeObserver removes an observer', () => {
      vi.useFakeTimers()
      const { mutation, cache } = createMutation({ gcTime: 100 })
      const observer: MutationObserverInterface = {
        onMutationUpdate: vi.fn(),
      }

      mutation.addObserver(observer)
      mutation.removeObserver(observer)

      // After gcTime, optionalRemove should call cache.remove
      vi.advanceTimersByTime(200)
      expect(cache.remove).toHaveBeenCalled()
    })

    it('observers are notified on state change', async () => {
      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.resolve('data'),
      })

      const observer: MutationObserverInterface<string, Error, string, unknown> = {
        onMutationUpdate: vi.fn(),
      }

      mutation.addObserver(observer)
      await mutation.execute('input')

      expect(observer.onMutationUpdate).toHaveBeenCalled()
    })
  })

  // -----------------------------------------------------------------------
  // No mutationFn
  // -----------------------------------------------------------------------

  describe('missing mutationFn', () => {
    it('throws when no mutationFn is provided', async () => {
      const { mutation } = createMutation()

      await expect(mutation.execute('input' as never)).rejects.toThrow('No mutationFn found')
    })
  })

  // -----------------------------------------------------------------------
  // Global cache hooks
  // -----------------------------------------------------------------------

  describe('global cache hooks', () => {
    it('calls cache config onSuccess after per-mutation onSuccess', async () => {
      const callOrder: string[] = []

      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.resolve('result'),
        onSuccess: () => {
          callOrder.push('per-mutation-onSuccess')
        },
        cacheConfig: {
          onSuccess: () => {
            callOrder.push('global-onSuccess')
          },
        },
      })

      await mutation.execute('input')

      expect(callOrder).toEqual(['per-mutation-onSuccess', 'global-onSuccess'])
    })

    it('calls cache config onError after per-mutation onError', async () => {
      const callOrder: string[] = []

      const { mutation } = createMutation<string, Error, string>({
        mutationFn: () => Promise.reject(new Error('fail')),
        onError: () => {
          callOrder.push('per-mutation-onError')
        },
        cacheConfig: {
          onError: () => {
            callOrder.push('global-onError')
          },
        },
      })

      await mutation.execute('input').catch(() => {})

      expect(callOrder).toEqual(['per-mutation-onError', 'global-onError'])
    })
  })
})
