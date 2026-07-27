import validate, {
  extractScheduledTaskSpecs,
  parseSchedule,
  flattenSchedule,
  readLiveGroupIds,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'it-automation-scheduled-tasks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'it-automation-scheduled-tasks',
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

function validScheduledFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Nightly Inventory',
    taskId: 'task-abc-123',
    enabled: true,
    timezone: 'UTC',
    schedule: JSON.stringify({ frequency: 'Daily', interval: 1, time: '02:00' }),
    ...overrides,
  }
}

describe('CrowdStrike IT Automation Scheduled Tasks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid scheduled task configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Sched', fields: validScheduledFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScheduledFields({ name: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects missing task id', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScheduledFields({ taskId: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('taskId'))).toBe(true)
  })

  it('rejects duplicate task ids across sections', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validScheduledFields({ name: 'A' }) },
        { name: 'sec2', fields: validScheduledFields({ name: 'B' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_task_id')).toBe(true)
  })

  it('requires a schedule', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScheduledFields({ schedule: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('schedule'))).toBe(true)
  })

  it('rejects invalid schedule JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScheduledFields({ schedule: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_schedule')).toBe(true)
  })

  it('rejects an unknown frequency', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validScheduledFields({ schedule: JSON.stringify({ frequency: 'Hourly' }) }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_schedule')).toBe(true)
  })

  it('warns that host groups are captured but not pushed', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validScheduledFields({ hostGroups: 'g1' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'host_groups_not_pushed')).toBe(true)
  })
})

describe('parseSchedule', () => {
  it('parses a valid recurrence and merges the timezone field', () => {
    const { schedule, errors } = parseSchedule(
      JSON.stringify({ frequency: 'Weekly', interval: 2, days_of_week: ['Monday'] }),
      'America/New_York',
    )
    expect(errors).toHaveLength(0)
    expect(schedule).toBeDefined()
    expect(schedule?.timezone).toBe('America/New_York')
  })

  it('does not override a timezone already in the schedule', () => {
    const { schedule } = parseSchedule(
      JSON.stringify({ frequency: 'Daily', timezone: 'UTC' }),
      'America/New_York',
    )
    expect(schedule?.timezone).toBe('UTC')
  })

  it('rejects a day_of_month outside 1-31', () => {
    const { errors } = parseSchedule(JSON.stringify({ frequency: 'Monthly', day_of_month: 40 }))
    expect(errors.some((e) => e.includes('day_of_month'))).toBe(true)
  })

  it('warns on unknown schedule keys', () => {
    const { warnings } = parseSchedule(JSON.stringify({ frequency: 'Daily', cron: '* * * * *' }))
    expect(warnings.some((w) => w.includes('Unknown schedule key'))).toBe(true)
  })

  it('returns empty for empty input', () => {
    expect(parseSchedule('')).toEqual({ errors: [], warnings: [] })
  })
})

describe('flattenSchedule / readLiveGroupIds', () => {
  it('flattens schedule keys to dot paths', () => {
    const flat = flattenSchedule({ frequency: 'Daily', interval: 1 })
    expect(flat.get('frequency')).toBe('"Daily"')
    expect(flat.get('interval')).toBe('1')
  })

  it('reads live group ids when present', () => {
    expect(readLiveGroupIds({ group_ids: ['g1', 'g2'] })).toEqual(['g1', 'g2'])
  })

  it('returns undefined when group_ids is absent', () => {
    expect(readLiveGroupIds({})).toBeUndefined()
  })
})

describe('extractScheduledTaskSpecs', () => {
  it('parses task id, host groups, and enablement', () => {
    const specs = extractScheduledTaskSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'it-automation-scheduled-tasks',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', taskId: 't-1', hostGroups: 'g1, g2' } }],
      snapshot: {},
    })
    expect(specs[0].taskId).toBe('t-1')
    expect(specs[0].hostGroups).toEqual(['g1', 'g2'])
    expect(specs[0].enabled).toBe(false)
  })
})
