import validate, { extractMfaConfigSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('mfa-configs validate', () => {
  it('accepts a valid method config', () => {
    const r = validate(ctxWith([{ name: 'duo', fields: { method: 'duo-web', enabled: true, configProperties: '{"host":"api.duo"}' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('rejects an unknown method', () => {
    const r = validate(ctxWith([{ name: 'x', fields: { method: 'sms' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('warns when enabling without config properties', () => {
    const r = validate(ctxWith([{ name: 'okta', fields: { method: 'okta-verify', enabled: true } }]))
    expect(r.warnings.some((w) => w.code === 'empty_config')).toBe(true)
  })

  it('rejects duplicate methods', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { method: 'duo-web' } },
        { name: 'b', fields: { method: 'duo-web' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_method')).toBe(true)
  })
})

describe('extractMfaConfigSpecs', () => {
  it('stringifies an object configProperties blob', () => {
    const specs = extractMfaConfigSpecs({
      items: [{ id: 'i1', name: 'duo', fields: { method: 'duo-web', configProperties: { host: 'h' } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].configPropertiesRaw).toBe('{"host":"h"}')
  })
})
