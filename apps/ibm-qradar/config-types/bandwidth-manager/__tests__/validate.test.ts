import validate, { extractBandwidthConfigSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('bandwidth-manager validate', () => {
  it('accepts a valid configuration', () => {
    const r = validate(ctxWith([{ name: 'Cap-A', fields: { name: 'Cap-A', hostId: -1, kbLimit: 1024 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { kbLimit: 100 } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a non-positive KB limit', () => {
    const r = validate(ctxWith([{ name: 'Cap-A', fields: { name: 'Cap-A', kbLimit: 0 } }]))
    expect(r.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('rejects an invalid host id', () => {
    const r = validate(ctxWith([{ name: 'Cap-A', fields: { name: 'Cap-A', hostId: 0, kbLimit: 10 } }]))
    expect(r.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'Cap-A', fields: { name: 'Cap-A', kbLimit: 10 } },
      { name: 'cap-a', fields: { name: 'cap-a', kbLimit: 20 } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractBandwidthConfigSpecs', () => {
  it('reads fields and defaults host id to -1', () => {
    const specs = extractBandwidthConfigSpecs({
      items: [{ id: 'i1', name: 'Cap-A', fields: { name: 'Cap-A', kbLimit: 512 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Cap-A')
    expect(specs[0].hostId).toBe(-1)
    expect(specs[0].kbLimit).toBe(512)
  })
})
