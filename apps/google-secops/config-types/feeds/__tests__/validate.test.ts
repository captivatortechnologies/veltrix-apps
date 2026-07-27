import validate, { extractFeedSpecs, parseDetails, settingsKeyOf } from '../validate'
import { feedBody, feedIdOf } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const DETAILS = JSON.stringify({
  feedSourceType: 'HTTP',
  logType: 'projects/p/locations/us/instances/i/logTypes/WINEVTLOG',
  httpSettings: { uri: 'https://example.com/feed', sourceType: 'FILES' },
})

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('feeds validate', () => {
  it('accepts a valid feed', () => {
    const r = validate(ctxWith([{ name: 'f1', fields: { displayName: 'Windows feed', details: DETAILS } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a display name and details', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects malformed details JSON', () => {
    const r = validate(ctxWith([{ name: 'f1', fields: { displayName: 'x', details: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('requires a source type, log type and settings object', () => {
    const r = validate(ctxWith([{ name: 'f1', fields: { displayName: 'x', details: '{}' } }]))
    expect(r.errors.some((e) => e.code === 'missing_source_type')).toBe(true)
    expect(r.errors.some((e) => e.code === 'missing_log_type')).toBe(true)
    expect(r.errors.some((e) => e.code === 'missing_settings')).toBe(true)
  })

  it('warns on an unrecognized feedSourceType', () => {
    const details = JSON.stringify({ feedSourceType: 'MADE_UP', logType: 'l', xSettings: {} })
    const r = validate(ctxWith([{ name: 'f1', fields: { displayName: 'x', details } }]))
    expect(r.warnings.some((w) => w.code === 'unknown_source_type')).toBe(true)
  })

  it('rejects duplicate display names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { displayName: 'dup', details: DETAILS } },
        { name: 'b', fields: { displayName: 'dup', details: DETAILS } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractFeedSpecs / feedBody / helpers', () => {
  it('maps items to specs and pulls source type + log type out of details', () => {
    const specs = extractFeedSpecs(ctxWith([{ id: 'i1', name: 'f', fields: { displayName: 'Win', details: DETAILS } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].feedSourceType).toBe('HTTP')
    expect(specs[0].logType).toBe('projects/p/locations/us/instances/i/logTypes/WINEVTLOG')
  })

  it('builds a create/update body with displayName and details', () => {
    const specs = extractFeedSpecs(ctxWith([{ name: 'f', fields: { displayName: 'Win', details: DETAILS } }]).canvas)
    const body = feedBody(specs[0]) as { displayName: string; details: Record<string, unknown> }
    expect(body.displayName).toBe('Win')
    expect((body.details as { feedSourceType: string }).feedSourceType).toBe('HTTP')
  })

  it('finds the settings key and the feed id tail', () => {
    expect(settingsKeyOf(parseDetails(DETAILS))).toBe('httpSettings')
    expect(feedIdOf('projects/p/locations/us/instances/i/feeds/abc-123')).toBe('abc-123')
  })
})
