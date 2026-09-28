import { useAtlasStore } from '@/stores/useAtlasStore'
import { stopSatelliteVoice } from '@/lib/satelliteVoice'

/**
 * Footer of the drawers that speak (satellite details, conjunctions): the
 * persisted "Read aloud" switch they share, and the ElevenLabs credit the free
 * plan requires wherever the voice is used.
 */
export function VoiceFooter() {
  const voiceEnabled = useAtlasStore((s) => s.satelliteVoiceEnabled)
  const setVoiceEnabled = useAtlasStore((s) => s.setSatelliteVoiceEnabled)

  return (
    <footer className="px-4 py-3 border-t border-white/10 flex items-center justify-between text-[11px]">
      <button
        role="switch"
        aria-checked={voiceEnabled}
        onClick={() => {
          if (voiceEnabled) stopSatelliteVoice()
          setVoiceEnabled(!voiceEnabled)
        }}
        className="flex items-center gap-2 text-white/55 hover:text-white/80 transition-colors"
      >
        <span
          aria-hidden
          className={[
            'relative inline-block w-7 h-4 rounded-full transition-colors',
            voiceEnabled ? 'bg-accent/70' : 'bg-white/15',
          ].join(' ')}
        >
          <span
            className={[
              'absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform',
              voiceEnabled ? 'translate-x-3' : 'translate-x-0',
            ].join(' ')}
          />
        </span>
        Read aloud
      </button>
      <span className="text-white/30">
        Voice by{' '}
        <a
          href="https://elevenlabs.io"
          target="_blank"
          rel="noopener noreferrer"
          className="hover:text-white/60 transition-colors"
        >
          elevenlabs.io
        </a>
      </span>
    </footer>
  )
}

/** Speaker glyph for the "say it again" buttons. */
export function SpeakerIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2.5 6v4h2.5l3.5 3V3L5 6H2.5z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path
        d="M11 5.5a3.5 3.5 0 010 5M12.8 3.8a6 6 0 010 8.4"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}
