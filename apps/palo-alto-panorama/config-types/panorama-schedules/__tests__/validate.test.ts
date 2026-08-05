import validate, {
  extractScheduleSpecs,
  buildScheduleType,
  scheduleDriftDiffs,
  readKeyValueMap,
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
    configTypeId: 'panorama-schedules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-schedules',
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

describe('Panorama Schedules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal daily schedule', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'business-hours', schedule_kind: 'daily', daily_ranges: ['09:00-17:00'] } }]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a weekly schedule with only some days set', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r',
          fields: {
            name: 'weekday-hours',
            schedule_kind: 'weekly',
            weekly_ranges: { monday: '08:00-12:00,13:00-17:00', friday: '08:00-14:00' },
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('validates a non-recurring schedule', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'r',
          fields: { name: 'holiday-freeze', schedule_kind: 'non_recurring', non_recurring_ranges: ['2025/12/24@00:00-2025/12/26@23:59'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an unsupported kind', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', schedule_kind: 'monthly' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_kind')).toBe(true)
  })

  it('rejects a malformed daily range', async () => {
    const result = await validate(
      makeCtx([{ name: 'r', fields: { name: 'x', schedule_kind: 'daily', daily_ranges: ['9am-5pm'] } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_range')).toBe(true)
  })

  it('requires at least one day for a weekly schedule', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', schedule_kind: 'weekly', weekly_ranges: {} } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.weekly_ranges'))).toBe(true)
  })

  it('rejects duplicate schedule names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'sched1', schedule_kind: 'daily', daily_ranges: ['09:00-17:00'] } },
        { name: 'b', fields: { name: 'SCHED1', schedule_kind: 'daily', daily_ranges: ['10:00-18:00'] } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate')).toBe(true)
  })

  it('builds the daily schedule-type shape', () => {
    const spec = extractScheduleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', schedule_kind: 'daily', daily_ranges: ['09:00-17:00'] } }]).canvas,
    )[0]
    expect(buildScheduleType(spec)).toEqual({ recurring: { daily: { member: ['09:00-17:00'] } } })
  })

  it('builds the weekly schedule-type shape, omitting empty days', () => {
    const spec = extractScheduleSpecs(
      makeCtx([
        { name: 'r', fields: { name: 'x', schedule_kind: 'weekly', weekly_ranges: { monday: '08:00-12:00,13:00-17:00' } } },
      ]).canvas,
    )[0]
    expect(buildScheduleType(spec)).toEqual({ recurring: { weekly: { monday: { member: ['08:00-12:00', '13:00-17:00'] } } } })
  })

  it('builds the non-recurring schedule-type shape', () => {
    const spec = extractScheduleSpecs(
      makeCtx([
        { name: 'r', fields: { name: 'x', schedule_kind: 'non_recurring', non_recurring_ranges: ['2025/01/01@00:00-2025/01/31@23:59'] } },
      ]).canvas,
    )[0]
    expect(buildScheduleType(spec)).toEqual({ 'non-recurring': { member: ['2025/01/01@00:00-2025/01/31@23:59'] } })
  })

  it('reads a keyvalue field given either shape', () => {
    expect(readKeyValueMap({ monday: '08:00-12:00' })).toEqual({ monday: '08:00-12:00' })
    expect(readKeyValueMap([{ key: 'monday', value: '08:00-12:00' }])).toEqual({ monday: '08:00-12:00' })
    expect(readKeyValueMap(undefined)).toEqual({})
  })

  it('detects schedule drift', () => {
    const spec = extractScheduleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'x', schedule_kind: 'daily', daily_ranges: ['09:00-17:00'] } }]).canvas,
    )[0]
    const clean = scheduleDriftDiffs(spec, { '@name': 'x', 'schedule-type': { recurring: { daily: { member: ['09:00-17:00'] } } } })
    expect(clean).toHaveLength(0)
    const drifted = scheduleDriftDiffs(spec, { '@name': 'x', 'schedule-type': { recurring: { daily: { member: ['10:00-18:00'] } } } })
    expect(drifted).toHaveLength(1)
  })
})
