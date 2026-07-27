import validate, { isValidWildcardFqdn, extractWildcardFqdnSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-wildcard-fqdns validate', () => {
  it('accepts a valid wildcard FQDN', () => {
    const r = validate(ctxWith([{ name: 'CDN', fields: { name: 'CDN', wildcardFqdn: '*.example.com' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { wildcardFqdn: '*.example.com' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a wildcard FQDN pattern', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X' } }]))
    expect(r.errors.some((e) => e.code === 'missing_wildcard_fqdn')).toBe(true)
  })

  it('rejects an invalid wildcard FQDN', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', wildcardFqdn: 'not a domain' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_wildcard_fqdn')).toBe(true)
  })

  it('warns when the pattern has no wildcard', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { name: 'X', wildcardFqdn: 'plain.example.com' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'no_wildcard')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', wildcardFqdn: '*.a.com' } },
        { name: 'Dup', fields: { name: 'Dup', wildcardFqdn: '*.b.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidWildcardFqdn', () => {
  it('validates wildcard FQDN patterns', () => {
    expect(isValidWildcardFqdn('*.example.com')).toBe(true)
    expect(isValidWildcardFqdn('*.corp.*.example.com')).toBe(true)
    expect(isValidWildcardFqdn('example')).toBe(false)
    expect(isValidWildcardFqdn('has space.com')).toBe(false)
  })
})

describe('extractWildcardFqdnSpecs', () => {
  it('trims the pattern', () => {
    const specs = extractWildcardFqdnSpecs({
      items: [{ id: 'i1', name: 'X', fields: { name: 'X', wildcardFqdn: '  *.example.com  ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].wildcardFqdn).toBe('*.example.com')
  })
})
