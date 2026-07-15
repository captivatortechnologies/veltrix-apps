import validate, { extractListSpecs, parseItems, buildItemBody } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-lists',
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

describe('Cloudflare Lists Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid IP list', async () => {
    const result = await validate(
      makeCtx([{ name: 'List', fields: { name: 'blocked_ips', kind: 'ip', items: '203.0.113.10\n198.51.100.0/24' } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing name', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { kind: 'ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
  })

  it('rejects a name that is not a lowercase slug', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'Blocked IPs', kind: 'ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects an unsupported kind', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { name: 'my_list', kind: 'country' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_kind')).toBe(true)
  })

  it('rejects duplicate list names', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { name: 'dup_list', kind: 'ip' } },
        { name: 'b', fields: { name: 'dup_list', kind: 'hostname' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_list')).toBe(true)
  })

  it('defaults kind to ip and parses items one per line', () => {
    const specs = extractListSpecs(
      makeCtx([{ name: 'l', fields: { name: 'defaulted', items: ' a \n\n b \r\nc ' } }]).canvas,
    )
    expect(specs[0].kind).toBe('ip')
    expect(specs[0].items).toEqual(['a', 'b', 'c'])
    expect(parseItems('x\ny')).toEqual(['x', 'y'])
  })

  it('builds the item body keyed by kind', () => {
    expect(buildItemBody('ip', '203.0.113.10')).toEqual({ ip: '203.0.113.10' })
    expect(buildItemBody('hostname', 'example.com')).toEqual({ hostname: 'example.com' })
    expect(buildItemBody('asn', '13335')).toEqual({ asn: '13335' })
    expect(buildItemBody('redirect', 'https://example.com')).toEqual({ redirect: 'https://example.com' })
  })
})
