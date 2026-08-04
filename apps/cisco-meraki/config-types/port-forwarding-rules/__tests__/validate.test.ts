import validate from '../validate'
import { normalizePortForwardingRule } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'port-forwarding-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'port-forwarding-rules',
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
  name: 'HTTPS admin console',
  lanIp: '192.168.128.1',
  uplink: 'both',
  publicPort: '8100-8101',
  localPort: '442-443',
  allowedIps: ['any'],
  protocol: 'tcp',
}
const validFields = { network_id: 'L_646829496481099008', rules: JSON.stringify([goodRule]) }

describe('Cisco Meraki Port Forwarding Rules Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a network_id with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, network_id: 'bad id!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NETWORK_ID')).toBe(true)
  })

  it('requires lanIp, publicPort and localPort', async () => {
    const rules = JSON.stringify([{ ...goodRule, lanIp: '', publicPort: '', localPort: '' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED' && ['lanIp', 'publicPort', 'localPort'].some((f) => e.field.includes(f))).length).toBe(3)
  })

  it('requires an uplink', async () => {
    const rules = JSON.stringify([{ ...goodRule, uplink: '' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('uplink') && e.code === 'REQUIRED')).toBe(true)
  })

  it('rejects an unsupported uplink', async () => {
    const rules = JSON.stringify([{ ...goodRule, uplink: 'wan3' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_UPLINK')).toBe(true)
  })

  it('accepts every documented uplink value', async () => {
    for (const uplink of ['all', 'both', 'internet1', 'internet2', 'internet3', 'internet4']) {
      const rules = JSON.stringify([{ ...goodRule, uplink }])
      const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
      expect(result.valid).toBe(true)
    }
  })

  it('rejects an unsupported protocol', async () => {
    const rules = JSON.stringify([{ ...goodRule, protocol: 'icmp' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PROTOCOL')).toBe(true)
  })

  it('requires a non-empty allowedIps array', async () => {
    const rules = JSON.stringify([{ ...goodRule, allowedIps: [] }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('allowedIps'))).toBe(true)
  })

  it('warns on an empty ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules: '[]' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'EMPTY_RULES')).toBe(true)
  })

  it('warns on a duplicate network_id across items', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NETWORK_ID')).toBe(true)
  })

  it('rejects rules that are not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules: '{ not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULES')).toBe(true)
  })
})

describe('Cisco Meraki Port Forwarding Rules shared helpers', () => {
  it('normalizePortForwardingRule trims scalars and lower-cases protocol', () => {
    const normalized = normalizePortForwardingRule({ lanIp: ' 10.0.0.1 ', protocol: 'TCP', allowedIps: [' any '] })
    expect(normalized.lanIp).toBe('10.0.0.1')
    expect(normalized.protocol).toBe('tcp')
    expect(normalized.allowedIps).toEqual(['any'])
  })
})
