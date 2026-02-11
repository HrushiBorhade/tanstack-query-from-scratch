import { useSyncExternalStore, useMemo, useEffect } from 'react'
import { QueryObserver } from '@core/index'
import type { QueryOptions, QueryObserverResult, QueryKey } from '@core/index'
import { useQueryClient } from './useQueryClient'

export function useQuery<
  TData = unknown,
  TError = Error,
  TQueryKey extends QueryKey = QueryKey,
>(
  options: QueryOptions<TData, TError, TQueryKey>,
): QueryObserverResult<TData, TError> {
  const client = useQueryClient()

  // Create observer once per mount. useMemo is stable across re-renders
  // as long as the queryKey hash stays the same — but we handle key changes
  // inside observer.setOptions().
  const observer = useMemo(
    () =>
      new QueryObserver<TData, TError>(
        client,
        options as unknown as QueryOptions<TData, TError>,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  )

  // Sync options (including queryKey changes) into the observer on every render.
  // This must happen before useSyncExternalStore reads the snapshot so the
  // observer is already bound to the right Query before React gets the result.
  // Use getOptimisticResult() to avoid flicker on first render.
  const result = useSyncExternalStore(
    (onStoreChange) => observer.subscribe(onStoreChange),
    () =>
      observer.getOptimisticResult(
        options as unknown as QueryOptions<TData, TError>,
      ),
    () =>
      observer.getOptimisticResult(
        options as unknown as QueryOptions<TData, TError>,
      ),
  )

  // Keep observer options in sync with the latest render options
  useEffect(() => {
    observer.setOptions(options as unknown as QueryOptions<TData, TError>)
  })

  return result
}
