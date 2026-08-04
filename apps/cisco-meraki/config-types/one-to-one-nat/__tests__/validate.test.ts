import validate from '../validate'
import { normalizeOneToOneNatRule } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'one-to-one-nat',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'one-to-one-nat',
      items,
      sections: items,
      snapshot: {},
    },
    environment: { id: 'env-1', name: 'production' },
    user: { id: 'user-1', email: 'test@test.com', name: 'Test' },
    settings: {},
    platform: stubPlatform,
  }
}

const goodRule = {
  name: 'Web server',
  publicIp: '146.12.3.33',
  lanIp: '192.168.128.22',
  uplink: 'internet1',
  allowedInbound: [{ protocol: 'tcp', destinationPorts: ['80'], allowedIps: ['any'] }],
}
const validFields = { network_id: 'L_646829496481099008', rules: JSON.stringify([goodRule]) }

describe('Cisco Meraki One-to-One NAT Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: validFields }]))
    expect(result.valid).toBe(true)
  })

  it('requires lanIp', async () => {
    const rules = JSON.stringify([{ ...goodRule, lanIp: '' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('lanIp'))).toBe(true)
  })

  it('rejects a malformed uplink', async () => {
    const rules = JSON.stringify([{ ...goodRule, uplink: 'wan1' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_UPLINK')).toBe(true)
  })

  it('rejects an unsupported allowedInbound protocol', async () => {
    const rules = JSON.stringify([{ ...goodRule, allowedInbound: [{ protocol: 'sctp', destinationPorts: [], allowedIps: [] }] }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PROTOCOL')).toBe(true)
  })

  it('warns on an empty ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules: '[]' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'EMPTY_RULES')).toBe(true)
  })

  it('warns on a duplicate network_id', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NETWORK_ID')).toBe(true)
  })
})

describe('Cisco Meraki One-to-One NAT shared helpers', () => {
  it('normalizeOneToOneNatRule trims and lower-cases protocol', () => {
    const normalized = normalizeOneToOneNatRule({ lanIp: ' 10.0.0.1 ', allowedInbound: [{ protocol: 'TCP', destinationPorts: [' 80 '], allowedIps: ['any'] }] })
    expect(normalized.lanIp).toBe('10.0.0.1')
    expect(normalized.allowedInbound?.[0].protocol).toBe('tcp')
    expect(normalized.allowedInbound?.[0].destinationPorts).toEqual(['80'])
  })
})
