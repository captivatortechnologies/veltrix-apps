import validate, { extractServiceTokenSpecs, serviceTokenKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-access-service-tokens',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-access-service-tokens',
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

describe('Cloudflare Access Service Tokens Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid token with just a name', async () => {
    const result = await validate(makeCtx([{ name: 'Service Token', fields: { name: 'ci-deploy' } }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('validates a valid token with an optional duration', async () => {
    const result = await validate(
      makeCtx([{ name: 'Service Token', fields: { name: 'ci-deploy', duration: '8760h' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { duration: '8760h' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects duplicate names case-insensitively', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'ci-deploy' } },
        { name: 'b', fields: { name: 'CI-Deploy' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_service_token')).toBe(true)
  })

  it('allows distinct token names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'ci-deploy' } },
        { name: 'b', fields: { name: 'monitoring' } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('serviceTokenKey folds name case and trims whitespace', () => {
    expect(serviceTokenKey('  CI-Deploy  ')).toBe(serviceTokenKey('ci-deploy'))
  })

  it('extractServiceTokenSpecs trims name and omits a blank duration', () => {
    const specs = extractServiceTokenSpecs(
      makeCtx([{ name: 'r', fields: { name: '  ci-deploy  ', duration: '   ' } }]).canvas,
    )
    expect(specs[0].name).toBe('ci-deploy')
    expect(specs[0].duration).toBeUndefined()
  })
})
