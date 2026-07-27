import validate, { extractLdapServerSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('user-ldap-servers validate', () => {
  it('accepts a simple LDAP server', () => {
    const r = validate(ctxWith([{ name: 'AD', fields: { name: 'AD', server: '10.0.0.10', type: 'simple', secure: 'ldaps' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { server: '10.0.0.10' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('requires a server address', () => {
    const r = validate(ctxWith([{ name: 'AD', fields: { name: 'AD', type: 'simple' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.server'))).toBe(true)
  })

  it('requires a bind DN for the regular type', () => {
    const r = validate(ctxWith([{ name: 'AD', fields: { name: 'AD', server: '10.0.0.10', type: 'regular' } }]))
    expect(r.errors.some((e) => e.code === 'missing_bind_dn')).toBe(true)
  })

  it('rejects an invalid secure mode', () => {
    const r = validate(ctxWith([{ name: 'AD', fields: { name: 'AD', server: '10.0.0.10', type: 'simple', secure: 'tls13' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_secure')).toBe(true)
  })

  it('rejects an out-of-range port', () => {
    const r = validate(ctxWith([{ name: 'AD', fields: { name: 'AD', server: '10.0.0.10', type: 'simple', port: '70000' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', server: 'a' } },
        { name: 'Dup', fields: { name: 'Dup', server: 'b' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractLdapServerSpecs', () => {
  it('defaults cnid, type and secure', () => {
    const specs = extractLdapServerSpecs({
      items: [{ id: 'i1', name: 'AD', fields: { name: 'AD', server: '10.0.0.10' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].cnid).toBe('cn')
    expect(specs[0].type).toBe('simple')
    expect(specs[0].secure).toBe('disable')
  })
})
