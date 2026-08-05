import validate, {
  extractExternalDynamicListSpecs,
  buildExternalDynamicListFields,
  buildRecurring,
  externalDynamicListDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-external-dynamic-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-external-dynamic-lists',
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

describe('Panorama External Dynamic Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal hourly IP EDL', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'threat-feed', type: 'ip', source_url: 'https://feed.example.com/ips.txt', recurring: 'hourly' } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires a source URL', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', type: 'url', source_url: '' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.source_url'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', type: 'imei', source_url: 'https://a.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires a day of month for monthly recurrence', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'url', source_url: 'https://a.com', recurring: 'monthly' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.recurring_day_of_month'))).toBe(true)
  })

  it('rejects an invalid hour', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'url', source_url: 'https://a.com', recurring: 'daily', recurring_at: '25' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_hour')).toBe(true)
  })

  it('rejects duplicate names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'edl1', type: 'url', source_url: 'https://a.com' } },
        { name: 'b', fields: { name: 'EDL1', type: 'url', source_url: 'https://b.com' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds REST fields nested under type.<kind>', () => {
    const spec = extractExternalDynamicListSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'ip', source_url: 'https://a.com/ips.txt', recurring: 'daily', recurring_at: '3' } }]).canvas,
    )[0]
    const fields = buildExternalDynamicListFields(spec) as { type: Record<string, unknown> }
    expect(fields.type.ip).toEqual({ url: 'https://a.com/ips.txt', recurring: { daily: { at: '3' } } })
  })

  it('builds the weekly recurring shape', () => {
    const spec = extractExternalDynamicListSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'url', source_url: 'https://a.com', recurring: 'weekly', recurring_day_of_week: 'monday' } }]).canvas,
    )[0]
    expect(buildRecurring(spec)).toEqual({ weekly: { 'day-of-week': 'monday' } })
  })

  it('detects url and recurring drift', () => {
    const spec = extractExternalDynamicListSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', type: 'ip', source_url: 'https://a.com/ips.txt', recurring: 'hourly' } }]).canvas,
    )[0]
    const clean = externalDynamicListDriftDiffs(spec, { '@name': 'x', type: { ip: { url: 'https://a.com/ips.txt', recurring: { hourly: {} } } } })
    expect(clean).toHaveLength(0)
    const drifted = externalDynamicListDriftDiffs(spec, { '@name': 'x', type: { ip: { url: 'https://changed.example.com', recurring: { daily: { at: '3' } } } } })
    expect(drifted.length).toBeGreaterThan(1)
  })
})
