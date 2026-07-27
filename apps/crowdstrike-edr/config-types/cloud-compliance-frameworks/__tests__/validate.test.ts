import validate, { extractFrameworkSpecs, parseSections } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'cloud-compliance-frameworks',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-compliance-frameworks',
      items: [],
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Internal Cloud Baseline',
    description: 'Custom cloud compliance baseline',
    version: '1.0',
    sections: JSON.stringify([{ name: 'Access Control' }, { name: 'Logging' }]),
    ...overrides,
  }
}

describe('CrowdStrike Cloud Compliance Frameworks Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid framework configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing framework name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate framework names per canvas', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a framework name over the max length', async () => {
    const longName = 'a'.repeat(256)
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: longName }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('accepts a framework with no sections field', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ sections: '' }) }]))
    expect(result.valid).toBe(true)
  })

  it('rejects invalid sections JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ sections: '[not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sections')).toBe(true)
  })

  it('rejects a sections value that is not an array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ sections: '{"name":"X"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sections')).toBe(true)
  })

  it('rejects a section entry without a name', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ sections: JSON.stringify([{ title: 'X' }]) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sections')).toBe(true)
  })

  it('rejects duplicate section names within a framework', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: validFields({ sections: JSON.stringify([{ name: 'A' }, { name: 'a' }]) }),
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_sections')).toBe(true)
  })

  it('warns when sections JSON is an empty array', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ sections: '[]' }) }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_sections')).toBe(true)
  })
})

describe('extractFrameworkSpecs', () => {
  it('parses name, description, version and sections', () => {
    const sections = [{ name: 'sec1', fields: validFields() }]
    const specs = extractFrameworkSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-compliance-frameworks',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].name).toBe('Internal Cloud Baseline')
    expect(specs[0].version).toBe('1.0')
    expect(specs[0].sections).toHaveLength(2)
    expect(specs[0].sections[0].name).toBe('Access Control')
  })

  it('leaves version and description undefined when blank', () => {
    const sections = [{ name: 'sec1', fields: { name: 'F', description: '  ', version: '' } }]
    const specs = extractFrameworkSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-compliance-frameworks',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].version).toBeUndefined()
  })
})

describe('parseSections', () => {
  it('returns empty for undefined input', () => {
    expect(parseSections(undefined)).toEqual({ sections: [], errors: [] })
  })

  it('parses a valid array of section objects', () => {
    const { sections, errors } = parseSections(JSON.stringify([{ name: 'One' }, { name: 'Two' }]))
    expect(errors).toHaveLength(0)
    expect(sections).toHaveLength(2)
  })

  it('reports a parse error on malformed JSON', () => {
    const { errors } = parseSections('[bad')
    expect(errors.some((e) => e.includes('not valid JSON'))).toBe(true)
  })
})
