import validate, { extractScheduleSpecs, scheduleKey, parseScheduleObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'rapid7',
    customerId: 'cust-1',
    configTypeId: 'insightvm-scan-schedules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'rapid7',
      entityType: 'insightvm-scan-schedules',
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

const SCHED = '{"start":"2026-08-01T02:00:00Z","duration":"PT8H"}'

describe('InsightVM Scan Schedules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid schedule', async () => {
    const result = await validate(makeCtx([{ name: 'Scan Schedule', fields: { site_name: 'Prod', schedule_name: 'Nightly', schedule_json: SCHED } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing site/schedule name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { schedule_json: SCHED } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('site_name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('schedule_name'))).toBe(true)
  })

  it('requires schedule_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { site_name: 'Prod', schedule_name: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('schedule_json'))).toBe(true)
  })

  it('rejects invalid schedule_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { site_name: 'Prod', schedule_name: 'x', schedule_json: 'not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate (site,schedule)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { site_name: 'Prod', schedule_name: 'Nightly', schedule_json: SCHED } },
        { name: 'b', fields: { site_name: 'prod', schedule_name: 'Nightly', schedule_json: SCHED } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_schedule')).toBe(true)
  })

  it('extract + helpers behave', () => {
    expect(parseScheduleObject('').error).toBe('is required')
    expect(parseScheduleObject('{"a":1}').value).toEqual({ a: 1 })
    const specs = extractScheduleSpecs(makeCtx([{ name: 's', fields: { site_name: '  Prod  ', schedule_name: 'Nightly', schedule_json: SCHED } }]).canvas)
    expect(specs[0].siteName).toBe('Prod')
    expect(specs[0].enabled).toBe(true)
    expect(scheduleKey(specs[0])).toBe(scheduleKey({ siteName: 'prod', scheduleName: 'Nightly' }))
  })
})
