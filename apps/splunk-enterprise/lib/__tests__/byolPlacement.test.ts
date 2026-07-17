import {
  allocateNodesBySite,
  validatePlacement,
  effectivePlacement,
  parsePlacement,
  normalizeControlPlaneLayout,
  type ClusterPlacement,
} from '../byolPlacement'

// =============================================================================
// App-owned placement helpers — mirror of the SDK's `byol/placement.ts`, plus
// the DB-parse helpers the mappers use. Pins the copy to the same contract so
// the two never drift, and covers the persisted JSONB round-trip.
// =============================================================================

const sites = (...pairs: Array<[string, number]>) =>
  pairs.map(([site, percent]) => ({ site, percent }))

describe('allocateNodesBySite (app copy)', () => {
  it('honors the percent split and sums to the total', () => {
    const out = allocateNodesBySite(10, sites(['a', 70], ['b', 30]))
    expect(out.map((s) => s.count)).toEqual([7, 3])
    expect(out.reduce((n, s) => n + s.count, 0)).toBe(10)
  })

  it('guarantees at least one node per site', () => {
    const out = allocateNodesBySite(4, sites(['a', 90], ['b', 5], ['c', 5]))
    expect(out.every((s) => s.count >= 1)).toBe(true)
  })
})

describe('validatePlacement (app copy)', () => {
  it('accepts single-site', () => {
    expect(validatePlacement({ mode: 'single' }, 5)).toBeNull()
  })
  it('rejects percents that do not total 100', () => {
    const p: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 60], ['b', 30]) }
    expect(validatePlacement(p, 5)).toMatch(/total 100/)
  })
})

describe('effectivePlacement (app copy)', () => {
  it('collapses multi-site for ineligible tiers', () => {
    const p: ClusterPlacement = { mode: 'multi-site', sites: sites(['a', 50], ['b', 50]) }
    expect(effectivePlacement(p, false)).toEqual({ mode: 'single' })
  })
})

describe('normalizeControlPlaneLayout', () => {
  it('passes through valid layouts', () => {
    expect(normalizeControlPlaneLayout('consolidated')).toBe('consolidated')
    expect(normalizeControlPlaneLayout('single')).toBe('single')
  })
  it('defaults unknown/empty values to dedicated', () => {
    expect(normalizeControlPlaneLayout(undefined)).toBe('dedicated')
    expect(normalizeControlPlaneLayout('bogus')).toBe('dedicated')
  })
})

describe('parsePlacement (DB round-trip)', () => {
  it('returns null for null/undefined', () => {
    expect(parsePlacement(null)).toBeNull()
    expect(parsePlacement(undefined)).toBeNull()
  })

  it('parses a JSON string (as some drivers return JSONB)', () => {
    const raw = JSON.stringify({ mode: 'multi-site', granularity: 'az', sites: sites(['us-east-1a', 60], ['us-east-1b', 40]) })
    expect(parsePlacement(raw)).toEqual({
      mode: 'multi-site',
      granularity: 'az',
      sites: [
        { site: 'us-east-1a', percent: 60 },
        { site: 'us-east-1b', percent: 40 },
      ],
    })
  })

  it('parses an already-parsed object (as Prisma returns JSONB)', () => {
    const obj = { mode: 'single' }
    expect(parsePlacement(obj)).toEqual({ mode: 'single' })
  })

  it('rejects malformed values', () => {
    expect(parsePlacement('{not json')).toBeNull()
    expect(parsePlacement({ mode: 'bogus' })).toBeNull()
    expect(parsePlacement(42)).toBeNull()
  })

  it('drops malformed site entries', () => {
    const raw = { mode: 'multi-site', sites: [{ site: 'a', percent: 100 }, { percent: 50 }, null] }
    expect(parsePlacement(raw)).toEqual({ mode: 'multi-site', sites: [{ site: 'a', percent: 100 }] })
  })
})
