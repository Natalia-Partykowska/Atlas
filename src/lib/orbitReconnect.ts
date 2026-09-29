// Timing rules for reconnecting to the orbit server (atlas-orbit).
//
// There is no cap on attempts: retrying keeps going for as long as the
// satellite view is open. A server restart refuses connections for tens of
// seconds (it binds its port only after downloading the CelesTrak catalog),
// and a real outage can last hours, so any fixed count would give up before
// the server is back. An attempt costs one WebSocket handshake, and the
// bundled satellites keep the globe moving meanwhile.

/** First retry delay; each failed attempt doubles it. */
export const RETRY_BASE_MS = 1_000
/** Delays stop doubling here: one attempt a minute during a long outage. */
export const RETRY_MAX_MS = 60_000
/** Each delay moves by up to ±20 %, so tabs that lost the server together
 *  (a redeploy) don't all reconnect at the same instant. Kept small so the
 *  countdown shown to the user stays close to the schedule. */
export const RETRY_JITTER = 0.2

/** An attempt that hasn't delivered a position batch by now has failed, even
 *  if its socket is still open or connecting. */
export const FIRST_BATCH_DEADLINE_MS = 8_000
/** After a live stream drops, the last frame stays on screen this long while
 *  it reconnects, so a brief blip never shows the limited view. */
export const DROP_GRACE_MS = 3_000
/** Retry pace during that grace. The backoff starts only after it: with the
 *  1 s → 2 s steps, the third attempt lands right as a 3 s grace ends, so a
 *  1–3 s blip used to flash the limited view. */
export const GRACE_RETRY_MS = 500

/**
 * Delay before retry number `attempt` (0-based): 1, 2, 4, 8, 16, 32 s, then
 * 60 s from there on, each ±20 %. `random` is a value in [0, 1), passed in so
 * tests are deterministic.
 */
export function retryDelayMs(attempt: number, random: number = Math.random()): number {
  // NaN and negatives count as the first attempt; +Infinity lands on the cap.
  const n = attempt > 0 ? Math.floor(attempt) : 0
  return withJitter(Math.min(RETRY_BASE_MS * 2 ** n, RETRY_MAX_MS), random)
}

/** `ms` moved by up to ±20 %; `random` is a value in [0, 1). */
export function withJitter(ms: number, random: number): number {
  const r = Number.isFinite(random) ? Math.min(Math.max(random, 0), 1) : 0.5
  return Math.floor(ms * (1 + RETRY_JITTER * (2 * r - 1)))
}
