import validate, { extractIndicatorSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'defender-endpoint',
    customerId: 'cust-1',
    configTypeId: 'mde-network-indicators',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'defender-endpoint',
      entityType: 'mde-network-indicators',
      items: sections,
      sections,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: { tenant_id: '00000000-0000-0000-0000-000000000000' },
    platform: stubPlatform,
  }
}

const base = { title: 'Bad host', description: 'Known-bad', generate_alert: true }

describe('Defender Network Indicators Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a domain / URL / IP indicator', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { indicator_type: 'DomainName', indicator_value: 'evil.example.com', action: 'Block', ...base } },
        { name: 'b', fields: { indicator_type: 'Url', indicator_value: 'https://evil.example.com/x', action: 'Block', ...base } },
        { name: 'c', fields: { indicator_type: 'IpAddress', indicator_value: '203.0.113.9', action: 'Block', ...base } },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a CIDR range for an IP indicator', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'IpAddress', indicator_value: '10.0.0.0/8', action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects a domain with a scheme', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'DomainName', indicator_value: 'https://evil.com', action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_value')).toBe(true)
  })

  it('rejects an out-of-type value (file hash in network canvas)', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'FileSha256', indicator_value: 'abc', action: 'Block', ...base } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires generate_alert when action is Audit', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { indicator_type: 'DomainName', indicator_value: 'evil.example.com', action: 'Audit', title: 't', description: 'd', generate_alert: false } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'audit_requires_alert')).toBe(true)
  })

  it('rejects duplicate (type,value)', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { indicator_type: 'DomainName', indicator_value: 'evil.example.com', action: 'Block', ...base } },
        { name: 'b', fields: { indicator_type: 'DomainName', indicator_value: 'EVIL.example.com', action: 'Block', ...base } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_indicator')).toBe(true)
  })

  it('extract behaves', () => {
    const specs = extractIndicatorSpecs(makeCtx([{ name: 't', fields: { indicator_type: 'Url', indicator_value: '  https://x.io  ', rbac_group_names: 'A, B' } }]).canvas)
    expect(specs[0].indicatorValue).toBe('https://x.io')
    expect(specs[0].rbacGroupNames).toEqual(['A', 'B'])
  })
})
