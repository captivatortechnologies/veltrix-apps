import validate, { extractGatewayPolicySpecs, parseJsonObject } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-gateway-policies',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-gateway-policies',
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

const validFields = {
  name: 'Block ads',
  action: 'block',
  filters: 'dns',
  traffic: 'any(dns.domains[*] == "ads.example.com")',
}

describe('Cloudflare Gateway Policies Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid gateway policy', async () => {
    const result = await validate(makeCtx([{ name: 'Policy', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { action: 'block', traffic: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a missing traffic expression', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'p', action: 'block' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('traffic'))).toBe(true)
  })

  it('rejects an unsupported action', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'p', action: 'nuke', traffic: 'x' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_action')).toBe(true)
  })

  it('rejects duplicate policy names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ...validFields, name: 'Dup' } },
        { name: 'b', fields: { ...validFields, name: 'Dup' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_gateway_policy')).toBe(true)
  })

  it('rejects rule_json that is not a JSON object', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, rule_json: '[1,2,3]' } }]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('warns on an unknown filter type but stays valid', async () => {
    const result = await validate(
      makeCtx([{ name: 'sec1', fields: { ...validFields, filters: 'dns\nhttp\nbogus' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'invalid_filter')).toBe(true)
  })

  it('extracts filters as lines, defaults enabled true, and parses valid rule_json', () => {
    const specs = extractGatewayPolicySpecs(
      makeCtx([
        {
          name: 'r',
          fields: { name: '  Trim me  ', action: 'allow', filters: 'dns\n\nhttp\n', traffic: '  expr  ' },
        },
      ]).canvas,
    )
    expect(specs[0].name).toBe('Trim me')
    expect(specs[0].action).toBe('allow')
    expect(specs[0].enabled).toBe(true)
    expect(specs[0].filters).toEqual(['dns', 'http'])
    expect(specs[0].traffic).toBe('expr')

    const parsed = parseJsonObject('{"rule_settings":{"block_page_enabled":true}}')
    expect(parsed.error).toBeNull()
    expect(parsed.value).toEqual({ rule_settings: { block_page_enabled: true } })
  })
})
