import validate, { extractTenantConfigSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('tenant-config-singletons validate', () => {
  it('accepts a valid setting', () => {
    const r = validate(ctxWith([{ name: 's', fields: { setting: 'auth-org-lockout', config: '{"maximumAttempts":5}' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a setting and config', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].setting')).toBe(true)
  })

  it('rejects an unknown setting', () => {
    const r = validate(ctxWith([{ name: 's', fields: { setting: 'nope', config: '{}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects duplicate settings', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { setting: 'org-config', config: '{"a":1}' } },
        { name: 'b', fields: { setting: 'org-config', config: '{"a":2}' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_setting')).toBe(true)
  })
})

describe('extractTenantConfigSpecs', () => {
  it('stringifies an object config', () => {
    const specs = extractTenantConfigSpecs({
      items: [{ id: 'i1', name: 's', fields: { setting: 'org-config', config: { timeZone: 'UTC' } } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].configRaw).toBe('{"timeZone":"UTC"}')
  })
})
