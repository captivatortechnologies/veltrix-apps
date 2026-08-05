import validate, { allowListKey, buildAllowListBody, extractDdosAllowListSpecs } from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'barracuda-waf',
    customerId: 'cust-1',
    configTypeId: 'ddos-allow-list',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'barracuda-waf',
      entityType: 'ddos-allow-list',
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

const GOOD_FIELDS = { ip: '34.205.44.115', netmask: '255.255.255.255', note: 'health checker', allow_bypass: false }

describe('Barracuda WAF DDoS Allow List Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a complete entry', async () => {
    const result = await validate(makeCtx([{ name: 'Entry', fields: GOOD_FIELDS }]))
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
  })

  it('rejects a missing IP', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { netmask: '255.255.255.255' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a malformed IP', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ip: 'not-an-ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects a malformed netmask', async () => {
    const result = await validate(makeCtx([{ name: 'a', fields: { ip: '1.2.3.4', netmask: 'not-a-mask' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_netmask')).toBe(true)
  })

  it('rejects duplicate IPs', async () => {
    const result = await validate(
      makeCtx([
        { name: 'a', fields: { ip: '1.2.3.4' } },
        { name: 'b', fields: { ip: '1.2.3.4' } },
      ]),
    )
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'duplicate_ip')).toBe(true)
  })

  it('extractDdosAllowListSpecs defaults netmask to 255.255.255.255', () => {
    const specs = extractDdosAllowListSpecs(makeCtx([{ name: 's', fields: { ip: '1.2.3.4' } }]).canvas)
    expect(specs[0].netmask).toBe('255.255.255.255')
    expect(specs[0].allowBypass).toBe(false)
  })

  it('allowListKey trims the ip', () => {
    expect(allowListKey(' 1.2.3.4 ')).toBe('1.2.3.4')
  })

  it('buildAllowListBody maps the spec onto the wire shape', () => {
    const specs = extractDdosAllowListSpecs(makeCtx([{ name: 's', fields: GOOD_FIELDS }]).canvas)
    expect(buildAllowListBody(specs[0])).toEqual({
      ip: '34.205.44.115',
      netmask: '255.255.255.255',
      note: 'health checker',
      allow_bypass: false,
    })
  })
})
