import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { conjunctionPhraseClips } from './conjunctionVoiceText'
import { voiceClipFile } from './satelliteVoiceName'
import type { VoiceManifest } from './satelliteVoiceName'

// Checks the committed voice pack, not code: a generator run that stopped
// early would otherwise ship quietly, and those callouts would fall back to
// the browser voice.
const PACK = join(dirname(fileURLToPath(import.meta.url)), '../../public/audio/satellite-voice')
const manifest: VoiceManifest = JSON.parse(readFileSync(join(PACK, 'manifest.json'), 'utf8'))

describe('conjunction voice pack', () => {
  it('has a clip on disk for every time and distance line', () => {
    const missing = conjunctionPhraseClips()
      .filter(({ key, spoken }) => {
        const file = manifest.phrases?.[key]
        return file !== voiceClipFile('phrase', spoken) || !existsSync(join(PACK, file))
      })
      .map(({ key }) => key)
    expect(missing).toEqual([])
  })
})
