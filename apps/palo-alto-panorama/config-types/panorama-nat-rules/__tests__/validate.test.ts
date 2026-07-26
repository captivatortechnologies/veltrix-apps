import validate, {
  extractNatRuleSpecs,
  buildNatRuleFields,
  natRuleDriftDiffs,
} from '../validate'
import type { PipelineContext, PlatformDataApi } from '@veltrixsecops/app-sdk'

const stubPlatform: PlatformDataApi = {
  getLatestDeployment: async () => null,
  listComponents: async () => [],
}

function makeCtx(sections: Array<{ name: string; fields: Record<string, unknown> }>): PipelineContext {
  return {
    appId: 'palo-alto-panorama',
    customerId: 'cust-1',
    configTypeId: 'panorama-nat-rules',
    canvas: {
      id: 'snap-1',
      canvasId: 'canvas-1',
      version: 1,
      name: 'Test Canvas',
      toolType: 'palo-alto-panorama',
      entityType: 'panorama-nat-rules',
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

describe('Panorama NAT Rules Validate Handler', () => {
  it('returns invalid for empty sections', async () => {
    const result = await validate(makeCtx([]))
    expect(result.valid).toBe(false)
    expect(result.errors[0].code).toBe('empty_canvas')
  })

  it('validates a minimal no-translation rule', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'no-nat', source_translation_type: 'none' } }]))
    expect(result.valid).toBe(true)
  })

  it('requires a static translated address for static-ip', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'snat', source_translation_type: 'static-ip' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('source_static_translated_address'))).toBe(true)
  })

  it('requires translated addresses or interface for dynamic-ip-and-port', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'hide', source_translation_type: 'dynamic-ip-and-port' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid translated destination port and a port without an address', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'dnat', destination_translated_port: '70000' } }]))
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.code === 'invalid_port')).toBe(true)
    expect(result.errors.some((e) => e.code === 'required' && e.field.includes('destination_translated_address'))).toBe(true)
  })

  it('warns when bi-directional is set without static-ip', async () => {
    const result = await validate(makeCtx([{ name: 'r', fields: { name: 'x', source_translation_type: 'dynamic-ip', source_translated_addresses: ['1.1.1.1'], bi_directional: true } }]))
    expect(result.valid).toBe(true)
    expect(result.warnings.some((w) => w.code === 'ignored_bidirectional')).toBe(true)
  })

  it('builds dynamic-ip-and-port with translated addresses and defaults match to any', () => {
    const spec = extractNatRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'hide', source_translation_type: 'dynamic-ip-and-port', source_translated_addresses: ['203.0.113.5'] } }]).canvas)[0]
    const fields = buildNatRuleFields(spec) as Record<string, unknown>
    expect(fields['nat-type']).toBe('ipv4')
    expect(fields.from).toEqual({ member: ['any'] })
    expect(fields.service).toBe('any')
    expect(fields['source-translation']).toEqual({ 'dynamic-ip-and-port': { 'translated-address': { member: ['203.0.113.5'] } } })
  })

  it('builds dynamic-ip-and-port with an interface address', () => {
    const spec = extractNatRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'hide', source_translation_type: 'dynamic-ip-and-port', source_translation_interface: 'ethernet1/1', source_translation_interface_ip: '198.51.100.1' } }]).canvas)[0]
    const fields = buildNatRuleFields(spec) as Record<string, unknown>
    expect(fields['source-translation']).toEqual({ 'dynamic-ip-and-port': { 'interface-address': { interface: 'ethernet1/1', ip: '198.51.100.1' } } })
  })

  it('builds static-ip with bi-directional and destination translation with a numeric port', () => {
    const spec = extractNatRuleSpecs(
      makeCtx([{ name: 'r', fields: { name: 'dnat', source_translation_type: 'static-ip', source_static_translated_address: '10.0.0.5', bi_directional: true, destination_translated_address: '10.0.0.9', destination_translated_port: '8080' } }]).canvas,
    )[0]
    const fields = buildNatRuleFields(spec) as Record<string, unknown>
    expect(fields['source-translation']).toEqual({ 'static-ip': { 'translated-address': '10.0.0.5', 'bi-directional': 'yes' } })
    expect(fields['destination-translation']).toEqual({ 'translated-address': '10.0.0.9', 'translated-port': 8080 })
  })

  it('detects source-translation and service drift', () => {
    const spec = extractNatRuleSpecs(makeCtx([{ name: 'r', fields: { name: 'hide', source_translation_type: 'dynamic-ip-and-port', source_translated_addresses: ['203.0.113.5'] } }]).canvas)[0]
    const clean = natRuleDriftDiffs(spec, {
      '@name': 'hide',
      from: { member: ['any'] },
      to: { member: ['any'] },
      source: { member: ['any'] },
      destination: { member: ['any'] },
      service: 'any',
      'source-translation': { 'dynamic-ip-and-port': { 'translated-address': { member: ['203.0.113.5'] } } },
      disabled: 'no',
    })
    expect(clean).toHaveLength(0)
    const drifted = natRuleDriftDiffs(spec, {
      '@name': 'hide',
      service: 'any',
      'source-translation': { 'dynamic-ip-and-port': { 'translated-address': { member: ['198.51.100.9'] } } },
    })
    expect(drifted.some((d) => d.field.endsWith('.source-translation'))).toBe(true)
  })
})
