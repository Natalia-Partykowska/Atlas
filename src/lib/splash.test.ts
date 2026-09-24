import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dismissSplash, SPLASH_REMOVE_FALLBACK_MS } from './splash'

// happy-dom has no TransitionEvent constructor — fake one on a plain Event.
function transitionEnd(target: Element, propertyName: string) {
  const e = new Event('transitionend', { bubbles: true })
  Object.defineProperty(e, 'propertyName', { value: propertyName })
  target.dispatchEvent(e)
}

describe('dismissSplash', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="splash"><div class="splash-logo"></div></div><div id="root"></div>'
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  const splash = () => document.getElementById('splash')

  it('marks the splash as out so the CSS exit transition runs', () => {
    dismissSplash()
    expect(splash()?.dataset.state).toBe('out')
  })

  it('is a no-op when there is no splash', () => {
    document.body.innerHTML = '<div id="root"></div>'
    expect(() => dismissSplash()).not.toThrow()
  })

  it('is idempotent — a second call does not re-arm removal', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setTimeout')
    dismissSplash()
    dismissSplash()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('removes the splash when its own opacity transition ends', () => {
    dismissSplash()
    transitionEnd(splash()!, 'opacity')
    expect(splash()).toBeNull()
    expect(document.getElementById('root')).not.toBeNull()
  })

  it("ignores the logo's bubbled transitionend and non-opacity properties", () => {
    dismissSplash()
    const el = splash()!
    transitionEnd(el.querySelector('.splash-logo')!, 'opacity')
    transitionEnd(el, 'transform')
    expect(splash()).not.toBeNull()
  })

  it('removes the splash via the fallback timer if transitionend never fires', () => {
    vi.useFakeTimers()
    dismissSplash()
    vi.advanceTimersByTime(SPLASH_REMOVE_FALLBACK_MS - 1)
    expect(splash()).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(splash()).toBeNull()
  })
})
