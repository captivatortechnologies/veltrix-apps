import validate from '../validate'
import { normalizeSwitchAclRule } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'switch-access-control-lists',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'switch-access-control-lists',
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

const goodRule = { comment: 'Deny SSH', policy: 'deny', ipVersion: 'ipv4', protocol: 'tcp', srcCidr: '10.1.10.0/24', srcPort: 'any', dstCidr: '172.16.30.0/24', dstPort: '22', vlan: '10' }
const validFields = { network_id: 'L_646829496481099008', rules: JSON.stringify([goodRule]) }

describe('Cisco Meraki Switch ACL Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed ACL', async () => {
    const result = await validate(makeCtx([{ name: 'acl', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires network_id', async () => {
    const result = await validate(makeCtx([{ name: 'acl', fields: { rules: '[]' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED')).toBe(true)
  })

  it('rejects a network_id with illegal characters', async () => {
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, network_id: 'bad id!' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NETWORK_ID')).toBe(true)
  })

  it('rejects an unsupported policy', async () => {
    const rules = JSON.stringify([{ ...goodRule, policy: 'reject' }])
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_POLICY')).toBe(true)
  })

  it('rejects a missing protocol', async () => {
    const rules = JSON.stringify([{ ...goodRule, protocol: undefined }])
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PROTOCOL')).toBe(true)
  })

  it('rejects an unsupported protocol', async () => {
    const rules = JSON.stringify([{ ...goodRule, protocol: 'icmp' }])
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_PROTOCOL')).toBe(true)
  })

  it('rejects an unsupported ipVersion', async () => {
    const rules = JSON.stringify([{ ...goodRule, ipVersion: 'ipv5' }])
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_IP_VERSION')).toBe(true)
  })

  it('defaults a missing ipVersion to "any" and accepts it', async () => {
    const rules = JSON.stringify([{ ...goodRule, ipVersion: undefined }])
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(true)
  })

  it('requires srcCidr and dstCidr', async () => {
    const rules = JSON.stringify([{ ...goodRule, srcCidr: '', dstCidr: '' }])
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED').length).toBe(2)
  })

  it('warns that an empty ruleset CLEARS all ACLs (unlike L3\'s implicit default rule)', async () => {
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules: '[]' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'EMPTY_RULES_CLEARS_ACL')).toBe(true)
  })

  it('warns on a duplicate network_id across items', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_NETWORK_ID')).toBe(true)
  })

  it('rejects rules that are not valid JSON', async () => {
    const result = await validate(makeCtx([{ name: 'acl', fields: { ...validFields, rules: '{ not json' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_RULES')).toBe(true)
  })
})

describe('Cisco Meraki Switch ACL shared helpers', () => {
  it('normalizeSwitchAclRule trims, lower-cases enums and defaults ipVersion/vlan/ports to "any"', () => {
    const normalized = normalizeSwitchAclRule({ policy: 'DENY', protocol: 'TCP', srcCidr: ' 10.0.0.0/8 ', dstCidr: '10.0.0.1' })
    expect(normalized.policy).toBe('deny')
    expect(normalized.protocol).toBe('tcp')
    expect(normalized.ipVersion).toBe('any')
    expect(normalized.srcPort).toBe('any')
    expect(normalized.dstPort).toBe('any')
    expect(normalized.vlan).toBe('any')
  })
})
