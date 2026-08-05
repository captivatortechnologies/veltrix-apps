import validate, { extractTrustedClusterSpecs, buildTrustedClusterYaml } from '../validate'
import type { CanvasSnapshot, PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'teleport',
    customerId: 'cust-1',
    configTypeId: 'trusted-clusters',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'teleport',
      entityType: 'trusted-clusters',
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
    entityType: 'trusted-clusters',
    items: sections,
    sections,
    snapshot: {},
  }
}

const VALID_SPEC = 'enabled: true\ntoken: shared-secret\ntunnel_addr: leaf.example.com:3024\nweb_proxy_addr: leaf.example.com:443'

describe('Teleport Trusted Clusters Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal trusted cluster', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'leaf-1', version: 'v2', spec: VALID_SPEC } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'sec1', fields: { name: 'leaf-1', version: 'v2', spec: VALID_SPEC } },
        { name: 'sec2', fields: { name: 'leaf-1', version: 'v2', spec: VALID_SPEC } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_cluster')).toBe(true)
  })

  it('warns when the join token is missing', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'leaf-1', version: 'v2', spec: 'enabled: true' } }]),
    )
    expect(result.warnings.some((w) => w.code === 'missing_token')).toBe(true)
  })

  it('rejects an unexpected schema version', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { name: 'leaf-1', version: 'v9', spec: VALID_SPEC } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_version')).toBe(true)
  })
})

describe('extractTrustedClusterSpecs', () => {
  it('defaults version to v2 when blank', () => {
    const specs = extractTrustedClusterSpecs(
      makeCanvas([{ name: 'sec1', fields: { name: 'leaf-1', version: '', spec: VALID_SPEC } }]),
    )
    expect(specs[0].version).toBe('v2')
  })
})

describe('buildTrustedClusterYaml', () => {
  it('wraps the spec into a full trusted_cluster resource document', () => {
    const yaml = buildTrustedClusterYaml({ sectionName: 's', name: 'leaf-1', version: 'v2', spec: 'enabled: true' })
    expect(yaml).toBe('kind: trusted_cluster\nversion: v2\nmetadata:\n  name: leaf-1\nspec:\n  enabled: true\n')
  })
})
