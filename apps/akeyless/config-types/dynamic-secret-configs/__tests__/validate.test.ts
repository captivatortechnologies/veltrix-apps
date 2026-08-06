import validate, { extractDynamicSecretSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'dynamic-secret-configs',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
      entityType: 'dynamic-secret-configs',
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

describe('Akeyless Dynamic Secret Configs Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a postgresql producer with a target', async () => {
    const result = await validate(makeCtx([{ name: 'd1', fields: { name: 'pg-readonly', type: 'postgresql', targetName: 'pg-prod' } }]))
    expect(result.valid).toBe(true)
  })

  it('warns (but does not fail) on a postgresql producer with no target and no password', async () => {
    const result = await validate(makeCtx([{ name: 'd1', fields: { name: 'pg-readonly', type: 'postgresql' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'missing_credentials')).toBe(true)
  })

  it('rejects an invalid aws accessMode', async () => {
    const result = await validate(makeCtx([{ name: 'd1', fields: { name: 'aws-1', type: 'aws', accessMode: 'bogus' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.accessMode'))).toBe(true)
  })

  it('requires k8sClusterEndpoint for a k8s producer with no target', async () => {
    const result = await validate(makeCtx([{ name: 'd1', fields: { name: 'k8s-1', type: 'k8s' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.k8sClusterEndpoint'))).toBe(true)
  })

  it('accepts a k8s producer with a target and no endpoint', async () => {
    const result = await validate(makeCtx([{ name: 'd1', fields: { name: 'k8s-1', type: 'k8s', targetName: 'k8s-prod' } }]))
    expect(result.valid).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'd1', fields: { name: 'dup', type: 'aws' } },
        { name: 'd2', fields: { name: 'dup', type: 'aws' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractDynamicSecretSpecs', () => {
  it('defaults userTtl, postgresqlHost/Port, k8sNamespace and accessMode', () => {
    const specs = extractDynamicSecretSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'dynamic-secret-configs',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x', type: 'postgresql' } }],
      snapshot: {},
    })
    expect(specs[0].userTtl).toBe('60m')
    expect(specs[0].postgresqlHost).toBe('127.0.0.1')
    expect(specs[0].postgresqlPort).toBe('5432')
    expect(specs[0].k8sNamespace).toBe('default')
    expect(specs[0].accessMode).toBe('iam_user')
  })
})
