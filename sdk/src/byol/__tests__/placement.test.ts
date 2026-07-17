import { describe, it, expect } from 'vitest'
import { allocateNodesBySite, validatePlacement, effectivePlacement } from '../placement'
import type { PlacementSite, ClusterPlacement } from '../types'

const sites = (...pairs: Array<[string, number]>): PlacementSite[] =>
  pairs.map(([site, percent]) => ({ site, percent }))

describe('allocateNodesBySite', () => {
  it('splits evenly when percents and count divide cleanly', () => {
    const out = allocateNodesBySite(4, sites(['a', 50], ['b', 50]))
    expect(out.map((s) => s.count)).toEqual([2, 2])
  })

  it('always sums to the total node count', () => {
    for (const total of [3, 5, 7, 10, 13]) {
      const out = allocateNodesBySite(total, sites(['a', 70], ['b', 30]))
      expect(out.reduce((sum, s) => sum + s.count, 0)).toBe(total)
    }
  })

  it('honors the percent split (70/30 of 10 → 7/3)', () => {
    const out = allocateNodesBySite(10, sites(['a', 70], ['b', 30]))
    expect(out.map((s) => s.count)).toEqual([7, 3])
  })

  it('guarantees at least one node per listed site', () => {
    const out = allocateNodesBySite(4, sites(['a', 90], ['b', 5], ['c', 5]))
    expect(out.every((s) => s.count >= 1)).toBe(true)
    expect(out.reduce((sum, s) => sum + s.count, 0)).toBe(4)
  })

  it('breaks remainder ties deterministically by site order', () => {
    const out = allocateNodesBySite(3, sites(['a', 50], ['b', 50]))
    expect(out.map((s) => s.count)).toEqual([2, 1])
  })

  it('returns an empty allocation when there are no sites', () => {
    expect(allocateNodesBySite(5, [])).toEqual([])
  })
})

describe('validatePlacement', () => {
  it('accepts single-site placement', () => {
    expect(validatePlacement({ mode: 'single' }, 5)).toBeNull()
  })

  it('requires at least two sites for multi-site', () => {
    const p: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 100]) }
    expect(validatePlacement(p, 5)).toMatch(/at least two sites/)
  })

  it('requires percents to total 100', () => {
    const p: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 60], ['b', 30]) }
    expect(validatePlacement(p, 5)).toMatch(/total 100/)
  })

  it('rejects duplicate sites', () => {
    const p: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 50], ['a', 50]) }
    expect(validatePlacement(p, 5)).toMatch(/more than once/)
  })

  it('rejects more sites than nodes', () => {
    const p: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 34], ['b', 33], ['c', 33]) }
    expect(validatePlacement(p, 2)).toMatch(/Too many sites/)
  })

  it('accepts a valid multi-site placement', () => {
    const p: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 60], ['b', 40]) }
    expect(validatePlacement(p, 5)).toBeNull()
  })
})

describe('effectivePlacement', () => {
  const multi: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 50], ['b', 50]) }

  it('collapses to single-site for ineligible tiers', () => {
    expect(effectivePlacement(multi, false)).toEqual({ mode: 'single' })
  })

  it('honors multi-site for eligible tiers', () => {
    expect(effectivePlacement(multi, true)).toEqual(multi)
  })

  it('collapses multi-site with fewer than two sites', () => {
    const thin: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 100]) }
    expect(effectivePlacement(thin, true)).toEqual({ mode: 'single' })
  })
})
