import validate, { extractExclusionSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'tenable-vm',
    customerId: 'cust-1',
    configTypeId: 'exclusions',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'tenable-vm',
      entityType: 'exclusions',
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

/** A fully valid enabled weekly exclusion, overridable per test. */
function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Blackout - Prod DB',
    members: '10.0.0.0/8, 192.168.0.0/16',
    enabled: true,
    starttime: '2026-01-01 08:00:00',
    endtime: '2026-01-01 17:00:00',
    timezone: 'Etc/UTC',
    freq: 'WEEKLY',
    interval: 1,
    byweekday: ['MO', 'TU', 'WE', 'TH', 'FR'],
    ...overrides,
  }
}

describe('Tenable Exclusions Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid enabled exclusion', async () => {
    const result = await validate(makeCtx([{ name: 'Excl', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'Excl', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('requires members for an enabled exclusion', async () => {
    const result = await validate(makeCtx([{ name: 'Excl', fields: validFields({ members: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('members'))).toBe(true)
  })

  it('rejects a malformed datetime', async () => {
    const result = await validate(
      makeCtx([{ name: 'Excl', fields: validFields({ starttime: '2026-01-01T08:00:00' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_datetime')).toBe(true)
  })

  it('rejects an endtime that is not after the starttime', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Excl',
          fields: validFields({ starttime: '2026-01-01 17:00:00', endtime: '2026-01-01 08:00:00' }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_range')).toBe(true)
  })

  it('rejects an unknown frequency', async () => {
    const result = await validate(makeCtx([{ name: 'Excl', fields: validFields({ freq: 'HOURLY' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_freq')).toBe(true)
  })

  it('rejects invalid byweekday tokens', async () => {
    const result = await validate(
      makeCtx([{ name: 'Excl', fields: validFields({ byweekday: ['MO', 'FUNDAY'] }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_weekday')).toBe(true)
  })

  it('rejects an out-of-range interval', async () => {
    const result = await validate(makeCtx([{ name: 'Excl', fields: validFields({ interval: 0 }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_interval')).toBe(true)
  })

  it('rejects an out-of-range day of month', async () => {
    const result = await validate(
      makeCtx([{ name: 'Excl', fields: validFields({ freq: 'MONTHLY', bymonthday: 32 }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_monthday')).toBe(true)
  })

  it('accepts a disabled ("Always On") exclusion with no schedule times', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Excl',
          fields: { name: 'Always On - Legacy', members: '10.0.0.0/8', enabled: false },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects duplicate exclusion names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields({ name: 'Blackout' }) },
        { name: 'sec2', fields: validFields({ name: 'blackout' }) },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractExclusionSpecs', () => {
  it('normalizes members (newlines/commas -> comma string) and weekday tags', () => {
    const sections = [
      {
        name: 'sec1',
        fields: {
          name: '  Blackout  ',
          members: '10.0.0.1\n 10.0.0.2 ,10.0.0.3',
          enabled: true,
          byweekday: [' mo ', 'tu'],
          interval: '2',
          description: '   ',
        },
      },
    ]
    const specs = extractExclusionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'exclusions',
      items: sections,
      sections,
      snapshot: {},
    })
    expect(specs[0].name).toBe('Blackout')
    expect(specs[0].members).toBe('10.0.0.1,10.0.0.2,10.0.0.3')
    expect(specs[0].byweekday).toBe('MO,TU')
    expect(specs[0].interval).toBe(2)
    expect(specs[0].description).toBeUndefined()
  })

  it('defaults enabled to true when the checkbox is unset', () => {
    const sections = [{ name: 'sec1', fields: { name: 'x', members: '1.2.3.4' } }]
    const specs = extractExclusionSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'tenable-vm',
      entityType: 'exclusions',
      items: sections,
      sections,
      snapshot: {},
    })
    expect(specs[0].enabled).toBe(true)
  })
})
