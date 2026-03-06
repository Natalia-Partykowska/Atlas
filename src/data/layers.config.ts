import type { LayerConfig, DataLayerConfig } from '@/types/atlas'

export const LAYERS: LayerConfig[] = [
  {
    id: 'base',
    label: 'Base Map',
    description: 'Plain map — no data overlay',
  },
  {
    id: 'gdp',
    label: 'GDP per Capita',
    description: 'Gross domestic product per person, PPP (current intl. $)',
    unit: 'USD PPP',
    dataFile: '/data/gdp.json',
    colorLow: '#0d2a4a',
    colorHigh: '#06b6d4',
    format: (v) => `$${(v / 1000).toFixed(0)}k`,
  },
  {
    id: 'hdi',
    label: 'Human Development',
    description: 'UNDP Human Development Index — education, health, income (0–1)',
    unit: 'HDI score',
    dataFile: '/data/hdi.json',
    colorLow: '#042f2e',
    colorHigh: '#6baba5',
    format: (v) => v.toFixed(3),
  },
  {
    id: 'happiness',
    label: 'Happiness Score',
    description: 'World Happiness Report life evaluation score (0–10)',
    unit: '/ 10',
    dataFile: '/data/happiness.json',
    colorLow: '#2a1e00',
    colorHigh: '#c9b24a',
    format: (v) => v.toFixed(2),
  },
  {
    id: 'mobile-desktop',
    label: 'Mobile Web Traffic',
    description: 'Share of web traffic from mobile devices (StatCounter)',
    unit: '% mobile',
    dataFile: '/data/mobile-desktop.json',
    colorLow: '#1a1040',
    colorHigh: '#818cf8',
    format: (v) => `${v.toFixed(0)}%`,
  },
  {
    id: 'ai-adoption',
    label: 'AI Adoption',
    description: 'Share of working-age population using generative AI — Microsoft AI Diffusion Report H2 2025, via Visual Capitalist',
    unit: '% of adults',
    dataFile: '/data/ai-adoption.json',
    colorLow: '#042118',
    colorHigh: '#34d399',
    format: (v) => `${v.toFixed(1)}%`,
  },
]

export const LAYER_MAP: Record<string, DataLayerConfig> = Object.fromEntries(
  LAYERS.filter((l): l is DataLayerConfig => l.id !== 'base').map((l) => [l.id, l]),
)
