import validate, { extractK8sAuthConfigSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'akeyless',
    customerId: 'cust-1',
    configTypeId: 'k8s-auth-config',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'akeyless',
      entityType: 'k8s-auth-config',
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

describe('Akeyless K8s Auth Config Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a fully-specified config', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'c1',
          fields: { name: 'prod-cluster', accessId: 'p-abc123', signingKey: 'base64key', k8sHost: 'https://k8s.example.com' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
  })

  it('requires accessId, signingKey and k8sHost', async () => {
    const result = await validate(makeCtx([{ name: 'c1', fields: { name: 'prod-cluster' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.accessId'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.signingKey'))).toBe(true)
    expect(result.errors.some((e) => e.field.endsWith('.k8sHost'))).toBe(true)
  })

  it('rejects an invalid clusterApiType', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'c1',
          fields: { name: 'x', accessId: 'p-1', signingKey: 'k', k8sHost: 'https://x', clusterApiType: 'openshift' },
        },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.endsWith('.clusterApiType'))).toBe(true)
  })

  it('rejects a duplicate name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'c1', fields: { name: 'dup', accessId: 'p-1', signingKey: 'k', k8sHost: 'https://x' } },
        { name: 'c2', fields: { name: 'dup', accessId: 'p-1', signingKey: 'k', k8sHost: 'https://x' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractK8sAuthConfigSpecs', () => {
  it('defaults tokenExp, k8sIssuer, clusterApiType and k8sAuthType', () => {
    const specs = extractK8sAuthConfigSpecs({
      id: 's',
      canvasId: 'c',
      version: 1,
      name: 'n',
      toolType: 'akeyless',
      entityType: 'k8s-auth-config',
      items: [],
      sections: [{ name: 'sec1', fields: { name: 'x' } }],
      snapshot: {},
    })
    expect(specs[0].tokenExp).toBe('300')
    expect(specs[0].k8sIssuer).toBe('kubernetes/serviceaccount')
    expect(specs[0].clusterApiType).toBe('native_k8s')
    expect(specs[0].k8sAuthType).toBe('token')
  })
})
