import { afterEach, vi } from 'vitest'

// Reset all timers after each test
afterEach(() => {
  vi.useRealTimers()
})
