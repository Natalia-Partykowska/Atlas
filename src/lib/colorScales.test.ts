import { describe, it, expect } from 'vitest'
import { interpolateColor } from './colorScales'

describe('interpolateColor', () => {
  it('returns low color at t=0', () => {
    expect(interpolateColor('#000000', '#ffffff', 0)).toBe('#000000')
  })

  it('returns high color at t=1', () => {
    expect(interpolateColor('#000000', '#ffffff', 1)).toBe('#ffffff')
  })

  it('returns midpoint at t=0.5', () => {
    expect(interpolateColor('#000000', '#ffffff', 0.5)).toBe('#808080')
  })

  it('interpolates between two arbitrary colors', () => {
    // #ff0000 (255,0,0) and #0000ff (0,0,255) at t=0.5 → #800080 (128,0,128)
    expect(interpolateColor('#ff0000', '#0000ff', 0.5)).toBe('#800080')
  })

  it('clamps channel values below 0 when t < 0 (defensive)', () => {
    const result = interpolateColor('#808080', '#000000', 2)
    // All channels would be negative — should be clamped to 00
    expect(result).toBe('#000000')
  })

  it('clamps channel values above 255 when t > 1 (defensive)', () => {
    const result = interpolateColor('#808080', '#ffffff', 2)
    expect(result).toBe('#ffffff')
  })

  it('handles identical low and high colors', () => {
    expect(interpolateColor('#4a90d9', '#4a90d9', 0.5)).toBe('#4a90d9')
  })
})
