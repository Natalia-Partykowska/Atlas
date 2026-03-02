import type { Config } from 'tailwindcss'

const config: Config = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        background: '#080B12',
        panel: '#0F1623',
        border: '#1E2A3A',
        accent: '#3B82F6',
        'text-primary': '#F1F5F9',
        'text-secondary': '#94A3B8',
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono', 'Fira Code', 'monospace'],
      },
    },
  },
  plugins: [],
}

export default config
