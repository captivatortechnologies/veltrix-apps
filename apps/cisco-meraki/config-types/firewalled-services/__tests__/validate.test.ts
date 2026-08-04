import validate from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(items: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'cisco-meraki',
    customerId: 'cust-1',
    configTypeId: 'firewalled-services',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'cisco-meraki',
      entityType: 'firewalled-services',
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

const ctx = (network_id: string, settings: string) => makeCtx([{ name: 'item', fields: { network_id, settings } }])

describe('firewalled-services validation', () => {
  it('returns invalid for empty items', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('EMPTY')
  })

  it('accepts fixed services', async () => {
    const result = await validate(ctx('L_123', '{"services":[{"service":"ICMP","access":"restricted","allowedIps":["any"]}]}'))
    expect(result.valid).toBe(true)
  })

  it('accepts unrestricted and blocked access without allowedIps', async () => {
    const unrestricted = await validate(ctx('L_123', '{"services":[{"service":"web","access":"unrestricted"}]}'))
    const blocked = await validate(ctx('L_123', '{"services":[{"service":"SNMP","access":"blocked"}]}'))
    expect(unrestricted.valid).toBe(true)
    expect(blocked.valid).toBe(true)
  })

  it('rejects invalid access', async () => {
    const result = await validate(ctx('L_123', '{"services":[{"service":"ICMP","access":"open"}]}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_ACCESS')).toBe(true)
  })

  it('requires service and access on every entry', async () => {
    const result = await validate(ctx('L_123', '{"services":[{"access":"restricted"}]}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'REQUIRED')).toBe(true)
  })

  it('requires services to be an array', async () => {
    const result = await validate(ctx('L_123', '{"services":"ICMP"}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_SERVICES')).toBe(true)
  })

  it('rejects malformed JSON', async () => {
    const result = await validate(ctx('L_123', '{'))
    expect(result.valid).toBe(false)
  })

  it('rejects a network id with illegal characters', async () => {
    const result = await validate(ctx('bad id!', '{"services":[]}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'INVALID_NETWORK_ID')).toBe(true)
  })

  it('warns (does not error) on an unrecognized service name', async () => {
    const result = await validate(ctx('L_123', '{"services":[{"service":"icmp","access":"blocked"}]}'))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'UNKNOWN_SERVICE')).toBe(true)
  })

  it('does not warn for the documented service names', async () => {
    const result = await validate(
      ctx('L_123', '{"services":[{"service":"ICMP","access":"blocked"},{"service":"web","access":"unrestricted"},{"service":"SNMP","access":"blocked"}]}'),
    )
    expect(result.warnings.filter((w) => w.code === 'UNKNOWN_SERVICE')).toHaveLength(0)
  })

  it('requires allowedIps when access is restricted', async () => {
    const result = await validate(ctx('L_123', '{"services":[{"service":"web","access":"restricted"}]}'))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.field.includes('allowedIps'))).toBe(true)
  })
})
