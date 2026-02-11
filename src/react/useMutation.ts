import { useMemo, useEffect } from 'react'
import { useSyncExternalStore } from 'react'
import { MutationObserver } from '@core/index'
import type { MutationOptions, MutationObserverResult } from '@core/index'
import { useQueryClient } from './useQueryClient'

export function useMutation<
  TData = unknown,
  TError = Error,
  TVariables = unknown,
  TContext = unknown,
>(
  options: MutationOptions<TData, TError, TVariables, TContext>,
): MutationObserverResult<TData, TError, TVariables, TContext> {
  const client = useQueryClient()

  const observer = useMemo(
    () => new MutationObserver<TData, TError, TVariables, TContext>(client, options),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  )

  // Keep mutation options current (e.g. onSuccess callback closure changes)
  useEffect(() => {
    observer.setOptions(options)
  })

  const result = useSyncExternalStore(
    (onStoreChange) => observer.subscribe(onStoreChange),
    () => observer.getCurrentResult(),
    () => observer.getCurrentResult(),
  )

  return result
}
