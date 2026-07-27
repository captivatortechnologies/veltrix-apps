import validate, { splitCidrs, extractLoginIpAllowSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('login-ip-allow-list validate', () => {
  it('accepts a valid allow list', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', cidr: '203.0.113.0/24\n198.51.100.42' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { cidr: '203.0.113.0/24' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires at least one CIDR', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', cidr: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.cidr'))).toBe(true)
  })

  it('rejects an invalid CIDR', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', cidr: 'not-an-ip' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_cidr')).toBe(true)
  })

  it('rejects more than ten CIDRs', () => {
    const many = Array.from({ length: 11 }, (_, i) => `10.0.${i}.0/24`).join('\n')
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', cidr: many } }]))
    expect(r.errors.some((e) => e.code === 'too_many_cidrs')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', cidr: '10.0.0.0/8' } },
        { name: 'Dup', fields: { name: 'Dup', cidr: '10.0.0.0/8' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitCidrs', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitCidrs('10.0.0.0/8\n10.0.0.0/8, 192.168.0.0/16')).toEqual(['10.0.0.0/8', '192.168.0.0/16'])
    expect(splitCidrs(['a', ' a ', 'b'])).toEqual(['a', 'b'])
    expect(splitCidrs('')).toEqual([])
  })
})

describe('extractLoginIpAllowSpecs', () => {
  it('parses the CIDR list', () => {
    const specs = extractLoginIpAllowSpecs({
      items: [{ id: 'i1', name: 'Corp', fields: { name: 'Corp', cidr: '10.0.0.0/8\n192.168.0.0/16' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].cidr).toEqual(['10.0.0.0/8', '192.168.0.0/16'])
  })
})
