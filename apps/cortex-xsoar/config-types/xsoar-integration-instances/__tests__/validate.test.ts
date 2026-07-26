import validate, { extractIntegrationInstanceSpecs, isInstanceEnabled } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cortex-xsoar',
    customerId: 'cust-1',
    configTypeId: 'xsoar-integration-instances',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cortex-xsoar',
      entityType: 'xsoar-integration-instances',
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

describe('Cortex XSOAR Integration Instances Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid instance', async () => {
    const result = await validate(
      makeCtx([{ name: 'I1', fields: { instanceName: 'Demisto REST API_instance', brand: 'Demisto REST API', parameters: { url: 'https://x' } } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing instance name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { brand: 'Demisto REST API' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('instanceName'))).toBe(true)
  })

  it('rejects a missing brand', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { instanceName: 'inst-1' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'brand_required')).toBe(true)
  })

  it('rejects a duplicate instance name', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { instanceName: 'inst', brand: 'B' } },
        { name: 'b', fields: { instanceName: 'inst', brand: 'B' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_instance')).toBe(true)
  })

  it('warns when an instance declares no parameters', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { instanceName: 'inst', brand: 'B' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'no_parameters')).toBe(true)
  })

  it('extractIntegrationInstanceSpecs trims the name and defaults enabled to true', () => {
    const specs = extractIntegrationInstanceSpecs(
      makeCtx([{ name: 's', fields: { instanceName: '  inst  ', brand: '  B  ' } }]).canvas,
    )
    expect(specs[0].name).toBe('inst')
    expect(specs[0].brand).toBe('B')
    expect(specs[0].enabled).toBe(true)
  })

  it('extractIntegrationInstanceSpecs reads parameters from an object, pair array or k=v string', () => {
    const asObject = extractIntegrationInstanceSpecs(
      makeCtx([{ name: 's', fields: { instanceName: 'a', brand: 'B', parameters: { url: 'https://x', insecure: true } } }]).canvas,
    )
    const asArray = extractIntegrationInstanceSpecs(
      makeCtx([{ name: 's', fields: { instanceName: 'b', brand: 'B', parameters: [{ key: 'url', value: 'https://x' }] } }]).canvas,
    )
    const asString = extractIntegrationInstanceSpecs(
      makeCtx([{ name: 's', fields: { instanceName: 'c', brand: 'B', parameters: 'url=https://x\nproxy=true' } }]).canvas,
    )
    expect(asObject[0].parameters).toEqual({ url: 'https://x', insecure: 'true' })
    expect(asArray[0].parameters).toEqual({ url: 'https://x' })
    expect(asString[0].parameters).toEqual({ url: 'https://x', proxy: 'true' })
  })

  it('isInstanceEnabled tolerates the string and boolean forms', () => {
    expect(isInstanceEnabled({ enabled: 'true' })).toBe(true)
    expect(isInstanceEnabled({ enabled: true })).toBe(true)
    expect(isInstanceEnabled({ enabled: 'false' })).toBe(false)
    expect(isInstanceEnabled({ enabled: false })).toBe(false)
    expect(isInstanceEnabled({})).toBe(false)
  })
})
