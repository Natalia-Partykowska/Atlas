import { describe, expect, it } from 'vitest'
import {
  parseFamilyMember,
  planUtterance,
  spokenText,
  voiceClipFile,
  voiceKey,
} from './satelliteVoiceName'
import type { VoiceManifest } from './satelliteVoiceName'

describe('voiceKey', () => {
  it.each([
    ['STARLINK-11602 [DTC]', 'STARLINK-11602'],
    ['GPS BIIF-1  (PRN 25)', 'GPS BIIF-1'],
    ['GALAXY 34 (G-34)', 'GALAXY 34'],
    ['FENGYUN 1C DEB', 'FENGYUN 1C DEB'],
    ['ISS (ZARYA)', 'ISS ZARYA'],
    ['ISS (NAUKA)', 'ISS NAUKA'],
    ['  starlink-3087 ', 'STARLINK-3087'],
  ])('%s → %s', (raw, want) => {
    expect(voiceKey(raw)).toBe(want)
  })
})

describe('parseFamilyMember', () => {
  it.each([
    ['STARLINK-3087', { family: 'STARLINK', digits: '3087' }],
    ['STARLINK-11602 [DTC]', { family: 'STARLINK', digits: '11602' }],
    ['KUIPER-00428', { family: 'KUIPER', digits: '428' }],
    ['IRIDIUM 180', { family: 'IRIDIUM', digits: '180' }],
    ['FLOCK 4H-5', { family: 'FLOCK 4H', digits: '5' }],
    ['GEESAT-6 09', { family: 'GEESAT-6', digits: '9' }],
    ['HULIANWANG DIGUI-43', { family: 'HULIANWANG DIGUI', digits: '43' }],
  ])('%s', (raw, want) => {
    expect(parseFamilyMember(raw)).toEqual(want)
  })

  it.each(['FENGYUN 1C DEB', 'ISS (ZARYA)', '2024-153C', 'POISK'])(
    '%s is not a family member',
    (raw) => {
      expect(parseFamilyMember(raw)).toBeNull()
    },
  )
})

describe('spokenText', () => {
  it.each([
    ['ISS (ZARYA)', 'International Space Station'],
    ['CSS (TIANHE)', 'Tiangong space station'],
    ['ISS (NAUKA)', 'ISS Nauka'],
    ['CSS (MENGTIAN)', 'CSS Mengtian'],
    ['STARLINK-3087', 'Starlink three zero eight seven'],
    ['KUIPER-00428', 'Kuiper four two eight'],
    ['FENGYUN 1C DEB', 'Fengyun one C debris'],
    ['IRIDIUM 33 DEB', 'Iridium thirty-three debris'],
    ['COSMOS 2251 DEB', 'Cosmos two two five one debris'],
    ['SL-16 R/B', 'SL sixteen rocket body'],
    ['GALAXY 34 (G-34)', 'Galaxy thirty-four'],
    ['NOAA 20 (JPSS-1)', 'Noaa twenty'],
    ['GPS BIIF-1  (PRN 25)', 'GPS Block two F one'],
    ['GPS BIIRM-8 (PRN 05)', 'GPS Block two R M eight'],
    ['GPS BIII-10 (PRN 13)', 'GPS Block three ten'],
    ['GEESAT-6 09', 'Geesat six nine'],
    ['ONEWEB-0416', 'Oneweb four one six'],
    ['TDRS 13', 'TDRS thirteen'],
    ['CREW DRAGON 12', 'CREW Dragon twelve'],
    ['2024-153C', 'two zero two four one five three C'],
    ['LEMUR-2-AHMED-ASRAR', 'Lemur two Ahmed Asrar'],
  ])('%s → %s', (raw, want) => {
    expect(spokenText(raw)).toBe(want)
  })
})

describe('voiceClipFile', () => {
  it('slugs the spoken text under its kind', () => {
    expect(voiceClipFile('name', 'International Space Station')).toBe(
      'name-international-space-station.mp3',
    )
    expect(voiceClipFile('family', 'Hulianwang Digui')).toBe('family-hulianwang-digui.mp3')
    expect(voiceClipFile('digit', 'three')).toBe('digit-three.mp3')
  })

  it('shares one file between names that sound the same', () => {
    expect(voiceClipFile('name', spokenText('FENGYUN 1C DEB'))).toBe(
      voiceClipFile('name', spokenText('FENGYUN 1C DEB ')),
    )
  })
})

describe('planUtterance', () => {
  const manifest: VoiceManifest = {
    voiceId: 'atlas',
    model: 'eleven_flash_v2_5',
    format: 'mp3_44100_64',
    digits: {
      '0': 'digit-zero.mp3',
      '3': 'digit-three.mp3',
      '7': 'digit-seven.mp3',
      '8': 'digit-eight.mp3',
    },
    families: { STARLINK: 'family-starlink.mp3', IRIDIUM: 'family-iridium.mp3' },
    names: {
      'ISS ZARYA': 'name-international-space-station.mp3',
      'FENGYUN 1C DEB': 'name-fengyun-one-c-debris.mp3',
    },
  }

  it('plays a whole-name clip when there is one', () => {
    expect(planUtterance('ISS (ZARYA)', manifest)).toEqual([
      'name-international-space-station.mp3',
    ])
    expect(planUtterance('FENGYUN 1C DEB', manifest)).toEqual(['name-fengyun-one-c-debris.mp3'])
  })

  it('splices family + digits for constellation members', () => {
    expect(planUtterance('STARLINK-3087 [DTC]', manifest)).toEqual([
      'family-starlink.mp3',
      'digit-three.mp3',
      'digit-zero.mp3',
      'digit-eight.mp3',
      'digit-seven.mp3',
    ])
  })

  it('prefers a whole-name clip over the family splice', () => {
    const withName = {
      ...manifest,
      names: { ...manifest.names, 'STARLINK-3087': 'name-starlink-3087.mp3' },
    }
    expect(planUtterance('STARLINK-3087', withName)).toEqual(['name-starlink-3087.mp3'])
  })

  it('returns null so the caller can use the browser voice', () => {
    expect(planUtterance('GALAXY 34 (G-34)', manifest)).toBeNull() // no clip, no family
    expect(planUtterance('KUIPER-00428', manifest)).toBeNull() // family not in pack
    expect(planUtterance('IRIDIUM 180', manifest)).toBeNull() // digit 1 missing
  })
})
