import validate, { extractServiceObjectSpecs, splitEntries } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('service-objects validate', () => {
  it('accepts a valid object', () => {
    const r = validate(ctxWith([{ name: 'Web', fields: { name: 'Web', tcp: '443\n80' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { tcp: '443' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', tcp: '443' } },
        { name: 'Dup', fields: { name: 'Dup', tcp: '80' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('requires at least one protocol', () => {
    const r = validate(ctxWith([{ name: 'Empty', fields: { name: 'Empty' } }]))
    expect(r.errors.some((e) => e.code === 'no_protocol')).toBe(true)
  })

  it('accepts icmp-only as satisfying the protocol requirement', () => {
    const r = validate(ctxWith([{ name: 'Ping', fields: { name: 'Ping', icmp: true } }]))
    expect(r.errors.some((e) => e.code === 'no_protocol')).toBe(false)
  })

  it('rejects an invalid port token', () => {
    const r = validate(ctxWith([{ name: 'Bad', fields: { name: 'Bad', tcp: 'not-a-port' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('accepts a port range', () => {
    const r = validate(ctxWith([{ name: 'Range', fields: { name: 'Range', tcp: '8080-9090' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(false)
  })
})

describe('extractServiceObjectSpecs', () => {
  it('reads fields and splits port lists', () => {
    const specs = extractServiceObjectSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Web ', tcp: '443\n80', udp: '53', icmp: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Web')
    expect(specs[0].tcp).toEqual(['443', '80'])
    expect(specs[0].udp).toEqual(['53'])
    expect(specs[0].icmp).toBe(true)
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitEntries('a\nb, c')).toEqual(['a', 'b', 'c'])
  })
})
