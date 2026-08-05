import validate, { extractDiscoveryConfigSpecs, parseMatcherJson } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'teleport',
    customerId: 'cust-1',
    configTypeId: 'discovery-config',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'teleport',
      entityType: 'discovery-config',
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
    id: 's',
    canvasId: 'c',
    version: 1,
    name: 'n',
    toolType: 'teleport',
    entityType: 'discovery-config',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_AWS_MATCHERS = '[{"types": ["rds"], "regions": ["us-east-1"], "tags": {"env": ["prod"]}}]'

describe('Teleport Discovery Config Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal config with AWS matchers', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'aws-discovery', discoveryGroup: 'prod', awsMatchersJson: VALID_AWS_MATCHERS } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a config with no matchers at all', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'aws-discovery', discoveryGroup: 'prod' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'no_matchers')).toBe(true)
  })

  it('rejects malformed matcher JSON', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'aws-discovery', discoveryGroup: 'prod', awsMatchersJson: '{not json' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_matchers_json')).toBe(true)
  })

  it('rejects matcher JSON that is not an array', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'aws-discovery', discoveryGroup: 'prod', awsMatchersJson: '{"types": ["rds"]}' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_matchers_json')).toBe(true)
  })

  it('rejects a missing discovery group', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'aws-discovery', awsMatchersJson: VALID_AWS_MATCHERS } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('discoveryGroup'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'aws-discovery', discoveryGroup: 'prod', awsMatchersJson: VALID_AWS_MATCHERS } },
        { name: 'sec2', fields: { name: 'aws-discovery', discoveryGroup: 'prod', awsMatchersJson: VALID_AWS_MATCHERS } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_config')).toBe(true)
  })

  it('accepts a config using only Kubernetes matchers', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'sec1',
          fields: { name: 'kube-discovery', discoveryGroup: 'prod', kubeMatchersJson: '[{"types": ["app"], "namespaces": ["*"]}]' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })
})

describe('parseMatcherJson', () => {
  it('treats blank input as an empty array', () => {
    expect(parseMatcherJson('   ')).toEqual({ ok: true, value: [] })
  })

  it('parses a valid JSON array', () => {
    const result = parseMatcherJson(VALID_AWS_MATCHERS)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).toHaveLength(1)
  })
})

describe('extractDiscoveryConfigSpecs', () => {
  it('trims all string fields', () => {
    const specs = extractDiscoveryConfigSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: '  aws-discovery  ', discoveryGroup: '  prod  ' } }]),
    )
    expect(specs[0].name).toBe('aws-discovery')
    expect(specs[0].discoveryGroup).toBe('prod')
  })
})
