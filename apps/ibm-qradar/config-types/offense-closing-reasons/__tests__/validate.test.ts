import validate, { extractClosingReasonSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('offense-closing-reasons validate', () => {
  it('accepts a valid closing reason', () => {
    const r = validate(ctxWith([{ name: 'False positive', fields: { text: 'False positive' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires text', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects text that is too short', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { text: 'no' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_length')).toBe(true)
  })

  it('rejects duplicate reason text', () => {
    const r = validate(ctxWith([
      { name: 'False positive', fields: { text: 'False positive' } },
      { name: 'false positive', fields: { text: 'false positive' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_text')).toBe(true)
  })

  it('warns that the type is append-only', () => {
    const r = validate(ctxWith([{ name: 'False positive', fields: { text: 'False positive' } }]))
    expect(r.warnings.some((w) => w.code === 'append_only')).toBe(true)
  })
})

describe('extractClosingReasonSpecs', () => {
  it('reads the reason text', () => {
    const specs = extractClosingReasonSpecs({
      items: [{ id: 'i1', name: 'Resolved', fields: { text: 'Resolved by SOC' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].text).toBe('Resolved by SOC')
  })
})
