import validate from '../validate'
import { buildVlanBody, declaredVlanKeys, extractVlanSpecs, isValidVlanId, restoreVlanBody, typedVlanFields } from '../_shared'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'appliance-vlans',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'appliance-vlans',
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

const validFields = {
  network_id: 'L_646829496481099008',
  id: '10',
  name: 'Guest',
  subnet: '192.168.10.0/24',
  appliance_ip: '192.168.10.1',
}

describe('Cisco Meraki Appliance VLANs Validate Handler', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('validates a well-formed VLAN', async () => {
    const result = await validate(makeCtx([{ name: 'Item', fields: validFields }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('requires network_id, id and name', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: {} }]))
    expect(result.valid).toBe(false)
    expect(result.errors.filter((e) => e.code === 'REQUIRED').length).toBeGreaterThan(2)
  })

  it('rejects a VLAN id out of range', async () => {
    const tooBig = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, id: '4095' } }]))
    const zero = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, id: '0' } }]))
    expect(tooBig.errors.some((e) => e.code === 'INVALID_VLAN_ID')).toBe(true)
    expect(zero.errors.some((e) => e.code === 'INVALID_VLAN_ID')).toBe(true)
  })

  it('accepts the boundary VLAN ids 1 and 4094', async () => {
    const low = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, id: '1' } }]))
    const high = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, id: '4094' } }]))
    expect(low.valid).toBe(true)
    expect(high.valid).toBe(true)
  })

  it('rejects an unsupported dhcp_handling value', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, dhcp_handling: 'Sometimes' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_DHCP_HANDLING')).toBe(true)
  })

  it('rejects an unsupported dhcp_lease_time value', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, dhcp_lease_time: '2 weeks' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_DHCP_LEASE_TIME')).toBe(true)
  })

  it('requires relay server IPs when DHCP handling is relay', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, dhcp_handling: 'Relay DHCP to another server' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('dhcp_relay_server_ips'))).toBe(true)
  })

  it('warns when relay IPs are set but handling is not relay', async () => {
    const result = await validate(
      makeCtx([
        {
          name: 'i1',
          fields: { ...validFields, dhcp_handling: 'Run a DHCP server', dhcp_relay_server_ips: ['10.0.0.1'] },
        },
      ]),
    )
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNUSED_DHCP_RELAY_IPS')).toBe(true)
  })

  it('warns when boot options are set but not enabled', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, dhcp_boot_filename: 'pxelinux.0' } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNUSED_DHCP_BOOT_OPTIONS')).toBe(true)
  })

  it('rejects invalid advanced JSON', async () => {
    const result = await validate(makeCtx([{ name: 'i1', fields: { ...validFields, advanced: '{ bad' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_ADVANCED')).toBe(true)
  })

  it('warns on a duplicate VLAN id within the same network', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields } }]))
    expect(result.warnings.some((w) => w.code === 'DUPLICATE_VLAN_ID')).toBe(true)
  })

  it('does NOT flag the same VLAN id across different networks', async () => {
    const result = await validate(
      makeCtx([{ name: 'a', fields: validFields }, { name: 'b', fields: { ...validFields, network_id: 'N_other' } }]),
    )
    expect(result.warnings.filter((w) => w.code === 'DUPLICATE_VLAN_ID')).toHaveLength(0)
  })
})

describe('Cisco Meraki Appliance VLANs shared helpers', () => {
  it('isValidVlanId enforces the 1-4094 range', () => {
    expect(isValidVlanId('1')).toBe(true)
    expect(isValidVlanId('4094')).toBe(true)
    expect(isValidVlanId('0')).toBe(false)
    expect(isValidVlanId('4095')).toBe(false)
    expect(isValidVlanId('abc')).toBe(false)
  })

  it('typedVlanFields omits blank optional fields', () => {
    const specs = extractVlanSpecs(makeCtx([{ name: 'e', fields: validFields }]).canvas)
    const fields = typedVlanFields(specs[0])
    expect(fields.name).toBe('Guest')
    expect(fields.subnet).toBe('192.168.10.0/24')
    expect('groupPolicyId' in fields).toBe(false)
    expect('vpnNatSubnet' in fields).toBe(false)
  })

  it('buildVlanBody includes id only when includeId is true, and typed fields win over advanced', () => {
    const specs = extractVlanSpecs(makeCtx([{ name: 'e', fields: validFields }]).canvas)
    const withId = buildVlanBody(specs[0], { name: 'from-advanced', extra: 1 }, true)
    const withoutId = buildVlanBody(specs[0], {}, false)
    expect(withId.id).toBe('10')
    expect(withId.name).toBe('Guest')
    expect(withId.extra).toBe(1)
    expect('id' in withoutId).toBe(false)
  })

  it('declaredVlanKeys covers typed fields and advanced keys', () => {
    const specs = extractVlanSpecs(makeCtx([{ name: 'e', fields: validFields }]).canvas)
    const keys = declaredVlanKeys(specs[0], { mask: 24 })
    expect(keys).toContain('name')
    expect(keys).toContain('subnet')
    expect(keys).toContain('mask')
  })

  it('restoreVlanBody strips id, networkId and interfaceId', () => {
    const body = restoreVlanBody({ id: '10', networkId: 'L_1', interfaceId: '999', name: 'Guest', subnet: '10.0.0.0/24' })
    expect(body).toEqual({ name: 'Guest', subnet: '10.0.0.0/24' })
  })

  it('extractVlanSpecs reads and trims every field', () => {
    const specs = extractVlanSpecs(makeCtx([{ name: 'e', fields: { ...validFields, id: '  10  ' } }]).canvas)
    expect(specs[0].id).toBe('10')
    expect(specs[0].networkId).toBe('L_646829496481099008')
  })
})
