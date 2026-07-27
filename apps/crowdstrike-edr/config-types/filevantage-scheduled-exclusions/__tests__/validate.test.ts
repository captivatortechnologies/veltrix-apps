import validate, {
  extractScheduledExclusionSpecs,
  scopeString,
} from '../validate'
import { buildExclusionBody, buildRepeated } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCanvas(
  sections: Array<{ name: string; fields: Record<string, unknown> }>,
): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'crowdstrike-edr',
    entityType: 'filevantage-scheduled-exclusions',
    items: [],
    sections,
    snapshot: {},
  }
}

function makeCtx(
  sections: Array<{ name: string; fields: Record<string, unknown> }>,
): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'filevantage-scheduled-exclusions',
    canvas: makeCanvas(sections),
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Backup Window',
    policyId: 'policy-123',
    timezone: 'UTC',
    scheduleStart: '2026-08-01T00:00:00Z',
    scheduleEnd: '2026-08-08T00:00:00Z',
    recurrence: 'never',
    processes: 'C:\\backup\\agent.exe',
    users: '',
    ...overrides,
  }
}

describe('CrowdStrike FileVantage Scheduled Exclusions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid scheduled exclusion', async () => {
    const result = await validate(makeCtx([{ name: 'Exclusion', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects a missing policy id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ policyId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('policyId'))).toBe(
      true,
    )
  })

  it('rejects duplicate names within the same policy', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_exclusion')).toBe(true)
  })

  it('allows the same name in different policies', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ policyId: 'policy-a' }) },
        { name: 'sec2', fields: validFields({ policyId: 'policy-b' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a malformed schedule start', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ scheduleStart: '2026-08-01' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_format')).toBe(true)
  })

  it('rejects a schedule end that is not after the start', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({
            scheduleStart: '2026-08-08T00:00:00Z',
            scheduleEnd: '2026-08-01T00:00:00Z',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'end_before_start')).toBe(true)
  })

  it('allows an open-ended window (no schedule end)', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ scheduleEnd: '' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires weekly days for a weekly recurrence', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ recurrence: 'weekly', weeklyDays: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('weeklyDays') && e.code === 'required')).toBe(
      true,
    )
  })

  it('rejects an unknown weekday', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ recurrence: 'weekly', weeklyDays: 'monday, funday' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_weekday')).toBe(true)
  })

  it('accepts a valid weekly recurrence', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({ recurrence: 'weekly', weeklyDays: 'Monday, Wednesday' }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires monthly days for a monthly recurrence', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ recurrence: 'monthly', monthlyDays: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('monthlyDays') && e.code === 'required')).toBe(
      true,
    )
  })

  it('rejects an out-of-range day of the month', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ recurrence: 'monthly', monthlyDays: '1, 32' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_monthly_day')).toBe(true)
  })

  it('requires start/end times for a non-all-day recurrence', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({ recurrence: 'daily', allDay: false, startTime: '', endTime: '' }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a recurrence end time that is not after the start time', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({
            recurrence: 'daily',
            allDay: false,
            startTime: '22:00',
            endTime: '06:00',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'end_before_start')).toBe(true)
  })

  it('accepts a valid non-all-day daily recurrence', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({
            recurrence: 'daily',
            allDay: false,
            startTime: '22:00',
            endTime: '23:30',
          }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects an exclusion with no process or user scope', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ processes: '', users: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'empty_scope')).toBe(true)
  })

  it('accepts a users-only scope', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ processes: '', users: 'DOMAIN\\svc' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a processes list over the 500-character limit', async () => {
    const long = Array.from({ length: 30 }, (_, i) => `C:\\a\\process-number-${i}.exe`).join(', ')
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ processes: long }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('warns on a wildcard scope', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ processes: '*' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'broad_scope')).toBe(true)
  })

  it('warns on an unbounded all-day recurring exclusion', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({ recurrence: 'daily', allDay: true, scheduleEnd: '' }),
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'unbounded_exclusion')).toBe(true)
  })
})

describe('extractScheduledExclusionSpecs', () => {
  it('parses scope lists and defaults timezone and allDay', () => {
    const specs = extractScheduledExclusionSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: 'Win',
            policyId: 'p1',
            scheduleStart: '2026-08-01T00:00:00Z',
            processes: 'a.exe, b.exe',
            users: 'svc1\nsvc2',
          },
        },
      ]),
    )
    expect(specs[0].timezone).toBe('UTC')
    expect(specs[0].allDay).toBe(true)
    expect(specs[0].processes).toEqual(['a.exe', 'b.exe'])
    expect(specs[0].users).toEqual(['svc1', 'svc2'])
    expect(specs[0].recurrence).toBe('never')
  })

  it('lowercases weekday names and coerces recurrence', () => {
    const specs = extractScheduledExclusionSpecs(
      makeCanvas([
        {
          name: 'sec1',
          fields: {
            name: 'Win',
            policyId: 'p1',
            scheduleStart: '2026-08-01T00:00:00Z',
            recurrence: 'WEEKLY',
            weeklyDays: 'Monday, Friday',
            processes: 'a.exe',
          },
        },
      ]),
    )
    expect(specs[0].recurrence).toBe('weekly')
    expect(specs[0].weeklyDays).toEqual(['monday', 'friday'])
  })
})

describe('scopeString', () => {
  it('joins list values with commas for the API', () => {
    expect(scopeString(['a.exe', 'b.exe'])).toBe('a.exe,b.exe')
    expect(scopeString([])).toBe('')
  })
})

describe('buildExclusionBody', () => {
  function specFrom(fields: Record<string, unknown>) {
    return extractScheduledExclusionSpecs(makeCanvas([{ name: 'sec1', fields }]))[0]
  }

  it('carries policy_id, schedule_start, timezone, and comma-joined scope', () => {
    const body = buildExclusionBody(specFrom(validFields()))
    expect(body.policy_id).toBe('policy-123')
    expect(body.schedule_start).toBe('2026-08-01T00:00:00Z')
    expect(body.timezone).toBe('UTC')
    expect(body.processes).toBe('C:\\backup\\agent.exe')
    expect(body.name).toBe('Backup Window')
  })

  it('omits the repeated object for a non-recurring exclusion', () => {
    const body = buildExclusionBody(specFrom(validFields({ recurrence: 'never' })))
    expect(body.repeated).toBeUndefined()
  })

  it('builds a weekly repeated object with lowercase weekly_days', () => {
    const body = buildExclusionBody(
      specFrom(validFields({ recurrence: 'weekly', weeklyDays: 'Monday, Tuesday' })),
    )
    const repeated = body.repeated as Record<string, unknown>
    expect(repeated).toBeDefined()
    expect(repeated.frequency).toBe('weekly')
    expect(repeated.all_day).toBe(true)
    expect(repeated.weekly_days).toEqual(['monday', 'tuesday'])
  })

  it('converts monthly days to integers in the repeated object', () => {
    const repeated = buildRepeated(
      specFrom(validFields({ recurrence: 'monthly', monthlyDays: '1, 15' })),
    )
    expect(repeated.monthly_days).toEqual([1, 15])
  })

  it('includes start/end times only for a non-all-day recurrence', () => {
    const repeated = buildRepeated(
      specFrom(
        validFields({ recurrence: 'daily', allDay: false, startTime: '22:00', endTime: '23:00' }),
      ),
    )
    expect(repeated.start_time).toBe('22:00')
    expect(repeated.end_time).toBe('23:00')
  })
})
