import validate, { extractDnsRecordSpecs, dnsRecordKey } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cloudflare',
    customerId: 'cust-1',
    configTypeId: 'cloudflare-dns-records',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cloudflare',
      entityType: 'cloudflare-dns-records',
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

describe('Cloudflare DNS Records Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a valid A record', async () => {
    const result = await validate(
      makeCtx([{ name: 'DNS Record', fields: { type: 'A', name: 'www.example.com', content: '203.0.113.10', proxied: true } }]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects missing name/content', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'A' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('name'))).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('content'))).toBe(true)
  })

  it('rejects an unsupported type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'FOO', name: 'x.example.com', content: 'y' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires priority for MX records', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'MX', name: 'example.com', content: 'mail.example.com' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('priority'))).toBe(true)
  })

  it('warns when proxied is set on a non-proxyable type', async () => {
    const result = await validate(makeCtx([{ name: 'sec1', fields: { type: 'TXT', name: 'example.com', content: 'v=spf1 -all', proxied: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'proxied_ignored')).toBe(true)
  })

  it('rejects duplicate (type,name,content)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { type: 'A', name: 'www.example.com', content: '203.0.113.10' } },
        { name: 'b', fields: { type: 'a', name: 'WWW.example.com', content: '203.0.113.10' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_dns_record')).toBe(true)
  })

  it('dnsRecordKey folds type/name case but not content', () => {
    expect(dnsRecordKey({ type: 'a', name: 'WWW.Example.com', content: '1.2.3.4' })).toBe(
      dnsRecordKey({ type: 'A', name: 'www.example.com', content: '1.2.3.4' }),
    )
    const specs = extractDnsRecordSpecs(makeCtx([{ name: 'r', fields: { type: 'a', name: ' x ', content: ' y ' } }]).canvas)
    expect(specs[0].type).toBe('A')
    expect(specs[0].name).toBe('x')
  })
})
