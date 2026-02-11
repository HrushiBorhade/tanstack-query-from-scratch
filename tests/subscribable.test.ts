import { describe, it, expect, vi } from 'vitest'
import { Subscribable } from '../src/core/subscribable'

describe('Subscribable', () => {
  it('subscribe returns an unsubscribe function', () => {
    const sub = new Subscribable()
    const listener = vi.fn()
    const unsub = sub.subscribe(listener)
    expect(typeof unsub).toBe('function')
  })

  it('listeners are called when notified', () => {
    // Subscribable itself does not have a public notify, so we test
    // via a subclass that exposes it.
    class TestSubscribable extends Subscribable<() => void> {
      notify(): void {
        this.listeners.forEach((fn) => fn())
      }
    }

    const sub = new TestSubscribable()
    const listener = vi.fn()
    sub.subscribe(listener)
    sub.notify()

    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('unsubscribe removes the listener', () => {
    class TestSubscribable extends Subscribable<() => void> {
      notify(): void {
        this.listeners.forEach((fn) => fn())
      }
    }

    const sub = new TestSubscribable()
    const listener = vi.fn()
    const unsub = sub.subscribe(listener)

    sub.notify()
    expect(listener).toHaveBeenCalledTimes(1)

    unsub()
    sub.notify()
    // Still 1 -- was not called a second time after unsubscribe
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('hasListeners returns correct boolean', () => {
    const sub = new Subscribable()
    expect(sub.hasListeners()).toBe(false)

    const unsub = sub.subscribe(() => {})
    expect(sub.hasListeners()).toBe(true)

    unsub()
    expect(sub.hasListeners()).toBe(false)
  })

  it('supports multiple subscribers', () => {
    class TestSubscribable extends Subscribable<() => void> {
      notify(): void {
        this.listeners.forEach((fn) => fn())
      }
    }

    const sub = new TestSubscribable()
    const listener1 = vi.fn()
    const listener2 = vi.fn()
    const listener3 = vi.fn()

    sub.subscribe(listener1)
    sub.subscribe(listener2)
    sub.subscribe(listener3)

    sub.notify()

    expect(listener1).toHaveBeenCalledTimes(1)
    expect(listener2).toHaveBeenCalledTimes(1)
    expect(listener3).toHaveBeenCalledTimes(1)
  })

  it('deduplicates the same function subscribed twice (Set behavior)', () => {
    class TestSubscribable extends Subscribable<() => void> {
      notify(): void {
        this.listeners.forEach((fn) => fn())
      }
    }

    const sub = new TestSubscribable()
    const listener = vi.fn()

    sub.subscribe(listener)
    sub.subscribe(listener) // Same reference, Set dedup

    sub.notify()
    // The listener is stored in a Set, so it should only be called once
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('onSubscribe and onUnsubscribe hooks are called', () => {
    const onSubscribeSpy = vi.fn()
    const onUnsubscribeSpy = vi.fn()

    class HookedSubscribable extends Subscribable<() => void> {
      protected onSubscribe(): void {
        onSubscribeSpy()
      }
      protected onUnsubscribe(): void {
        onUnsubscribeSpy()
      }
    }

    const sub = new HookedSubscribable()
    const unsub = sub.subscribe(() => {})

    expect(onSubscribeSpy).toHaveBeenCalledTimes(1)
    expect(onUnsubscribeSpy).not.toHaveBeenCalled()

    unsub()
    expect(onUnsubscribeSpy).toHaveBeenCalledTimes(1)
  })

  it('unsubscribing one listener does not affect others', () => {
    class TestSubscribable extends Subscribable<() => void> {
      notify(): void {
        this.listeners.forEach((fn) => fn())
      }
    }

    const sub = new TestSubscribable()
    const listener1 = vi.fn()
    const listener2 = vi.fn()

    const unsub1 = sub.subscribe(listener1)
    sub.subscribe(listener2)

    unsub1()

    sub.notify()
    expect(listener1).not.toHaveBeenCalled()
    expect(listener2).toHaveBeenCalledTimes(1)
  })
})
