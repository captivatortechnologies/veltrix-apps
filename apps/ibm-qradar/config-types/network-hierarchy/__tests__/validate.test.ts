import validate, { extractNetworkEntrySpecs, networkKey } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('network-hierarchy validate', () => {
  it('accepts a valid network object', () => {
    const r = validate(ctxWith([{ name: 'Cloud-A', fields: { group: 'Cloud', name: 'Cloud-A', cidr: '10.10.0.0/16' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires group, name and cidr', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].group')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].cidr')).toBe(true)
  })

  it('rejects an invalid CIDR', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { group: 'G', name: 'X', cidr: 'bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects duplicate (group, name)', () => {
    const r = validate(ctxWith([
      { name: 'X', fields: { group: 'G', name: 'X', cidr: '10.0.0.0/8' } },
      { name: 'x', fields: { group: 'g', name: 'x', cidr: '10.0.0.0/8' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('networkKey / extractNetworkEntrySpecs', () => {
  it('builds a case-insensitive composite key', () => {
    expect(networkKey('Cloud', 'A')).toBe(networkKey('cloud', 'a'))
  })
  it('reads fields', () => {
    const specs = extractNetworkEntrySpecs({
      items: [{ id: 'i1', name: 'Cloud-A', fields: { group: 'Cloud', name: 'Cloud-A', cidr: '10.10.0.0/16', domainId: 2 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].group).toBe('Cloud')
    expect(specs[0].domainId).toBe(2)
  })
})
