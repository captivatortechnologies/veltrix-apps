import validate, { extractWatchlistSpecs } from '../validate'
import { watchlistBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('watchlists validate', () => {
  it('accepts a valid feed-subscription watchlist', () => {
    const r = validate(ctxWith([{ name: 'Ransomware', fields: { name: 'Ransomware', feedId: 'ABC123', tags_enabled: true, alerts_enabled: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and feed id', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.filter((e) => e.code === 'required').length >= 2).toBe(true)
  })

  it('rejects alerts enabled without tags enabled', () => {
    const r = validate(ctxWith([{ name: 'W', fields: { name: 'W', feedId: 'F', tags_enabled: false, alerts_enabled: true } }]))
    expect(r.errors.some((e) => e.code === 'alerts_require_tags')).toBe(true)
  })

  it('coerces string booleans for the tags invariant', () => {
    const r = validate(ctxWith([{ name: 'W', fields: { name: 'W', feedId: 'F', tags_enabled: 'false', alerts_enabled: 'true' } }]))
    expect(r.errors.some((e) => e.code === 'alerts_require_tags')).toBe(true)
  })

  it('flags a duplicate watchlist name', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', feedId: 'F' } },
        { name: 'dup', fields: { name: 'dup', feedId: 'G' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('watchlistBody', () => {
  it('builds a feed-subscription body with a feed_id classifier', () => {
    const spec = extractWatchlistSpecs(
      ctxWith([{ name: 'W', fields: { name: 'W', description: 'd', feedId: 'FID', tags_enabled: true, alerts_enabled: false } }]).canvas
    )[0]
    const body = watchlistBody(spec) as {
      name: string
      description: string
      tags_enabled: boolean
      alerts_enabled: boolean
      classifier: { key: string; value: string }
    }
    expect(body.name).toBe('W')
    expect(body.description).toBe('d')
    expect(body.tags_enabled).toBe(true)
    expect(body.alerts_enabled).toBe(false)
    expect(body.classifier.key).toBe('feed_id')
    expect(body.classifier.value).toBe('FID')
  })
})

describe('extractWatchlistSpecs', () => {
  it('defaults tags enabled to true when unset', () => {
    const spec = extractWatchlistSpecs(ctxWith([{ name: 'W', fields: { name: 'W', feedId: 'F' } }]).canvas)[0]
    expect(spec.tagsEnabled).toBe(true)
    expect(spec.alertsEnabled).toBe(false)
  })
})
