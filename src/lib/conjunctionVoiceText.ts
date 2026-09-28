// Conjunction event → spoken sentence for the Conjunctions drawer:
//   "In twelve minutes, Starlink three zero eight seven will pass four hundred
//    metres from Fengyun one C debris."
// Pure and shared with the local generator (`scripts/generate-satellite-voice.mjs`),
// which loads it with Node's type stripping — hence the explicit `.ts` import
// and types imported with `import type` only.
//
// The pack records both phrases whole ("In twelve minutes," / "will pass four
// hundred metres from,") so their numbers keep natural intonation; only the
// names are spliced in, from the Session 13 name clips. The second name ends
// the sentence because name clips were recorded as finished sentences.

import { DIGIT_WORDS, numberWords, planUtterance, spokenText } from './satelliteVoiceName.ts'
import type { VoiceManifest } from './satelliteVoiceName.ts'

/** Latest closest approach the pack voices — the server screens 2 h ahead. */
export const PACK_MAX_MINUTES = 120
/** Widest miss the pack voices — the server's `THRESHOLD_KM` (server/src/conjunctions.rs). */
export const PACK_MAX_METRES = 5000

export interface ConjunctionPhrase {
  /** Key in the manifest's `phrases` section: `time:12`, `dist:400` */
  key: string
  /** What the voice says: "In twelve minutes" */
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

/** Clip files for the sentence, in speaking order. */
export interface ConjunctionPlan {
  time: string
  nameA: string[]
  distance: string
  nameB: string[]
}

/**
 * "In twelve minutes". Rounded down so it agrees with the drawer's T-
 * countdown; under a minute (or just past) is "In under a minute".
 */
export function timePhrase(msToTca: number): ConjunctionPhrase {
  const minutes = Math.max(0, Math.floor(msToTca / 60_000))
  return { key: `time:${minutes}`, spoken: `In ${durationWords(minutes)}` }
}

/** "will pass four hundred metres from", to the nearest 100 m. */
export function distancePhrase(missKm: number): ConjunctionPhrase {
  const metres = Math.max(0, Math.round(missKm * 10)) * 100
  return { key: `dist:${metres}`, spoken: `will pass ${distanceWords(metres)} from` }
}

/** The whole sentence, for the browser-voice fallback. */
export function conjunctionSentence(s: ConjunctionSpeech): string {
  const time = timePhrase(s.msToTca).spoken
  const distance = distancePhrase(s.missKm).spoken
  return `${time}, ${spokenText(s.nameA)} ${distance} ${spokenText(s.nameB)}.`
}

/** Every phrase the pack needs: each minute up to 2 h, each 100 m up to 5 km. */
export function conjunctionPhraseClips(): ConjunctionPhrase[] {
  const clips: ConjunctionPhrase[] = []
  for (let m = 0; m <= PACK_MAX_MINUTES; m++) clips.push(timePhrase(m * 60_000))
  for (let d = 0; d <= PACK_MAX_METRES; d += 100) clips.push(distancePhrase(d / 1000))
  return clips
}

/**
 * Clips to play for the sentence, or `null` when the pack can't voice all of
 * it — the caller then has the browser read the whole sentence rather than
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
  return { time, nameA, distance, nameB }
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
