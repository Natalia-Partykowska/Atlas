// Conjunction event → spoken callout for the Conjunctions drawer:
//   "Close approach in twelve minutes. Starlink three zero eight seven.
//    Fengyun one C debris. Four hundred metres apart."
// Pure and shared with the local generator (`scripts/generate-satellite-voice.mjs`),
// which loads it with Node's type stripping — hence the explicit `.ts` import
// and types imported with `import type` only.
//
// Every line is its own sentence. The pack records the time and distance lines
// whole, so their numbers keep natural intonation, and splices in the Session
// 13 name clips — recorded as finished sentences, so each join falls on a
// sentence boundary and none sounds choppy.

import { DIGIT_WORDS, numberWords, planUtterance, spokenText } from './satelliteVoiceName.ts'
import type { VoiceManifest } from './satelliteVoiceName.ts'

/** Latest closest approach the pack voices — the server screens 2 h ahead. */
export const PACK_MAX_MINUTES = 120
/** Widest miss the pack voices — the server's `THRESHOLD_KM` (server/src/conjunctions.rs). */
export const PACK_MAX_METRES = 5000

export interface ConjunctionPhrase {
  /** Key in the manifest's `phrases` section: `time:12`, `dist:400` */
  key: string
  /** What the voice says: "Close approach in twelve minutes" */
  spoken: string
}

export interface ConjunctionSpeech {
  /** Raw catalog names, as `planUtterance` and `spokenText` take them */
  nameA: string
  nameB: string
  /** Time left until closest approach, at the moment of speaking */
  msToTca: number
  missKm: number
}

/** Clip files for the callout, in speaking order. */
export interface ConjunctionPlan {
  time: string
  nameA: string[]
  nameB: string[]
  distance: string
}

/**
 * "Close approach in twelve minutes". Rounded down so it agrees with the
 * drawer's T- countdown; under a minute (or just past) is "…in under a minute".
 */
export function timePhrase(msToTca: number): ConjunctionPhrase {
  const minutes = Math.max(0, Math.floor(msToTca / 60_000))
  return { key: `time:${minutes}`, spoken: `Close approach in ${durationWords(minutes)}` }
}

/** "Four hundred metres apart", to the nearest 100 m. */
export function distancePhrase(missKm: number): ConjunctionPhrase {
  const metres = Math.max(0, Math.round(missKm * 10)) * 100
  return { key: `dist:${metres}`, spoken: capitalize(`${distanceWords(metres)} apart`) }
}

/** The whole callout, for the browser-voice fallback. */
export function conjunctionSentence(s: ConjunctionSpeech): string {
  const lines = [
    timePhrase(s.msToTca).spoken,
    spokenText(s.nameA),
    spokenText(s.nameB),
    distancePhrase(s.missKm).spoken,
  ]
  return lines.map((line) => `${line}.`).join(' ')
}

/** Every phrase the pack needs: each minute up to 2 h, each 100 m up to 5 km. */
export function conjunctionPhraseClips(): ConjunctionPhrase[] {
  const clips: ConjunctionPhrase[] = []
  for (let m = 0; m <= PACK_MAX_MINUTES; m++) clips.push(timePhrase(m * 60_000))
  for (let d = 0; d <= PACK_MAX_METRES; d += 100) clips.push(distancePhrase(d / 1000))
  return clips
}

/**
 * Clips to play for the callout, or `null` when the pack can't voice all of
 * it — the caller then has the browser read the whole callout rather than
 * switching voices halfway through.
 */
export function planConjunctionUtterance(
  s: ConjunctionSpeech,
  manifest: VoiceManifest,
): ConjunctionPlan | null {
  const time = manifest.phrases?.[timePhrase(s.msToTca).key]
  const distance = manifest.phrases?.[distancePhrase(s.missKm).key]
  const nameA = planUtterance(s.nameA, manifest)
  const nameB = planUtterance(s.nameB, manifest)
  if (!time || !distance || !nameA || !nameB) return null
  return { time, nameA, nameB, distance }
}

// 0 → "under a minute"; 75 → "one hour and fifteen minutes"
function durationWords(minutes: number): string {
  if (minutes === 0) return 'under a minute'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  const parts: string[] = []
  if (hours > 0) parts.push(counted(hours, 'hour'))
  if (rest > 0) parts.push(counted(rest, 'minute'))
  return parts.join(' and ')
}

// 0 → "less than a hundred metres"; 400 → "four hundred metres";
// 1000 → "one kilometre"; 2400 → "two point four kilometres"
function distanceWords(metres: number): string {
  if (metres === 0) return 'less than a hundred metres'
  if (metres < 1000) return `${DIGIT_WORDS[metres / 100]} hundred metres`
  const km = Math.floor(metres / 1000)
  const tenths = (metres % 1000) / 100
  if (tenths === 0) return counted(km, 'kilometre')
  return `${numberWords(String(km))} point ${DIGIT_WORDS[tenths]} kilometres`
}

function counted(n: number, unit: string): string {
  return `${numberWords(String(n))} ${unit}${n === 1 ? '' : 's'}`
}

function capitalize(line: string): string {
  return line[0].toUpperCase() + line.slice(1)
}
