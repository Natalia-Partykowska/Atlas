import { describe, it, expect } from 'vitest'
import { countryRank, formatRank } from './countryRank'

describe('countryRank', () => {
  const data = { USA: 60000, IND: 8000, NOR: 90000, FIN: 55000 }

  it('ranks the highest-value country at 1', () => {
    expect(countryRank(data, 'NOR')).toEqual({ rank: 1, total: 4 })
  })

  it('ranks middle countries correctly', () => {
    expect(countryRank(data, 'USA')).toEqual({ rank: 2, total: 4 })
    expect(countryRank(data, 'FIN')).toEqual({ rank: 3, total: 4 })
  })

  it('ranks the lowest-value country at total', () => {
    expect(countryRank(data, 'IND')).toEqual({ rank: 4, total: 4 })
  })

  it('returns null for null layer data', () => {
    expect(countryRank(null, 'USA')).toBeNull()
  })

  it('returns null for null / undefined / empty iso', () => {
    expect(countryRank(data, null)).toBeNull()
    expect(countryRank(data, undefined)).toBeNull()
    expect(countryRank(data, '')).toBeNull()
  })

  it('returns null when the iso is not in the dataset', () => {
    expect(countryRank(data, 'XYZ')).toBeNull()
  })

  it('skips negative and non-finite values from ranking', () => {
    const dirty = { USA: 60000, IND: -100, NOR: 90000, FIN: NaN }
    // IND and FIN are filtered out — total drops to 2
    expect(countryRank(dirty, 'NOR')).toEqual({ rank: 1, total: 2 })
    expect(countryRank(dirty, 'USA')).toEqual({ rank: 2, total: 2 })
    expect(countryRank(dirty, 'IND')).toBeNull()
    expect(countryRank(dirty, 'FIN')).toBeNull()
  })

  it('returns the same result on repeated calls (memoised by data ref)', () => {
    const a = countryRank(data, 'NOR')
    const b = countryRank(data, 'NOR')
    expect(a).toEqual(b)
  })
})

describe('formatRank', () => {
  it('uses st / nd / rd / th suffixes', () => {
    expect(formatRank(1, 232)).toBe('1st of 232')
    expect(formatRank(2, 232)).toBe('2nd of 232')
    expect(formatRank(3, 232)).toBe('3rd of 232')
    expect(formatRank(4, 232)).toBe('4th of 232')
    expect(formatRank(5, 232)).toBe('5th of 232')
  })

  it('handles the 11/12/13 exception', () => {
    expect(formatRank(11, 232)).toBe('11th of 232')
    expect(formatRank(12, 232)).toBe('12th of 232')
    expect(formatRank(13, 232)).toBe('13th of 232')
    expect(formatRank(14, 232)).toBe('14th of 232')
  })

  it('handles teens beyond 13 normally', () => {
    expect(formatRank(15, 232)).toBe('15th of 232')
    expect(formatRank(20, 232)).toBe('20th of 232')
  })

  it('handles 21 / 22 / 23 with st / nd / rd', () => {
    expect(formatRank(21, 232)).toBe('21st of 232')
    expect(formatRank(22, 232)).toBe('22nd of 232')
    expect(formatRank(23, 232)).toBe('23rd of 232')
    expect(formatRank(24, 232)).toBe('24th of 232')
  })

  it('handles 100s consistently', () => {
    expect(formatRank(101, 232)).toBe('101st of 232')
    expect(formatRank(111, 232)).toBe('111th of 232')
    expect(formatRank(112, 232)).toBe('112th of 232')
    expect(formatRank(121, 232)).toBe('121st of 232')
  })
})
