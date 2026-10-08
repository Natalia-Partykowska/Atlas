/**
 * The globe's auto-rotation: how fast it turns, and what holds it still.
 *
 * Map.tsx owns the animation loop and also stops the spin itself while a mode
 * (Compare, Measure, Antipodes) or a selection is active; everything else that
 * holds it lives here, so the interactions between them are tested.
 */

/** Spin speed at and below the default globe zoom, in degrees of longitude per second. */
export const AUTO_ROTATION_DEG_PER_S = 4

/** The default globe zoom. Above it the spin slows so its on-screen speed stays the same. */
export const ROTATION_REFERENCE_ZOOM = 2.5

/** How long the spin waits after a drag or a satellite hover ends. */
export const ROTATION_RESUME_MS = 5_000

/**
 * Degrees per second at `zoom`. Pixels per degree double with each zoom level,
 * so halving the speed per level keeps the on-screen speed of zoom 2.5
 * (~32 px/s at the view centre) at every zoom, instead of ~515 px/s at 6.5.
 */
export function autoRotationSpeed(zoom: number): number {
  return AUTO_ROTATION_DEG_PER_S * 2 ** Math.min(0, ROTATION_REFERENCE_ZOOM - zoom)
}

export interface RotationHolds {
  /** Pointer pressed (mouse or touch): held until the release. */
  press: () => void
  /** Pointer released: resumes after ROTATION_RESUME_MS, unless `resume` is false (an interactive mode is on). */
  release: (resume: boolean) => void
  /**
   * A satellite hover showed (true) or ended (false). Held while it shows, so
   * the dot stays under the pointer; when it ends, resumes after
   * ROTATION_RESUME_MS — unless the pointer is pressed, when the release does.
   */
  hover: (showing: boolean) => void
  /** Hold for `ms`, then resume (e.g. while the camera eases into the globe). */
  pauseFor: (ms: number) => void
  isSpinning: () => boolean
  dispose: () => void
}

export function createRotationHolds(): RotationHolds {
  // `paused` is the press / timed hold, which a timer releases; the hover hold
  // is separate, so no timer can restart the spin under a hover.
  let paused = false
  let pressed = false
  let hovering = false
  let resumeTimer: ReturnType<typeof setTimeout> | null = null

  const cancelResume = () => {
    if (resumeTimer !== null) {
      clearTimeout(resumeTimer)
      resumeTimer = null
    }
  }

  const pauseThenResume = (ms: number) => {
    paused = true
    cancelResume()
    resumeTimer = setTimeout(() => {
      resumeTimer = null
      paused = false
    }, ms)
  }

  return {
    press() {
      pressed = true
      paused = true
      cancelResume()
    },
    release(resume) {
      pressed = false
      if (resume) pauseThenResume(ROTATION_RESUME_MS)
    },
    hover(showing) {
      if (showing === hovering) return
      hovering = showing
      if (!showing && !pressed) pauseThenResume(ROTATION_RESUME_MS)
    },
    pauseFor(ms) {
      pauseThenResume(ms)
    },
    isSpinning: () => !paused && !hovering,
    dispose: cancelResume,
  }
}
