import validate, {
  extractDashboardSpecs,
  parseDefinition,
  stableStringify,
} from '../validate'
import { buildDashboardBody, liveShared } from '../deploy'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'ngsiem-dashboards',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'ngsiem-dashboards',
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
    entityType: 'ngsiem-dashboards',
    items: [],
    sections,
    snapshot: {},
  }
}

const DEFINITION = JSON.stringify({
  widgets: [{ title: 'Top Hosts', query: '#event_simpleName=ProcessRollup2 | groupBy(ComputerName)', type: 'bar' }],
  layout: { columns: 12 },
})

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Threat Overview',
    description: 'Key detection widgets',
    definition: DEFINITION,
    shared: true,
    ...overrides,
  }
}

describe('CrowdStrike NG-SIEM Dashboards Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid dashboard configuration', async () => {
    const result = await validate(makeCtx([{ name: 'Dashboard', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing definition', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ definition: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('definition'))).toBe(true)
  })

  it('rejects a definition that is not valid JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ definition: '{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_definition')).toBe(true)
  })

  it('rejects a definition that is a JSON array rather than an object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ definition: '[1,2,3]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_definition')).toBe(true)
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
})

describe('parseDefinition', () => {
  it('parses a JSON object definition', () => {
    const { value, error } = parseDefinition(DEFINITION)
    expect(error).toBeUndefined()
    expect(value).toBeDefined()
    expect(Array.isArray(value?.widgets)).toBe(true)
  })

  it('returns an error for malformed JSON', () => {
    const { error } = parseDefinition('{not json')
    expect(error).toBeDefined()
    expect(error).toMatch(/JSON/)
  })

  it('returns an error for a non-object JSON value', () => {
    const { error } = parseDefinition('"just a string"')
    expect(error).toBeDefined()
    expect(error).toMatch(/object/)
  })

  it('returns an empty result for empty input', () => {
    expect(parseDefinition('')).toEqual({})
  })
})

describe('stableStringify', () => {
  it('produces identical output regardless of object key order', () => {
    const a = stableStringify({ b: 1, a: 2, nested: { y: 1, x: 2 } })
    const b = stableStringify({ a: 2, nested: { x: 2, y: 1 }, b: 1 })
    expect(a).toBe(b)
  })

  it('preserves array order (significant for widget layout)', () => {
    const a = stableStringify({ widgets: [{ id: 1 }, { id: 2 }] })
    const b = stableStringify({ widgets: [{ id: 2 }, { id: 1 }] })
    expect(a === b).toBe(false)
  })
})

describe('extractDashboardSpecs', () => {
  it('parses the managed fields from a section', () => {
    const specs = extractDashboardSpecs(makeCanvas([{ name: 'sec1', fields: validFields() }]))
    expect(specs).toHaveLength(1)
    expect(specs[0].name).toBe('Threat Overview')
    expect(specs[0].definitionRaw).toBe(DEFINITION)
    expect(specs[0].shared).toBe(true)
  })

  it('defaults shared to false when the field is absent', () => {
    const specs = extractDashboardSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'D', definition: DEFINITION } }]),
    )
    expect(specs[0].shared).toBe(false)
    expect(specs[0].description).toBeUndefined()
  })
})

describe('buildDashboardBody', () => {
  it('assembles the managed create/update body with a parsed definition', () => {
    const [spec] = extractDashboardSpecs(makeCanvas([{ name: 'sec1', fields: validFields() }]))
    const body = buildDashboardBody(spec)
    expect(body.name).toBe('Threat Overview')
    expect(body.shared).toBe(true)
    expect(body.description).toBe('Key detection widgets')
    expect(stableStringify(body.definition)).toBe(stableStringify(JSON.parse(DEFINITION)))
  })

  it('omits the description when unset', () => {
    const [spec] = extractDashboardSpecs(
      makeCanvas([{ name: 'sec1', fields: validFields({ description: '' }) }]),
    )
    const body = buildDashboardBody(spec)
    expect(body.description).toBeUndefined()
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
