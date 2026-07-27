import validate, { extractSavedQuerySpecs } from '../validate'
import { buildSavedQueryBody, liveShared } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'ngsiem-saved-queries',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-saved-queries',
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

function makeCanvas(sections: Array<{ name: string; fields: Record<string, unknown> }>): CanvasSnapshot {
  return {
    id: 'snap-1',
    canvasId: 'canvas-1',
    version: 1,
    name: 'Test Canvas',
    toolType: 'crowdstrike-edr',
    entityType: 'ngsiem-saved-queries',
    items: [],
    sections,
    snapshot: {},
  }
}

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Failed Logons',
    description: 'Windows failed logon events',
    query: '#event_simpleName=UserLogonFailed | groupBy(ComputerName)',
    timeRange: '24h',
    shared: true,
    ...overrides,
  }
}

describe('CrowdStrike NG-SIEM Saved Queries Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid saved query configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Query', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing CQL query', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ query: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('query'))).toBe(true)
  })

  it('rejects a name over the length limit', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ name: 'a'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects duplicate names per canvas', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('accepts a query with no description or time range', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ description: '', timeRange: '' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })
})

describe('extractSavedQuerySpecs', () => {
  it('parses the managed fields from a section', () => {
    const specs = extractSavedQuerySpecs(
      makeCanvas([{ name: 'sec1', fields: validFields() }]),
    )
    expect(specs).toHaveLength(1)
    expect(specs[0].name).toBe('Failed Logons')
    expect(specs[0].query).toBe('#event_simpleName=UserLogonFailed | groupBy(ComputerName)')
    expect(specs[0].timeRange).toBe('24h')
    expect(specs[0].shared).toBe(true)
  })

  it('treats a string "false" shared flag as not shared', () => {
    const specs = extractSavedQuerySpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ shared: 'false' }) }]),
    )
    expect(specs[0].shared).toBe(false)
  })

  it('defaults shared to false when the field is absent', () => {
    const specs = extractSavedQuerySpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'Q', query: 'x' } }]),
    )
    expect(specs[0].shared).toBe(false)
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].timeRange).toBeUndefined()
  })
})

describe('buildSavedQueryBody', () => {
  it('assembles the managed create/update body', () => {
    const [spec] = extractSavedQuerySpecs(makeCanvas([{ name: 'sec1', fields: validFields() }]))
    const body = buildSavedQueryBody(spec)
    expect(body.name).toBe('Failed Logons')
    expect(body.query).toBe('#event_simpleName=UserLogonFailed | groupBy(ComputerName)')
    expect(body.time_range).toBe('24h')
    expect(body.shared).toBe(true)
    expect(body.description).toBe('Windows failed logon events')
  })

  it('omits optional fields when unset', () => {
    const [spec] = extractSavedQuerySpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ description: '', timeRange: '' }) }]),
    )
    const body = buildSavedQueryBody(spec)
    expect(body.description).toBeUndefined()
    expect(body.time_range).toBeUndefined()
    expect(body.name).toBe('Failed Logons')
  })
})

describe('liveShared', () => {
  it('reads the canonical shared flag', () => {
    expect(liveShared({ shared: true })).toBe(true)
  })
  it('falls back to is_shared', () => {
    expect(liveShared({ is_shared: true })).toBe(true)
  })
  it('defaults to false when neither flag is present', () => {
    expect(liveShared({})).toBe(false)
  })
})
