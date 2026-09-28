import { planUtterance, spokenText } from './satelliteVoiceName'
import type { VoiceManifest } from './satelliteVoiceName'

// Plays satellite names from the pre-generated ElevenLabs pack in
// public/audio/satellite-voice/ — static files, so clicks never spend credits.
// Constellation members are spliced ("Starlink" + "three zero eight seven"),
// so each clip's padding is trimmed and the pieces are scheduled back-to-back
// on one AudioContext. Anything the pack can't voice falls back to the
// browser's own speechSynthesis.

const PACK_URL = `${import.meta.env.BASE_URL}audio/satellite-voice/`
const STORAGE_KEY = 'atlas.satelliteVoice'
/** Pause between spliced clips. */
export const CLIP_GAP_S = 0.05
// Clips carry ~25–75 ms of lead-in and ~230–260 ms of tail silence. Trim to
// the first/last sample above ~-34 dBFS, keeping a sliver either side so soft
// consonants aren't clipped.
const SILENCE_THRESHOLD = 0.02
const PAD_BEFORE_S = 0.01
const PAD_AFTER_S = 0.02

interface TrimmedClip {
  buffer: AudioBuffer
  offset: number
  duration: number
}

let manifestPromise: Promise<VoiceManifest> | null = null
const bytesCache = new Map<string, Promise<ArrayBuffer>>()
const clipCache = new Map<string, Promise<TrimmedClip>>()
let ctx: AudioContext | null = null
let active: AudioBufferSourceNode[] = []
let utteranceId = 0

export function loadVoiceManifest(): Promise<VoiceManifest> {
  if (!manifestPromise) {
    const p: Promise<VoiceManifest> = fetch(`${PACK_URL}manifest.json`).then((res) => {
      if (!res.ok) throw new Error(`voice manifest ${res.status}`)
      return res.json() as Promise<VoiceManifest>
    })
    // A failed load shouldn't stick — the next click retries.
    p.catch(() => {
      if (manifestPromise === p) manifestPromise = null
    })
    manifestPromise = p
  }
  return manifestPromise
}

function fetchClipBytes(file: string): Promise<ArrayBuffer> {
  let p = bytesCache.get(file)
  if (!p) {
    p = fetch(`${PACK_URL}${file}`).then((res) => {
      if (!res.ok) throw new Error(`voice clip ${file} ${res.status}`)
      return res.arrayBuffer()
    })
    p.catch(() => bytesCache.delete(file))
    bytesCache.set(file, p)
  }
  return p
}

/**
 * Warms the network cache for the clips nearly every click needs (digits +
 * the Starlink family, ~72% of the catalog between them). Bytes only — the
 * AudioContext is created on the first click, never here, so the browser's
 * autoplay policy stays happy.
 */
export function preloadSatelliteVoice(): void {
  // Chrome only starts loading its voice list on the first getVoices() call;
  // asking now means the first fallback click can already use a male voice.
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.getVoices()
  loadVoiceManifest()
    .then((m) => {
      const common = [...Object.values(m.digits), m.families.STARLINK].filter(Boolean)
      for (const file of common) fetchClipBytes(file).catch(() => {})
    })
    .catch(() => {})
}

/** [offset, duration] in seconds of the audible part of `buffer`. */
export function audibleRange(buffer: AudioBuffer): [number, number] {
  const rate = buffer.sampleRate
  let first = buffer.length
  let last = -1
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < first; i++) {
      if (Math.abs(data[i]) > SILENCE_THRESHOLD) {
        first = i
        break
      }
    }
    for (let i = data.length - 1; i > last; i--) {
      if (Math.abs(data[i]) > SILENCE_THRESHOLD) {
        last = i
        break
      }
    }
  }
  if (last < first) return [0, buffer.duration]
  const start = Math.max(0, first / rate - PAD_BEFORE_S)
  const end = Math.min(buffer.duration, (last + 1) / rate + PAD_AFTER_S)
  return [start, end - start]
}

function loadClip(audio: AudioContext, file: string): Promise<TrimmedClip> {
  let p = clipCache.get(file)
  if (!p) {
    p = fetchClipBytes(file)
      // decodeAudioData detaches its input; keep the cached bytes intact.
      .then((bytes) => audio.decodeAudioData(bytes.slice(0)))
      .then((buffer) => {
        const [offset, duration] = audibleRange(buffer)
        return { buffer, offset, duration }
      })
    p.catch(() => clipCache.delete(file))
    clipCache.set(file, p)
  }
  return p
}

/** Stops whatever is being said — spliced clips and the browser voice. */
export function stopSatelliteVoice(): void {
  utteranceId++
  for (const src of active) {
    try {
      src.stop()
    } catch {
      // already stopped
    }
  }
  active = []
  if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel()
}

// The browser voice is the OS's, and its default is often female (macOS
// "Samantha") — jarring next to the deep "Atlas" pack. Prefer a male English
// system voice where the platform ships one, in this order.
const MALE_VOICES = [
  'Daniel',
  'Alex',
  'Fred',
  'Aaron',
  'Arthur',
  'Google UK English Male',
  'Microsoft David',
  'Microsoft Mark',
  'Microsoft Guy',
].map((name) => new RegExp(`^${name}\\b`, 'i'))
/** Nudges the male fallback voice toward the pack's deep register. */
export const FALLBACK_PITCH = 0.85

// undefined = not chosen yet; null = chosen, and there's no male voice.
let fallbackVoice: SpeechSynthesisVoice | null | undefined
let watchingVoices = false

export function pickFallbackVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => v.lang.toLowerCase().startsWith('en'))
  for (const pattern of MALE_VOICES) {
    const match = english.find((v) => pattern.test(v.name))
    if (match) return match
  }
  return null
}

function chooseFallbackVoice(): SpeechSynthesisVoice | null {
  if (!watchingVoices) {
    watchingVoices = true
    speechSynthesis.addEventListener?.('voiceschanged', () => {
      fallbackVoice = undefined
    })
  }
  if (fallbackVoice === undefined) {
    const voices = speechSynthesis.getVoices()
    // Chrome loads voices asynchronously and returns [] at first — don't
    // cache that miss.
    if (voices.length === 0) return null
    fallbackVoice = pickFallbackVoice(voices)
  }
  return fallbackVoice
}

function speakWithBrowser(rawName: string): void {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return
  const text = spokenText(rawName)
  if (!text) return
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = 'en-US'
  const voice = chooseFallbackVoice()
  // Only a male voice is pitched down — a lowered default voice sounds off.
  if (voice) {
    utterance.voice = voice
    utterance.lang = voice.lang
    utterance.pitch = FALLBACK_PITCH
  }
  speechSynthesis.speak(utterance)
}

/**
 * Says a catalog satellite name, replacing anything already playing.
 *
 * Call it straight from the click handler: the AudioContext is created /
 * resumed synchronously, inside the user gesture, before the first await —
 * otherwise Safari and Chrome block playback once the clips have loaded.
 */
export async function speakSatellite(rawName: string): Promise<void> {
  stopSatelliteVoice()
  const id = utteranceId
  // The WS path names satellites by NORAD number until the catalog arrives —
  // that's not worth reading out.
  if (!rawName.trim() || /^\d+$/.test(rawName.trim())) return

  if (!ctx && typeof AudioContext !== 'undefined') ctx = new AudioContext()
  if (ctx?.state === 'suspended') void ctx.resume()
  const audio = ctx

  try {
    const plan = audio ? planUtterance(rawName, await loadVoiceManifest()) : null
    if (!audio || !plan) {
      if (id === utteranceId) speakWithBrowser(rawName)
      return
    }
    const clips = await Promise.all(plan.map((file) => loadClip(audio, file)))
    if (id !== utteranceId) return // a newer click took over while loading

    let at = audio.currentTime + 0.02
    for (const clip of clips) {
      const src = audio.createBufferSource()
      src.buffer = clip.buffer
      src.connect(audio.destination)
      src.onended = () => {
        active = active.filter((s) => s !== src)
      }
      src.start(at, clip.offset, clip.duration)
      active.push(src)
      at += clip.duration + CLIP_GAP_S
    }
  } catch (err) {
    console.warn('[satellite-voice] falling back to browser voice:', err)
    if (id === utteranceId) speakWithBrowser(rawName)
  }
}

/** Persisted "announce names on click" preference; on unless turned off. */
export function readVoiceEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeVoiceEnabled(on: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off')
  } catch {
    // private mode / blocked storage — the preference just won't persist
  }
}
