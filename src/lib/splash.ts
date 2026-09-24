// The first-load splash (centered logo with an orbiting satellite) is static
// HTML/CSS in index.html, not React: globe setup blocks the main thread in
// 0.5–1.5 s long tasks, and only a statically-painted, compositor-animated
// element keeps moving through them. Map.tsx calls this once the countries
// have painted; the CSS exit transition keyed on `data-state="out"` fades the
// splash away, then the node is removed so it can't intercept input.

const SPLASH_ID = 'splash'

// Longer than the CSS exit (150 ms delay + 700 ms fade) — backstop in case
// `transitionend` never fires (e.g. background tab, transition overridden).
export const SPLASH_REMOVE_FALLBACK_MS = 1500

export function dismissSplash(doc: Document = document): void {
  const el = doc.getElementById(SPLASH_ID)
  if (!el || el.dataset.state === 'out') return
  el.dataset.state = 'out'

  const onEnd = (e: TransitionEvent) => {
    // The logo's own fade bubbles up too — wait for the backdrop.
    if (e.target === el && e.propertyName === 'opacity') remove()
  }
  const remove = () => {
    clearTimeout(fallback)
    el.removeEventListener('transitionend', onEnd)
    el.remove()
  }
  el.addEventListener('transitionend', onEnd)
  const fallback = setTimeout(remove, SPLASH_REMOVE_FALLBACK_MS)
}
