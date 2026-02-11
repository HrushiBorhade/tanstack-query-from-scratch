import { useState } from 'react'
import { useQuery } from '@react/useQuery'
import { api } from '../api'

export function RetryDemo() {
  const [key, setKey] = useState(0)

  const { data, isLoading, isError, error, isFetching, failureCount } = useQuery<string>({
    queryKey: ['unreliable', key],
    queryFn: () => api.unreliableFetch(),
    retry: 3,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 10000),
    staleTime: 'static',
  })

  return (
    <section>
      <h2>6. Retry + Exponential Backoff</h2>
      <p style={{fontSize:'0.85rem',color:'#555'}}>First attempt always fails. Retries with 1s&#8594;2s&#8594;4s backoff.</p>
      {isLoading && <p>Attempt {failureCount + 1}… (failures so far: {failureCount})</p>}
      {isFetching && !isLoading && <p>Retrying… (failures so far: {failureCount})</p>}
      {isError && <p style={{color:'red'}}>Failed after retries: {String(error)}</p>}
      {data && <p style={{color:'green'}}>&#10003; {data}</p>}
      <button onClick={() => setKey((k) => k + 1)}>Reset &amp; retry</button>
    </section>
  )
}
