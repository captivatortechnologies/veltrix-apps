import validate, { isValidIpv4, extractRadiusServerSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('user-radius-servers validate', () => {
  it('accepts a valid RADIUS server', () => {
    const r = validate(ctxWith([{ name: 'RAD', fields: { name: 'RAD', server: '10.0.0.20', secret: 's3cr3t', authType: 'pap' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { server: '10.0.0.20', secret: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('requires a server and a secret', () => {
    const r = validate(ctxWith([{ name: 'RAD', fields: { name: 'RAD' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.server'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.secret'))).toBe(true)
  })

  it('rejects an invalid auth type', () => {
    const r = validate(ctxWith([{ name: 'RAD', fields: { name: 'RAD', server: '10.0.0.20', secret: 'x', authType: 'eap' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_auth_type')).toBe(true)
  })

  it('rejects an invalid NAS IP', () => {
    const r = validate(ctxWith([{ name: 'RAD', fields: { name: 'RAD', server: '10.0.0.20', secret: 'x', nasIp: '999.1.1.1' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects an out-of-range port', () => {
    const r = validate(ctxWith([{ name: 'RAD', fields: { name: 'RAD', server: '10.0.0.20', secret: 'x', radiusPort: '0' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', server: 'a', secret: 'x' } },
        { name: 'Dup', fields: { name: 'Dup', server: 'b', secret: 'y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('isValidIpv4', () => {
  it('validates IPv4 addresses', () => {
    expect(isValidIpv4('10.0.0.20')).toBe(true)
    expect(isValidIpv4('256.0.0.1')).toBe(false)
  })
})

describe('extractRadiusServerSpecs', () => {
  it('defaults the auth type', () => {
    const specs = extractRadiusServerSpecs({
      items: [{ id: 'i1', name: 'RAD', fields: { name: 'RAD', server: '10.0.0.20', secret: 'x' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].authType).toBe('auto')
  })
})
