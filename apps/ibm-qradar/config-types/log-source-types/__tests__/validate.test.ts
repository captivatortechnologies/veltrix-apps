import validate, { extractLogSourceTypeSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('log-source-types validate', () => {
  it('accepts a valid custom log source type', () => {
    const r = validate(ctxWith([{ name: 'My DSM', fields: { name: 'My DSM', defaultProtocolName: 'Syslog' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'My DSM', fields: { name: 'My DSM' } },
      { name: 'my dsm', fields: { name: 'my dsm' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractLogSourceTypeSpecs', () => {
  it('reads name and default protocol from fields', () => {
    const specs = extractLogSourceTypeSpecs({
      items: [{ id: 'i1', name: 'My DSM', fields: { name: 'My DSM', defaultProtocolName: 'Syslog' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('My DSM')
    expect(specs[0].defaultProtocolName).toBe('Syslog')
  })
})
