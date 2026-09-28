import { describe, expect, it } from 'vitest'
import {
  conjunctionPhraseClips,
  conjunctionSentence,
  distancePhrase,
  planConjunctionUtterance,
  timePhrase,
} from './conjunctionVoiceText'
import { voiceClipFile } from './satelliteVoiceName'
import type { VoiceManifest } from './satelliteVoiceName'

const SEC = 1_000
const MIN = 60 * SEC

describe('timePhrase', () => {
  // Rounded down, so the voice agrees with the drawer's T- countdown.
  it.each([
    { at: '5 s after TCA', ms: -5 * SEC, key: 'time:0', spoken: 'Close approach in under a minute' },
    { at: '59.9 s', ms: 59.9 * SEC, key: 'time:0', spoken: 'Close approach in under a minute' },
    { at: '1 min', ms: MIN, key: 'time:1', spoken: 'Close approach in one minute' },
    { at: '12 min 59 s', ms: 12 * MIN + 59 * SEC, key: 'time:12', spoken: 'Close approach in twelve minutes' },
    { at: '59 min 59 s', ms: 59 * MIN + 59 * SEC, key: 'time:59', spoken: 'Close approach in fifty-nine minutes' },
    { at: '1 h', ms: 60 * MIN, key: 'time:60', spoken: 'Close approach in one hour' },
    { at: '1 h 1 min', ms: 61 * MIN, key: 'time:61', spoken: 'Close approach in one hour and one minute' },
    { at: '1 h 15 min', ms: 75 * MIN, key: 'time:75', spoken: 'Close approach in one hour and fifteen minutes' },
    {
      at: '1 h 59 min 59 s',
      ms: 119 * MIN + 59 * SEC,
      key: 'time:119',
      spoken: 'Close approach in one hour and fifty-nine minutes',
    },
    { at: '2 h', ms: 120 * MIN, key: 'time:120', spoken: 'Close approach in two hours' },
    { at: '2 h 5 min (past the pack)', ms: 125 * MIN, key: 'time:125', spoken: 'Close approach in two hours and five minutes' },
  ])('$at → $spoken', ({ ms, key, spoken }) => {
    expect(timePhrase(ms)).toEqual({ key, spoken })
  })
})

describe('distancePhrase', () => {
  // Nearest 100 m. Wire values are f32, so the cases stay clear of exact .5 boundaries.
  it.each([
    { km: 0.049, key: 'dist:0', spoken: 'Less than a hundred metres apart' },
    { km: 0.051, key: 'dist:100', spoken: 'One hundred metres apart' },
    { km: 0.42, key: 'dist:400', spoken: 'Four hundred metres apart' },
    { km: 0.949, key: 'dist:900', spoken: 'Nine hundred metres apart' },
    { km: 0.951, key: 'dist:1000', spoken: 'One kilometre apart' },
    { km: 1.44, key: 'dist:1400', spoken: 'One point four kilometres apart' },
    { km: 2.0, key: 'dist:2000', spoken: 'Two kilometres apart' },
    { km: 4.96, key: 'dist:5000', spoken: 'Five kilometres apart' },
  ])('$km km → $key', ({ km, key, spoken }) => {
    expect(distancePhrase(km)).toEqual({ key, spoken })
  })
})

describe('conjunctionSentence', () => {
  it('reads the time, each satellite and the distance as separate lines', () => {
    expect(
      conjunctionSentence({
        nameA: 'STARLINK-3087',
        nameB: 'FENGYUN 1C DEB',
        msToTca: 12 * MIN + 40 * SEC,
        missKm: 0.42,
      }),
    ).toBe(
      'Close approach in twelve minutes. Starlink three zero eight seven. Fengyun one C debris. Four hundred metres apart.',
    )
  })
})

describe('conjunctionPhraseClips', () => {
  const clips = conjunctionPhraseClips()

  it('covers every minute of the 2 h window and every 100 m up to 5 km', () => {
    expect(clips).toHaveLength(121 + 51)
    const keys = new Set(clips.map((c) => c.key))
    for (let m = 0; m <= 120; m++) expect(keys).toContain(`time:${m}`)
    for (let d = 0; d <= 5000; d += 100) expect(keys).toContain(`dist:${d}`)
  })

  it('gives every phrase its own clip file', () => {
    const files = new Set(clips.map((c) => voiceClipFile('phrase', c.spoken)))
    expect(files.size).toBe(clips.length)
  })
})

describe('planConjunctionUtterance', () => {
  const manifest: VoiceManifest = {
    voice: 'Atlas',
    voiceHash: '000000000000',
    model: 'eleven_flash_v2_5',
    format: 'mp3_44100_64',
    digits: {
      '0': 'digit-zero.mp3',
      '3': 'digit-three.mp3',
      '7': 'digit-seven.mp3',
      '8': 'digit-eight.mp3',
    },
    families: { STARLINK: 'family-starlink.mp3' },
    names: { 'FENGYUN 1C DEB': 'name-fengyun-one-c-debris.mp3' },
    phrases: {
      'time:12': 'phrase-close-approach-in-twelve-minutes.mp3',
      'dist:400': 'phrase-four-hundred-metres-apart.mp3',
    },
  }
  const speech = {
    nameA: 'STARLINK-3087',
    nameB: 'FENGYUN 1C DEB',
    msToTca: 12 * MIN + 40 * SEC,
    missKm: 0.42,
  }

  it('plays the time line, both names and the distance line', () => {
    expect(planConjunctionUtterance(speech, manifest)).toEqual({
      time: 'phrase-close-approach-in-twelve-minutes.mp3',
      nameA: [
        'family-starlink.mp3',
        'digit-three.mp3',
        'digit-zero.mp3',
        'digit-eight.mp3',
        'digit-seven.mp3',
      ],
      nameB: ['name-fengyun-one-c-debris.mp3'],
      distance: 'phrase-four-hundred-metres-apart.mp3',
    })
  })

  // Anything missing means the browser voice reads the whole sentence instead.
  it.each([
    ['the first name has no clip', { ...speech, nameA: 'PISAT' }],
    ['the second name has no clip', { ...speech, nameB: 'PISAT' }],
    ['the time phrase has no clip', { ...speech, msToTca: 30 * MIN }],
    ['the distance phrase has no clip', { ...speech, missKm: 3.3 }],
  ])('returns null when %s', (_, s) => {
    expect(planConjunctionUtterance(s, manifest)).toBeNull()
  })

  it('returns null for a pack made before conjunction phrases existed', () => {
    expect(planConjunctionUtterance(speech, { ...manifest, phrases: undefined })).toBeNull()
  })
})
