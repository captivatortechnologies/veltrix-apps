import validate, { extractCloudIomRuleSpecs, parseControls } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'crowdstrike-edr',
    customerId: 'cust-1',
    configTypeId: 'cloud-iom-custom-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-iom-custom-rules',
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

function validFields(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'S3 bucket must be encrypted',
    description: 'Flags S3 buckets without default encryption',
    cloudProvider: 'aws',
    resourceType: 'AWS::S3::Bucket',
    severity: 'high',
    logic: 'package crowdstrike\ndeny { true }',
    controls: '[{"authority": "CIS", "code": "2.1.1"}]',
    ...overrides,
  }
}

describe('CrowdStrike Cloud IOM Custom Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid rule configuration', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields() }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: validFields({ name: '' }) }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a name longer than 255 characters', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ name: 'x'.repeat(256) }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects a missing description', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ description: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an unknown cloud provider', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ cloudProvider: 'oracle' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_cloud_provider')).toBe(true)
  })

  it('normalizes cloud provider casing', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ cloudProvider: 'AWS' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('rejects a missing resource type', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ resourceType: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid severity', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ severity: 'urgent' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('requires Rego logic when there is no parent rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ logic: '' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'logic_required')).toBe(true)
  })

  it('allows empty logic when inheriting from a parent rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ logic: '', parentRuleId: 'rule-uuid-1' }) }]),
    )
    expect(result.valid).toBe(true)
  })

  it('warns when logic is set alongside a parent rule', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ parentRuleId: 'rule-uuid-1' }) }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'logic_ignored')).toBe(true)
  })

  it('rejects malformed controls JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ controls: '[{not json' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_controls')).toBe(true)
  })

  it('rejects controls that are not a JSON array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ controls: '{"authority": "CIS"}' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_controls')).toBe(true)
  })

  it('rejects a control missing its code', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: validFields({ controls: '[{"authority": "CIS"}]' }) }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_controls')).toBe(true)
  })

  it('rejects duplicate rule names', async () => {
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

describe('extractCloudIomRuleSpecs', () => {
  it('defaults severity to medium and lowercases the provider', () => {
    const sections = [
      { name: 'sec1', fields: { name: 'R1', cloudProvider: 'AZURE', resourceType: 'Microsoft.Compute/virtualMachines' } },
    ]
    const specs = extractCloudIomRuleSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'crowdstrike-edr',
      entityType: 'cloud-iom-custom-rules',
      items: [],
      sections,
      snapshot: {},
    })
    expect(specs[0].severity).toBe('medium')
    expect(specs[0].cloudProvider).toBe('azure')
    expect(specs[0].name).toBe('R1')
    expect(specs[0].parentRuleId).toBeUndefined()
  })
})

describe('parseControls', () => {
  it('returns an empty list for empty input', () => {
    expect(parseControls('')).toEqual({ controls: [] })
  })

  it('parses a valid controls array', () => {
    const { controls, error } = parseControls('[{"authority": "CIS", "code": "1.1"}]')
    expect(error).toBeUndefined()
    expect(controls).toEqual([{ authority: 'CIS', code: '1.1' }])
  })

  it('reports an error for non-array JSON', () => {
    const { error } = parseControls('{"authority": "CIS"}')
    expect(error).toBeDefined()
    expect(error ?? '').toMatch(/array/)
  })

  it('reports an error for a control missing its code', () => {
    const { error } = parseControls('[{"authority": "CIS"}]')
    expect(error ?? '').toMatch(/authority and code/)
  })
})
