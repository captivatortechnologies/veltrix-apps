import validate, { extractLocalBrokerConfigSpec } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('npa-local-broker-config validate', () => {
  it('accepts a blank hostname', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: {} }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid hostname', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: { hostname: 'broker.acme.com' } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects an invalid hostname', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: { hostname: 'not a host!' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_hostname')).toBe(true)
  })

  it('requires at least one item', () => {
    const r = validate(ctxWith([]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('warns when more than one item is declared', () => {
    const r = validate(ctxWith([{ name: 'A', fields: {} }, { name: 'B', fields: {} }]))
    expect(r.warnings.some((w) => w.code === 'singleton')).toBe(true)
  })
})

describe('extractLocalBrokerConfigSpec', () => {
  it('reads the hostname from the first item', () => {
    const spec = extractLocalBrokerConfigSpec({
      items: [{ id: 'i1', name: 'Config', fields: { hostname: ' broker.acme.com ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(spec.hostname).toBe('broker.acme.com')
  })
})
