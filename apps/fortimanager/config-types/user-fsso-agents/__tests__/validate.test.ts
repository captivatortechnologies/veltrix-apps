import validate, { extractFssoAgentSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('user-fsso-agents validate', () => {
  it('accepts a valid FSSO agent', () => {
    const r = validate(ctxWith([{ name: 'FSSO', fields: { name: 'FSSO', server: '10.0.0.30', port: '8000' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { server: '10.0.0.30' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a primary collector agent', () => {
    const r = validate(ctxWith([{ name: 'FSSO', fields: { name: 'FSSO' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.server'))).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'FSSO', fields: { name: 'FSSO', server: '10.0.0.30', type: 'radius' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects an out-of-range port', () => {
    const r = validate(ctxWith([{ name: 'FSSO', fields: { name: 'FSSO', server: '10.0.0.30', port: '99999' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', server: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', server: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractFssoAgentSpecs', () => {
  it('defaults the type', () => {
    const specs = extractFssoAgentSpecs({
      items: [{ id: 'i1', name: 'FSSO', fields: { name: 'FSSO', server: '10.0.0.30' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('default')
  })
})
