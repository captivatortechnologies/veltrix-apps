import validate, { extractWatchlistSpecs } from '../validate'
import { watchlistBody, watchlistIdOf } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('watchlists validate', () => {
  it('accepts a valid watchlist', () => {
    const r = validate(ctxWith([{ name: 'w1', fields: { displayName: 'VIP users', description: 'd', multiplyingFactor: 2, pinned: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a display name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a negative multiplying factor', () => {
    const r = validate(ctxWith([{ name: 'w1', fields: { displayName: 'x', multiplyingFactor: -1 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_factor')).toBe(true)
  })

  it('rejects duplicate display names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { displayName: 'dup' } },
        { name: 'b', fields: { displayName: 'dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractWatchlistSpecs / watchlistBody', () => {
  it('maps items to specs and defaults the multiplying factor to 1', () => {
    const specs = extractWatchlistSpecs(ctxWith([{ id: 'i1', name: 'w', fields: { displayName: 'VIP' } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].multiplyingFactor).toBe(1)
    expect(specs[0].pinned).toBe(false)
  })

  it('builds a create/update body with the manual population mechanism', () => {
    const body = watchlistBody({ displayName: 'VIP', description: 'd', multiplyingFactor: 2, pinned: true }) as {
      displayName: string
      multiplyingFactor: number
      entityPopulationMechanism: { manual: unknown }
      watchlistUserPreferences: { pinned: boolean }
    }
    expect(body.displayName).toBe('VIP')
    expect(body.multiplyingFactor).toBe(2)
    expect(body.watchlistUserPreferences.pinned).toBe(true)
    expect(watchlistIdOf('projects/p/locations/us/instances/i/watchlists/wl-7')).toBe('wl-7')
  })
})
