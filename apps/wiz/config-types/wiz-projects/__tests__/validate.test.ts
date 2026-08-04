import validate, { extractProjectSpecs, projectKey, readBool, strList, tryParseJson } from '../validate'
import { buildProjectInput, buildProjectOverride } from '../deploy'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'wiz',
    customerId: 'cust-1',
    configTypeId: 'wiz-projects',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'wiz',
      entityType: 'wiz-projects',
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

describe('Wiz Projects Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal valid project', async () => {
    const result = await validate(makeCtx([{ name: 'P1', fields: { name: 'Checkout Service' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires a name', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects an unsupported business impact', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'X', risk_business_impact: 'EXTREME' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_enum_value' && e.field.includes('risk_business_impact'))).toBe(true)
  })

  it('rejects malformed resource links JSON', async () => {
    const result = await validate(makeCtx([{ name: 'p1', fields: { name: 'X', resource_links_json: '[not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('requires resource link arrays to actually be arrays', async () => {
    const result = await validate(
      makeCtx([{ name: 'p1', fields: { name: 'X', resource_links_json: JSON.stringify({ cloudAccountLinks: 'nope' }) } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_links')).toBe(true)
  })

  it('rejects duplicate project names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'Dup Project' } },
        { name: 'b', fields: { name: 'dup project' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_project')).toBe(true)
  })

  it('extractProjectSpecs trims and defaults risk profile', () => {
    const specs = extractProjectSpecs(makeCtx([{ name: 'e', fields: { name: '  Proj X  ' } }]).canvas)
    expect(specs[0].name).toBe('Proj X')
    expect(specs[0].riskProfile.businessImpact).toBe('MBI')
    expect(specs[0].riskProfile.hasAuthentication).toBe('UNKNOWN')
    expect(specs[0].archived).toBe(false)
    expect(projectKey('  Proj X ')).toBe('proj x')
  })

  it('helpers behave as documented', () => {
    expect(readBool(undefined, true)).toBe(true)
    expect(readBool('false', true)).toBe(false)
    expect(strList('a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(tryParseJson('').ok).toBe(true)
    expect(tryParseJson('[bad').ok).toBe(false)
  })
})

describe('Wiz Projects Deploy — request shape', () => {
  it('builds a CreateProjectInput including the generated slug and resource links', () => {
    const ctx = makeCtx([
      {
        name: 'p1',
        fields: {
          name: 'Checkout Service',
          business_unit: 'Commerce',
          resource_links_json: JSON.stringify({ cloudAccountLinks: [{ cloudAccount: 'acct-1', environment: 'PRODUCTION' }] }),
        },
      },
    ])
    const spec = extractProjectSpecs(ctx.canvas)[0]
    const input = buildProjectInput(spec, 'test-slug-123')
    expect(input.name).toBe('Checkout Service')
    expect(input.businessUnit).toBe('Commerce')
    expect(input.slug).toBe('test-slug-123')
    expect(input.cloudAccountLinks).toEqual([{ cloudAccount: 'acct-1', environment: 'PRODUCTION' }])
    expect(input.cloudOrganizationLinks).toEqual([])
    expect(input.kubernetesClusterLinks).toEqual([])
  })

  it('builds an UpdateProjectPatch override that always carries the existing slug', () => {
    const ctx = makeCtx([{ name: 'p1', fields: { name: 'Checkout Service' } }])
    const spec = extractProjectSpecs(ctx.canvas)[0]
    const override = buildProjectOverride(spec, 'existing-slug-abc')
    expect(override.slug).toBe('existing-slug-abc')
    expect(override.name).toBe('Checkout Service')
    // isFolder is create-time only — never part of the update override.
    expect(override.isFolder).toBeUndefined()
  })
})
