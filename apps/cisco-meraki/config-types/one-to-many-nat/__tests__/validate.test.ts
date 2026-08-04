import validate from '../validate'
import { normalizeOneToManyNatRule } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'one-to-many-nat',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'one-to-many-nat',
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
  publicIp: '146.11.11.13',
  uplink: 'internet1',
  portRules: [{ name: 'r1', protocol: 'tcp', publicPort: '9443', localIp: '192.168.128.1', localPort: '443', allowedIps: ['any'] }],
}
const validFields = { network_id: 'L_646829496481099008', rules: JSON.stringify([goodRule]) }

describe('Cisco Meraki One-to-Many NAT Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed ruleset', async () => {
    const result = await validate(makeCtx([{ name: 'i', fields: validFields }]))
    expect(result.valid).toBe(true)
  })

  it('requires publicIp and uplink', async () => {
    const rules = JSON.stringify([{ ...goodRule, publicIp: '', uplink: '' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED').length).toBeGreaterThan(0)
  })

  it('rejects a malformed uplink', async () => {
    const rules = JSON.stringify([{ ...goodRule, uplink: 'wan1' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_UPLINK')).toBe(true)
  })

  it('requires portRules to be present', async () => {
    const rules = JSON.stringify([{ publicIp: '1.2.3.4', uplink: 'internet1' }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('portRules'))).toBe(true)
  })

  it('rejects an unsupported port rule protocol', async () => {
    const rules = JSON.stringify([{ ...goodRule, portRules: [{ ...goodRule.portRules[0], protocol: 'icmp' }] }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PROTOCOL')).toBe(true)
  })

  it('warns on empty port rules', async () => {
    const rules = JSON.stringify([{ ...goodRule, portRules: [] }])
    const result = await validate(makeCtx([{ name: 'i', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'EMPTY_PORT_RULES')).toBe(true)
  })
})

describe('Cisco Meraki One-to-Many NAT shared helpers', () => {
  it('normalizeOneToManyNatRule trims and lower-cases protocol', () => {
    const normalized = normalizeOneToManyNatRule({ publicIp: ' 1.2.3.4 ', portRules: [{ protocol: 'TCP', localIp: ' 10.0.0.1 ' } as never] })
    expect(normalized.publicIp).toBe('1.2.3.4')
    expect(normalized.portRules[0].protocol).toBe('tcp')
    expect(normalized.portRules[0].localIp).toBe('10.0.0.1')
  })
})
