import validate, { extractReportSpecs, reportKey, readNumber, tryParseJson } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-reports',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-reports',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const validFields = {
  name: 'Public S3 buckets',
  query: '{"select":true,"type":["BUCKET"]}',
}

describe('Wiz Reports Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid on-demand report', async () => {
    const result = await validate(makeCtx([{ name: 'Report', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires name and a graph query', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('query'))).toBe(true)
  })

  it('rejects a malformed graph query', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, query: '{oops' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('requires a start time when an interval is set', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { ...validFields, run_interval_hours: 24 } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('run_starts_at'))).toBe(true)
  })

  it('requires an interval when a start time is set', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, run_starts_at: '2026-01-01T00:00:00Z' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('run_interval_hours'))).toBe(true)
  })

  it('rejects a non-positive interval', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, run_interval_hours: 0, run_starts_at: '2026-01-01T00:00:00Z' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_interval')).toBe(true)
  })

  it('rejects an invalid start datetime', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, run_interval_hours: 24, run_starts_at: 'not-a-date' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_datetime')).toBe(true)
  })

  it('accepts a valid scheduled report', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, run_interval_hours: 24, run_starts_at: '2026-01-01T00:00:00Z' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects duplicate report names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Weekly Exposure' } },
        { name: 'b', fields: { ...validFields, name: 'weekly exposure' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_report')).toBe(true)
  })

  it('extractReportSpecs trims, reads numbers and defaults schedule to null', () => {
    const specs = extractReportSpecs(
      makeCtx([
        { name: 'e', fields: { name: '  Rep X  ', query: '  {"a":1}  ', run_interval_hours: '12' } },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Rep X')
    expect(specs[0].query).toBe('{"a":1}')
    expect(specs[0].runIntervalHours).toBe(12)
    expect(specs[0].runStartsAt).toBe('')
    expect(reportKey('  Rep X ')).toBe('rep x')
  })

  it('helpers behave as documented', () => {
    expect(readNumber(24)).toBe(24)
    expect(readNumber('7')).toBe(7)
    expect(readNumber('')).toBeNull()
    expect(readNumber('abc')).toBeNull()
    expect(tryParseJson('').ok).toBe(true)
    expect(tryParseJson('{bad').ok).toBe(false)
    expect(tryParseJson('{"a":1}').value).toEqual({ a: 1 })
  })
})
