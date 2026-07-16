import validate, { extractScheduleSpecs, scheduleKey, parseScheduleObject } from '../validate'
import { buildCreateParams, buildUpdateParams, parseScheduleBlock, normalizeTitleCsv } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

const WEEKLY =
  '{"occurrence":"weekly","frequency_weeks":1,"weekdays":"1","start_date":"08/01/2026","start_hour":2,"start_minute":0,"time_zone_code":"US-CA"}'

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'qualys',
    customerId: 'cust-1',
    configTypeId: 'qualys-scan-schedules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'qualys',
      entityType: 'qualys-scan-schedules',
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

describe('Qualys Scan Schedules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid weekly schedule', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Sched',
          fields: {
            scan_title: 'Weekly Prod',
            option_title: 'Initial Options',
            asset_group_titles: 'Prod Web, Prod DB',
            active: true,
            schedule_json: WEEKLY,
          },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('rejects missing scan title and option title', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { schedule_json: WEEKLY } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('scan_title'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('option_title'))).toBe(true)
  })

  it('requires schedule_json', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { scan_title: 'x', option_title: 'o' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('schedule_json'))).toBe(true)
  })

  it('rejects schedule_json without an occurrence', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { scan_title: 'x', option_title: 'o', schedule_json: '{"start_hour":2}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('schedule_json'))).toBe(true)
  })

  it('rejects an unsupported occurrence', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { scan_title: 'x', option_title: 'o', schedule_json: '{"occurrence":"hourly"}' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_occurrence')).toBe(true)
  })

  it('rejects a nested (non-flat) schedule_json', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { scan_title: 'x', option_title: 'o', schedule_json: '{"occurrence":"daily","nested":{"a":1}}' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('warns when no target is set', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { scan_title: 'x', option_title: 'o', schedule_json: '{"occurrence":"daily","frequency_days":1}' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_target')).toBe(true)
  })

  it('does not warn when the target is inside schedule_json', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { scan_title: 'x', option_title: 'o', schedule_json: '{"occurrence":"daily","ip":"10.0.0.0/24"}' },
        },
      ]),
    )
    expect(result.warnings.some((w) => w.code === 'no_target')).toBe(false)
  })

  it('rejects duplicate scan titles case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { scan_title: 'Nightly', option_title: 'o', schedule_json: WEEKLY } },
        { name: 'b', fields: { scan_title: 'nightly', option_title: 'o', schedule_json: WEEKLY } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_schedule')).toBe(true)
  })

  it('parseScheduleObject flattens scalars and flags nesting', () => {
    expect(parseScheduleObject('  ').error).toBe('is required')
    expect(parseScheduleObject('[1,2]').error).toBe('must be a JSON object')
    expect(parseScheduleObject('{"a":{"b":1}}').error).toContain('flat object')
    expect(parseScheduleObject('{"occurrence":"daily"}').value).toEqual({ occurrence: 'daily' })
  })

  it('build params flatten schedule json and set the asset-group target', () => {
    const spec = extractScheduleSpecs(
      makeCtx([
        {
          name: 't',
          fields: {
            scan_title: 'Weekly Prod',
            option_title: 'Initial Options',
            asset_group_titles: 'Prod Web , Prod DB',
            active: false,
            schedule_json: WEEKLY,
          },
        },
      ]).canvas,
    )[0]
    expect(scheduleKey(spec)).toBe(scheduleKey({ scanTitle: 'weekly prod' }))

    const create = buildCreateParams(spec)
    expect(create.action).toBe('create')
    expect(create.scan_title).toBe('Weekly Prod')
    expect(create.option_title).toBe('Initial Options')
    expect(create.active).toBe(0)
    expect(create.asset_groups).toBe('Prod Web,Prod DB')
    expect(create.target_from).toBe('assets')
    expect(create.occurrence).toBe('weekly')
    expect(create.frequency_weeks).toBe(1)
    expect(create.time_zone_code).toBe('US-CA')

    const update = buildUpdateParams(spec, '999')
    expect(update.action).toBe('update')
    expect(update.id).toBe('999')
  })

  it('normalizeTitleCsv splits on commas only (titles may contain spaces)', () => {
    expect(normalizeTitleCsv('Prod Web, Prod DB ,')).toBe('Prod Web,Prod DB')
  })

  it('parseScheduleBlock reads id/title/active/option profile', () => {
    const block =
      '<ID>555</ID><TITLE>Weekly Prod</TITLE><ACTIVE>1</ACTIVE>' +
      '<OPTION_PROFILE><TITLE>Initial Options</TITLE><DEFAULT_FLAG>1</DEFAULT_FLAG></OPTION_PROFILE>'
    const s = parseScheduleBlock(block)
    expect(s.id).toBe('555')
    expect(s.title).toBe('Weekly Prod')
    expect(s.active).toBe(true)
    expect(s.optionProfileTitle).toBe('Initial Options')
  })
})
