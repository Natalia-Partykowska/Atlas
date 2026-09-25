// Satellite name → voice clips. Pure and import-free so the local generator
// (`scripts/generate-satellite-voice.mjs`, run with Node's type stripping)
// shares the exact keys and spoken text the browser looks up.
//
// Credit model (ElevenLabs free plan): constellation members are spoken as a
// family clip plus spliced digit clips ("Starlink" + "three zero eight seven"),
// so 68 family names + 10 digits cover ~72% of the catalog. Everything else is
// a whole-name clip, or the browser's own voice until one is generated.

export interface VoiceManifest {
  /** Voice display name, e.g. "Atlas" */
  voice: string
  /** First 12 hex chars of sha256(voice ID) — detects a voice change without
   *  committing the ID itself */
  voiceHash: string
  model: string
  format: string
  /** '0'–'9' → clip file */
  digits: Record<string, string>
  /** family key (`STARLINK`) → clip file */
  families: Record<string, string>
  /** name key (`ISS ZARYA`) → clip file */
  names: Record<string, string>
}

export type VoiceClipKind = 'digit' | 'family' | 'name'

export const DIGIT_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
]

const TEENS = [
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen',
  'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
]
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

// Keyed by `voiceKey`. The ISS and Tiangong core modules stand for the whole
// station, which is what a visitor clicking them expects to hear.
const SPOKEN_OVERRIDES: Record<string, string> = {
  'ISS ZARYA': 'International Space Station',
  'CSS TIANHE': 'Tiangong space station',
}

const FAMILY_MEMBER = /^(.*?[A-Z].*?)[- ]0*(\d+)$/

/**
 * Lookup key for a catalog name: `(…)` / `[…]` qualifiers dropped, whitespace
 * collapsed, uppercased. A bare acronym keeps its qualifier, since that's the
 * part that identifies it: `ISS (NAUKA)` → `ISS NAUKA`.
 */
export function voiceKey(raw: string): string {
  let base = ''
  let qualifier = ''
  let depth = 0
  for (const c of raw) {
    if (c === '(' || c === '[') {
      depth++
      qualifier += ' '
    } else if (c === ')' || c === ']') {
      depth = Math.max(0, depth - 1)
    } else if (depth === 0) {
      base += c
    } else {
      qualifier += c
    }
  }
  const tidy = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase()
  const b = tidy(base)
  const q = tidy(qualifier)
  if (b.length <= 3 && q) return b ? `${b} ${q}` : q
  return b
}

/**
 * `STARLINK-3087` → `{ family: 'STARLINK', digits: '3087' }`. Leading zeros
 * are dropped (`KUIPER-00428` → `428`). Whether the family has a clip is the
 * manifest's call — the generator only makes clips for large families.
 */
export function parseFamilyMember(raw: string): { family: string; digits: string } | null {
  const m = FAMILY_MEMBER.exec(voiceKey(raw))
  return m ? { family: m[1], digits: m[2] } : null
}

/**
 * What to say for a catalog name — the text sent to ElevenLabs and read by
 * the browser-voice fallback. Numbers are written out because Flash v2.5
 * doesn't normalise them itself below the Enterprise plan.
 */
export function spokenText(raw: string): string {
  const key = voiceKey(raw)
  const override = SPOKEN_OVERRIDES[key]
  if (override) return override

  const words: string[] = []
  for (const token of key.split(' ')) {
    if (token === 'DEB') words.push('debris')
    else if (token === 'R/B') words.push('rocket body')
    else {
      for (const part of token.split(/[-_/]/)) {
        const spoken = speakPart(part)
        if (spoken) words.push(spoken)
      }
    }
  }
  return words.length > 0 ? words.join(' ') : raw.trim()
}

/**
 * Clips to play, in order, for a catalog name — or `null` when the manifest
 * can't voice it and the caller should fall back to the browser's voice.
 */
export function planUtterance(raw: string, manifest: VoiceManifest): string[] | null {
  const name = manifest.names[voiceKey(raw)]
  if (name) return [name]

  const member = parseFamilyMember(raw)
  if (!member) return null
  const family = manifest.families[member.family]
  if (!family) return null
  const digits = [...member.digits].map((d) => manifest.digits[d])
  if (digits.some((d) => !d)) return null
  return [family, ...digits]
}

/** Clip file name; derived from the spoken text so equal speech shares a file. */
export function voiceClipFile(kind: VoiceClipKind, spoken: string): string {
  const slug = spoken
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/, '')
  return `${kind}-${slug || '_'}.mp3`
}

// `BIIRM` → "Block two R M"; `1C` → "one C"; `STARLINK` → "Starlink".
function speakPart(part: string): string {
  const block = /^B(III|II)(RM|R|F|A)?$/.exec(part)
  if (block) {
    const numeral = block[1] === 'III' ? 'three' : 'two'
    const suffix = block[2] ? ` ${[...block[2]].join(' ')}` : ''
    return `Block ${numeral}${suffix}`
  }
  const runs = part.match(/\d+|[A-Z]+/g) ?? []
  return runs.map((run) => (/\d/.test(run) ? numberWords(run) : speakLetters(run))).join(' ')
}

// Pronounceable all-caps words read better title-cased; short or vowel-poor
// runs are acronyms the model should spell out (GPS, TDRS, JCSAT).
function speakLetters(run: string): string {
  const vowels = [...run].filter((c) => 'AEIOUY'.includes(c)).length
  if (run.length >= 4 && vowels >= 2 && !run.includes('II')) {
    return run[0] + run.slice(1).toLowerCase()
  }
  return run
}

// Up to two digits read naturally ("thirty-four"); longer runs digit by digit
// ("two two five one"), matching how the spliced family digits sound.
function numberWords(run: string): string {
  const n = run.replace(/^0+(?=\d)/, '')
  if (n.length === 1) return DIGIT_WORDS[Number(n)]
  if (n.length === 2) {
    const v = Number(n)
    if (v < 20) return TEENS[v - 10]
    const ones = v % 10
    return ones === 0 ? TENS[Math.floor(v / 10)] : `${TENS[Math.floor(v / 10)]}-${DIGIT_WORDS[ones]}`
  }
  return [...n].map((d) => DIGIT_WORDS[Number(d)]).join(' ')
}
