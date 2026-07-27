import validate, { parseBodyJson, asBool, extractSslSshProfileSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('ssl-ssh-profiles validate', () => {
  it('accepts a valid profile', () => {
    const r = validate(ctxWith([{ name: 'Deep', fields: { name: 'Deep', serverCertMode: 're-sign' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid per-protocol body', () => {
    const r = validate(ctxWith([{ name: 'Deep', fields: { name: 'Deep', bodyJson: '{"https":{"status":"deep-inspection"}}' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid server certificate mode', () => {
    const r = validate(ctxWith([{ name: 'Deep', fields: { name: 'Deep', serverCertMode: 'passthrough' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_server_cert_mode')).toBe(true)
  })

  it('rejects a malformed advanced body', () => {
    const r = validate(ctxWith([{ name: 'Deep', fields: { name: 'Deep', bodyJson: '{oops' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup' } },
        { name: 'Dup', fields: { name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseBodyJson / asBool', () => {
  it('rejects a non-object body', () => {
    expect(parseBodyJson('"x"').ok).toBe(false)
  })
  it('reads enable / 1 as true', () => {
    expect(asBool('enable')).toBe(true)
    expect(asBool(0)).toBe(false)
  })
})

describe('extractSslSshProfileSpecs', () => {
  it('defaults the server certificate mode', () => {
    const specs = extractSslSshProfileSpecs({
      items: [{ id: 'i1', name: 'Deep', fields: { name: 'Deep' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].serverCertMode).toBe('re-sign')
    expect(specs[0].blockBlocklistedCertificates).toBe(false)
  })
})
