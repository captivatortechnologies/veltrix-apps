import validate, { extractDataAccessLabelSpecs } from '../validate'
import { labelBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('data-access-labels validate', () => {
  it('accepts a valid label', () => {
    const r = validate(ctxWith([{ name: 'dhcp_logs', fields: { name: 'dhcp_logs', udmQuery: 'metadata.log_type = "WINDOWS_DHCP"', description: 'd' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name and a UDM query', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid label id', () => {
    const r = validate(ctxWith([{ name: '1bad', fields: { name: '1bad', udmQuery: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects duplicate label names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { name: 'dup', udmQuery: 'x' } },
        { name: 'b', fields: { name: 'dup', udmQuery: 'y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractDataAccessLabelSpecs / labelBody', () => {
  it('maps items to specs with the identity and definition', () => {
    const specs = extractDataAccessLabelSpecs(ctxWith([{ id: 'i1', name: 'l', fields: { name: 'dhcp', udmQuery: 'q', description: 'd' } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].name).toBe('dhcp')
    expect(specs[0].udmQuery).toBe('q')
  })
  it('builds a create/update body with the udmQuery and description', () => {
    const body = labelBody({ name: 'dhcp', udmQuery: 'q', description: 'd' }) as { udmQuery: string; description: string }
    expect(body.udmQuery).toBe('q')
    expect(body.description).toBe('d')
  })
})
