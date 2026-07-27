import validate, { extractConnectorRuleSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('connector-rules validate', () => {
  it('accepts a valid rule', () => {
    const r = validate(ctxWith([{ name: 'BuildEmail', fields: { name: 'BuildEmail', type: 'BuildMap', script: 'return map;' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, type and script', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].type')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].script')).toBe(true)
  })

  it('rejects invalid signature JSON', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { name: 'R', type: 'BuildMap', script: 'x', signature: '{bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_signature')).toBe(true)
  })
})

describe('extractConnectorRuleSpecs', () => {
  it('defaults the source version', () => {
    const specs = extractConnectorRuleSpecs({
      items: [{ id: 'i1', name: 'R', fields: { name: 'R', type: 'BuildMap', script: 'x' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].version).toBe('1.0')
  })
})
