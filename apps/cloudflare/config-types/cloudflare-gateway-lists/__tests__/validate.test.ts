import validate, { extractGatewayListSpecs, gatewayListKey, parseItems } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-gateway-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-gateway-lists',
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

describe('Cloudflare Gateway Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid DOMAIN list', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'Blocklist',
          fields: { name: 'blocked-domains', type: 'DOMAIN', description: 'bad domains', items: 'evil.com\nmalware.test' },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'IP' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'my-list' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('type'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'my-list', type: 'FOO' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('accepts every supported type', async () => {
    for (const type of ['DOMAIN', 'IP', 'URL', 'EMAIL', 'SERIAL']) {
      const result = await validate(makeCtx([{ name: 'sec1', fields: { name: `list-${type}`, type } }]))
      expect(result.valid).toBe(true)
    }
  })

  it('rejects duplicate list names (case-insensitive)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'my-list', type: 'DOMAIN' } },
        { name: 'b', fields: { name: 'MY-LIST', type: 'IP' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_gateway_list')).toBe(true)
  })

  it('parses items one per line, trims, folds identity, and upcases type', () => {
    expect(parseItems('a.com\n  b.com  \n\n\nc.com')).toEqual(['a.com', 'b.com', 'c.com'])
    expect(parseItems(undefined)).toEqual([])
    expect(gatewayListKey('  My-List ')).toBe(gatewayListKey('my-list'))

    const specs = extractGatewayListSpecs(
      makeCtx([{ name: 'r', fields: { name: ' trimmed ', type: 'domain', items: 'x\ny' } }]).canvas,
    )
    expect(specs[0].name).toBe('trimmed')
    expect(specs[0].type).toBe('DOMAIN')
    expect(specs[0].items).toEqual(['x', 'y'])
  })
})
