import validate, { extractInternetServiceCustomSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-internet-service-custom validate', () => {
  it('accepts a valid custom service with entries', () => {
    const r = validate(ctxWith([{ name: 'MyISDB', fields: { name: 'MyISDB', comment: 'x', entry: '[{"id":1,"protocol":6}]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { entry: '[]' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a negative reputation', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', reputation: -1 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_number')).toBe(true)
  })

  it('rejects invalid entry JSON', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', entry: '[bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a non-array entry', () => {
    const r = validate(ctxWith([{ name: 'S', fields: { name: 'S', entry: '{"id":1}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json_shape')).toBe(true)
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

describe('extractInternetServiceCustomSpecs', () => {
  it('parses numeric fields and keeps raw entry', () => {
    const specs = extractInternetServiceCustomSpecs({
      items: [{ id: 'i1', name: 'S', fields: { name: 'S', reputation: '5', entry: '[]' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].reputation).toBe(5)
    expect(specs[0].entry).toBe('[]')
  })
})
