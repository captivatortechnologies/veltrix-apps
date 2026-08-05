import validate, { extractAigApplianceSpecs, asNumber, splitEntries } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const valid = { name: 'gw-01', host: 'gw-01.acme.com', https_enable: true, https_port: 443 }

describe('aig-appliances validate', () => {
  it('accepts a valid appliance', () => {
    const r = validate(ctxWith([{ name: 'gw-01', fields: { ...valid } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and host', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.host'))).toBe(true)
  })

  it('rejects a name over 15 characters', () => {
    const r = validate(ctxWith([{ name: 'A'.repeat(16), fields: { ...valid, name: 'A'.repeat(16) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(ctxWith([{ name: 'Dup', fields: { ...valid, name: 'Dup' } }, { name: 'Dup', fields: { ...valid, name: 'Dup' } }]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires at least one of http/https enabled', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { ...valid, https_enable: false, http_enable: false } }]))
    expect(r.errors.some((e) => e.code === 'no_port_enabled')).toBe(true)
  })

  it('rejects invalid sku_addons JSON', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { ...valid, sku_addons: 'not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects an invalid sku_addons product code', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { ...valid, sku_addons: '[{"productCode":"BOGUS"}]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_product_code')).toBe(true)
  })

  it('accepts a valid sku_addons entry and warns about billing impact', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { ...valid, sku_addons: '[{"productCode":"NK-A-AIGW-10K","quantity":2}]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_product_code')).toBe(false)
    expect(r.warnings.some((w) => w.code === 'billing_impact')).toBe(true)
  })

  it('rejects more than 10 AI providers', () => {
    const many = Array.from({ length: 11 }, (_, i) => `provider-${i}`).join('\n')
    const r = validate(ctxWith([{ name: 'A', fields: { ...valid, ai_provider_ids: many } }]))
    expect(r.errors.some((e) => e.code === 'too_many' && e.field.includes('ai_provider_ids'))).toBe(true)
  })
})

describe('extractAigApplianceSpecs', () => {
  it('reads fields, ports and associations', () => {
    const specs = extractAigApplianceSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' gw-01 ', host: 'h', https_enable: true, https_port: '443', ai_provider_ids: 'OpenAI\nClaude' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('gw-01')
    expect(specs[0].httpsPort).toBe(443)
    expect(specs[0].aiProviders).toEqual(['OpenAI', 'Claude'])
  })
})

describe('asNumber', () => {
  it('parses numbers and strings', () => {
    expect(asNumber(443, 0)).toBe(443)
    expect(asNumber('8080', 0)).toBe(8080)
    expect(asNumber('', 0)).toBe(0)
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitEntries('a\nb, c')).toEqual(['a', 'b', 'c'])
  })
})
