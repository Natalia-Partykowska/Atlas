import { describe, it, expect } from 'vitest'
import { buildMatchExpression, NO_DATA_COLOR } from './mapPaint'
import type { CountryDataMap } from '@/types/atlas'

describe('buildMatchExpression', () => {
  it('starts with the MapLibre match expression header', () => {
    const data: CountryDataMap = { USA: 50000, DEU: 30000 }
    const expr = buildMatchExpression(data, '#000000', '#ffffff')
    expect(expr[0]).toBe('match')
    expect(expr[1]).toEqual(['get', 'ISO_A3_EH'])
  })

  it('ends with the default NO_DATA_COLOR', () => {
    const data: CountryDataMap = { USA: 1 }
    const expr = buildMatchExpression(data, '#000000', '#ffffff')
    expect(expr[expr.length - 1]).toBe(NO_DATA_COLOR)
  })

  it('assigns low color to the minimum value', () => {
    const data: CountryDataMap = { LOW: 0, HIGH: 100 }
    const expr = buildMatchExpression(data, '#000000', '#ffffff')
    // Find the color assigned to LOW
    const lowIdx = expr.indexOf('LOW')
    expect(lowIdx).toBeGreaterThan(1)
    expect(expr[lowIdx + 1]).toBe('#000000')
  })

  it('assigns high color to the maximum value', () => {
    const data: CountryDataMap = { LOW: 0, HIGH: 100 }
    const expr = buildMatchExpression(data, '#000000', '#ffffff')
    const highIdx = expr.indexOf('HIGH')
    expect(highIdx).toBeGreaterThan(1)
    expect(expr[highIdx + 1]).toBe('#ffffff')
  })

  it('produces iso-color pairs for every entry', () => {
    const data: CountryDataMap = { USA: 1, GBR: 2, FRA: 3 }
    const expr = buildMatchExpression(data, '#000000', '#ffffff')
    // Structure: ['match', getter, iso1, color1, iso2, color2, iso3, color3, default]
    // Pairs occupy indices 2..length-2
    const pairs = expr.slice(2, -1)
    expect(pairs.length).toBe(Object.keys(data).length * 2)
  })

  it('handles a single-entry map without crashing (range = 1)', () => {
    const data: CountryDataMap = { USA: 42 }
    expect(() => buildMatchExpression(data, '#000000', '#ffffff')).not.toThrow()
  })

  it('ignores non-finite and negative values when computing range', () => {
    // BAD(-1) and NAN are filtered out; USA(100) is the only valid value.
    // With a single value: min=max=100, range collapses to 1, t=(100-100)/1=0
    // → USA gets the LOW color (t=0), not the high color.
    const data: CountryDataMap = { BAD: -1, USA: 100, NAN: NaN }
    const expr = buildMatchExpression(data, '#000000', '#ffffff')
    const usaIdx = expr.indexOf('USA')
    expect(usaIdx).toBeGreaterThan(1) // USA is present in the expression
    expect(expr[usaIdx + 1]).toBe('#000000') // t=0 → low color
  })
})
