import validate, { extractControlSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'cloud-compliance-controls',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-compliance-controls',
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
    name: 'Encrypt data at rest',
    frameworkId: 'fw-uuid-1',
    section: 'Data Protection',
    description: 'All storage must be encrypted',
    ruleIds: 'rule-1, rule-2',
    ...overrides,
  }
}

describe('CrowdStrike Cloud Compliance Controls Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid control configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing control name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a control without a framework id', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ frameworkId: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'sec1.frameworkId' && e.code === 'required')).toBe(true)
  })

  it('rejects a control without a section', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ section: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field === 'sec1.section' && e.code === 'required')).toBe(true)
  })

  it('rejects a control name over the max length', async () => {
    const longName = 'a'.repeat(256)
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: longName }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'max_length')).toBe(true)
  })

  it('rejects duplicate controls in the same framework and section', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields() },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_control')).toBe(true)
  })

  it('allows the same control name in a different section', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields({ section: 'Logging' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('allows the same control name in a different framework', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: validFields() },
        { name: 'sec2', fields: validFields({ frameworkId: 'fw-uuid-2' }) },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('extractControlSpecs', () => {
  it('parses and de-duplicates assigned rule ids', () => {
    const sections = [{ name: 'sec1', fields: validFields({ ruleIds: 'rule-1, rule-2, rule-1' }) }]
    const specs = extractControlSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-compliance-controls',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].ruleIds).toEqual(['rule-1', 'rule-2'])
    expect(specs[0].frameworkId).toBe('fw-uuid-1')
    expect(specs[0].section).toBe('Data Protection')
  })

  it('parses rule ids from an array value', () => {
    const sections = [{ name: 'sec1', fields: validFields({ ruleIds: ['a', 'b'] }) }]
    const specs = extractControlSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-compliance-controls',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].ruleIds).toEqual(['a', 'b'])
  })

  it('leaves description undefined when blank', () => {
    const sections = [{ name: 'sec1', fields: validFields({ description: '   ' }) }]
    const specs = extractControlSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-compliance-controls',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].description).toBeUndefined()
    expect(specs[0].ruleIds).toHaveLength(2)
  })
})
