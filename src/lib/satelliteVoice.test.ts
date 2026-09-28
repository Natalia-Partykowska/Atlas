import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceManifest } from './satelliteVoiceName'

const MANIFEST: VoiceManifest = {
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
  names: { 'ISS ZARYA': 'name-international-space-station.mp3' },
}

// 1 s at 1 kHz; audible only for samples 200–699 → trimmed to 0.19 s + 0.53 s.
function fakeBuffer(tag: string, audible: [number, number] | null = [200, 700]) {
  const data = new Float32Array(1000)
  if (audible) data.fill(0.5, audible[0], audible[1])
  return {
    tag,
    sampleRate: 1000,
    length: 1000,
    duration: 1,
    numberOfChannels: 1,
    getChannelData: () => data,
  }
}

class FakeSource {
  buffer: ReturnType<typeof fakeBuffer> | null = null
  onended: (() => void) | null = null
  connect = vi.fn()
  start = vi.fn()
  stop = vi.fn()
}

let contexts: FakeAudioContext[] = []
class FakeAudioContext {
  state = 'suspended'
  currentTime = 10
  destination = {}
  sources: FakeSource[] = []
  resume = vi.fn(async () => {
    this.state = 'running'
  })
  // Clip bytes are the file name, so the decoded buffer knows which clip it is.
  decodeAudioData = vi.fn(async (bytes: ArrayBuffer) => fakeBuffer(new TextDecoder().decode(bytes)))
  constructor() {
    contexts.push(this)
  }
  createBufferSource() {
    const src = new FakeSource()
    this.sources.push(src)
    return src
  }
}

let fetched: string[] = []
let manifestOk = true
const speech = { speak: vi.fn(), cancel: vi.fn() }

beforeEach(() => {
  vi.resetModules()
  contexts = []
  fetched = []
  manifestOk = true
  speech.speak.mockClear()
  speech.cancel.mockClear()
  vi.stubGlobal('AudioContext', FakeAudioContext)
  vi.stubGlobal('speechSynthesis', speech)
  vi.stubGlobal(
    'SpeechSynthesisUtterance',
    class {
      lang = ''
      constructor(public text: string) {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      fetched.push(url)
      if (url.endsWith('manifest.json')) {
        return { ok: manifestOk, status: manifestOk ? 200 : 404, json: async () => MANIFEST }
      }
      const file = url.split('/').pop()!
      return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(file).buffer }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const load = () => import('./satelliteVoice')
const spokenTexts = () => speech.speak.mock.calls.map(([u]) => (u as { text: string }).text)

describe('speakSatellite', () => {
  it('splices family + digit clips, trimmed and back-to-back', async () => {
    const { speakSatellite, CLIP_GAP_S } = await load()
    await speakSatellite('STARLINK-3087 [DTC]')

    const [ctx] = contexts
    expect(ctx.resume).toHaveBeenCalled()
    expect(ctx.sources.map((s) => s.buffer?.tag)).toEqual([
      'family-starlink.mp3',
      'digit-three.mp3',
      'digit-zero.mp3',
      'digit-eight.mp3',
      'digit-seven.mp3',
    ])
    ctx.sources.forEach((src, i) => {
      const [at, offset, duration] = src.start.mock.calls[0]
      expect(offset).toBeCloseTo(0.19)
      expect(duration).toBeCloseTo(0.53)
      expect(at).toBeCloseTo(10.02 + i * (0.53 + CLIP_GAP_S))
    })
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('plays a whole-name clip', async () => {
    const { speakSatellite } = await load()
    await speakSatellite('ISS (ZARYA)')
    expect(contexts[0].sources.map((s) => s.buffer?.tag)).toEqual([
      'name-international-space-station.mp3',
    ])
  })

  it('uses the browser voice when the pack has no clip', async () => {
    const { speakSatellite } = await load()
    await speakSatellite('GALAXY 34 (G-34)')
    expect(contexts[0].sources).toHaveLength(0)
    expect(spokenTexts()).toEqual(['Galaxy thirty-four'])
  })

  it('uses the browser voice when the manifest fails to load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    manifestOk = false
    const { speakSatellite } = await load()
    await speakSatellite('STARLINK-3087')
    expect(spokenTexts()).toEqual(['Starlink three zero eight seven'])
  })

  it('uses the browser voice without Web Audio', async () => {
    vi.stubGlobal('AudioContext', undefined)
    const { speakSatellite } = await load()
    await speakSatellite('STARLINK-3087')
    expect(spokenTexts()).toEqual(['Starlink three zero eight seven'])
    expect(fetched).toEqual([])
  })

  it('ignores a bare NORAD number', async () => {
    const { speakSatellite } = await load()
    await speakSatellite('25544')
    expect(fetched).toEqual([])
    expect(speech.speak).not.toHaveBeenCalled()
  })

  it('drops a click that is still loading when a newer one arrives', async () => {
    const { speakSatellite } = await load()
    const first = speakSatellite('STARLINK-3087')
    await speakSatellite('ISS (ZARYA)')
    await first
    expect(contexts[0].sources.map((s) => s.buffer?.tag)).toEqual([
      'name-international-space-station.mp3',
    ])
  })

  it('stops a name that is already playing when a newer one starts', async () => {
    const { speakSatellite } = await load()
    await speakSatellite('STARLINK-3087')
    const playing = [...contexts[0].sources]
    await speakSatellite('ISS (ZARYA)')
    for (const src of playing) expect(src.stop).toHaveBeenCalled()
    expect(speech.cancel).toHaveBeenCalled()
  })

  it('loads the manifest once and decodes each clip once', async () => {
    const { speakSatellite } = await load()
    await speakSatellite('STARLINK-3087')
    await speakSatellite('STARLINK-3087')
    expect(fetched.filter((u) => u.endsWith('manifest.json'))).toHaveLength(1)
    expect(contexts).toHaveLength(1)
    expect(contexts[0].decodeAudioData).toHaveBeenCalledTimes(5)
  })
})

describe('preloadSatelliteVoice', () => {
  it('fetches the digit + Starlink clips without creating an AudioContext', async () => {
    const { preloadSatelliteVoice } = await load()
    preloadSatelliteVoice()
    await vi.waitFor(() => expect(fetched).toHaveLength(6))
    expect(fetched.map((u) => u.split('/').pop()).sort()).toEqual(
      [
        'digit-eight.mp3',
        'digit-seven.mp3',
        'digit-three.mp3',
        'digit-zero.mp3',
        'family-starlink.mp3',
        'manifest.json',
      ].sort(),
    )
    expect(contexts).toHaveLength(0)
  })
})

describe('audibleRange', () => {
  it('keeps the whole buffer when nothing is above the threshold', async () => {
    const { audibleRange } = await load()
    expect(audibleRange(fakeBuffer('quiet', null) as unknown as AudioBuffer)).toEqual([0, 1])
  })
})

describe('voice preference', () => {
  beforeEach(() => localStorage.clear())

  it('defaults to on and persists a change', async () => {
    const { readVoiceEnabled, writeVoiceEnabled } = await load()
    expect(readVoiceEnabled()).toBe(true)
    writeVoiceEnabled(false)
    expect(readVoiceEnabled()).toBe(false)
    writeVoiceEnabled(true)
    expect(readVoiceEnabled()).toBe(true)
  })

  it('survives blocked storage', async () => {
    const { readVoiceEnabled, writeVoiceEnabled } = await load()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readVoiceEnabled()).toBe(true)
    expect(() => writeVoiceEnabled(false)).not.toThrow()
  })
})
