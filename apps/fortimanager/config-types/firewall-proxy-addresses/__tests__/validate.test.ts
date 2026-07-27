import validate, { splitList, liveStringList, extractProxyAddressSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-proxy-addresses validate', () => {
  it('accepts a valid url proxy address', () => {
    const r = validate(ctxWith([{ name: 'Docs', fields: { name: 'Docs', type: 'url', host: 'ExampleHost', path: '/docs.*' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid method proxy address', () => {
    const r = validate(ctxWith([{ name: 'Writes', fields: { name: 'Writes', type: 'method', host: 'ExampleHost', methods: 'post\nput' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'url', host: 'H', path: '/x' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', type: 'category' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires host and path for a url type', () => {
    const r = validate(ctxWith([{ name: 'U', fields: { name: 'U', type: 'url' } }]))
    expect(r.errors.some((e) => e.code === 'missing_host')).toBe(true)
    expect(r.errors.some((e) => e.code === 'missing_path')).toBe(true)
  })

  it('rejects an invalid HTTP method', () => {
    const r = validate(ctxWith([{ name: 'M', fields: { name: 'M', type: 'method', host: 'H', methods: 'fetch' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_method')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', type: 'url', host: 'H', path: '/a' } },
        { name: 'Dup', fields: { name: 'Dup', type: 'url', host: 'H', path: '/b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('splitList / liveStringList', () => {
  it('splits, lowercases and de-duplicates', () => {
    expect(splitList('GET\nPost, get')).toEqual(['get', 'post'])
  })
  it('normalizes live enum lists of strings or objects', () => {
    expect(liveStringList(['get', { method: 'post' }])).toEqual(['get', 'post'])
  })
})

describe('extractProxyAddressSpecs', () => {
  it('defaults and lowercases the type', () => {
    const specs = extractProxyAddressSpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', type: 'URL', host: 'H', path: '/x' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].type).toBe('url')
  })
})
