import validate, { extractPublisherSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('npa-publishers validate', () => {
  it('accepts a valid publisher', () => {
    const r = validate(ctxWith([{ name: 'DC1', fields: { name: 'DC1', lbrokerconnect: true } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a publisher without local broker connect', () => {
    const r = validate(ctxWith([{ name: 'Plain', fields: { name: 'Plain' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { lbrokerconnect: false } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a too-long name', () => {
    const r = validate(ctxWith([{ name: 'x'.repeat(65), fields: { name: 'x'.repeat(65) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractPublisherSpecs', () => {
  it('reads name and lbrokerconnect boolean, trimming', () => {
    const specs = extractPublisherSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Real ', lbrokerconnect: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Real', lbrokerconnect: true })
  })

  it('defaults lbrokerconnect to false when absent', () => {
    const specs = extractPublisherSpecs({
      items: [{ id: 'i2', name: 'F', fields: { name: 'F' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].lbrokerconnect).toBe(false)
  })
})
