import validate, { parseLabels, extractDataAccessScopeSpecs } from '../validate'
import { labelRefs, refsSignature, createBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('data-access-scopes validate', () => {
  it('accepts a scope with allowed labels', () => {
    const r = validate(ctxWith([{ name: 'analysts', fields: { name: 'analysts', allowedLabels: 'dhcp_logs\nvpn_logs', description: 'd' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts an allow-all scope', () => {
    const r = validate(ctxWith([{ name: 'admins', fields: { name: 'admins', allowAll: true, deniedLabels: 'secret_logs' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires either allow-all or an allowed label', () => {
    const r = validate(ctxWith([{ name: 's', fields: { name: 's' } }]))
    expect(r.errors.some((e) => e.code === 'no_allow')).toBe(true)
  })

  it('rejects allow-all combined with allowed labels', () => {
    const r = validate(ctxWith([{ name: 's', fields: { name: 's', allowAll: true, allowedLabels: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'allow_all_conflict')).toBe(true)
  })

  it('rejects an invalid scope id', () => {
    const r = validate(ctxWith([{ name: '1bad', fields: { name: '1bad', allowAll: true } }]))
    expect(r.errors.some((e) => e.code === 'invalid_name')).toBe(true)
  })

  it('rejects duplicate scope names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { name: 'dup', allowAll: true } },
        { name: 'b', fields: { name: 'dup', allowAll: true } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseLabels / labelRefs / refsSignature', () => {
  it('parses and de-duplicates label ids', () => {
    expect(parseLabels('a\nb\na\n')).toEqual(['a', 'b'])
  })
  it('wraps ids as dataAccessLabel references', () => {
    expect(labelRefs(['a', 'b'])).toEqual([{ dataAccessLabel: 'a' }, { dataAccessLabel: 'b' }])
  })
  it('builds an order-independent signature', () => {
    expect(refsSignature([{ dataAccessLabel: 'b' }, { dataAccessLabel: 'a' }])).toBe(refsSignature([{ dataAccessLabel: 'a' }, { dataAccessLabel: 'b' }]))
  })
})

describe('createBody', () => {
  it('includes allowAll and the label reference sets', () => {
    const specs = extractDataAccessScopeSpecs(ctxWith([{ name: 's', fields: { name: 's', allowAll: true, deniedLabels: 'secret' } }]).canvas)
    const body = createBody(specs[0]) as { allowAll: boolean; deniedDataAccessLabels: Array<{ dataAccessLabel: string }> }
    expect(body.allowAll).toBe(true)
    expect(body.deniedDataAccessLabels).toEqual([{ dataAccessLabel: 'secret' }])
  })
})
