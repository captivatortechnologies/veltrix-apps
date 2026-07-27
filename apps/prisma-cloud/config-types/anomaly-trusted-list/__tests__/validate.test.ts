import validate, { parseEntries, extractAnomalyTrustedListSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const ENTRIES = '[{"ipCidr":"203.0.113.0/24"}]'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('anomaly-trusted-list validate', () => {
  it('accepts a valid trusted list', () => {
    const r = validate(ctxWith([{ name: 'Pentest IPs', fields: { name: 'Pentest IPs', trustedListType: 'ip', applicablePolicies: 'pol-1', trustedListEntries: ENTRIES } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { trustedListType: 'ip', applicablePolicies: 'pol-1', trustedListEntries: ENTRIES } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
  })

  it('rejects an unknown trusted list type', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', trustedListType: 'widget', applicablePolicies: 'pol-1', trustedListEntries: ENTRIES } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('requires at least one applicable policy', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', trustedListType: 'ip', trustedListEntries: ENTRIES } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.applicablePolicies'))).toBe(true)
  })

  it('rejects invalid entries JSON', () => {
    const r = validate(ctxWith([{ name: 'T', fields: { name: 'T', trustedListType: 'ip', applicablePolicies: 'pol-1', trustedListEntries: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_entries')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', trustedListType: 'ip', applicablePolicies: 'pol-1', trustedListEntries: ENTRIES } },
        { name: 'Dup', fields: { name: 'Dup', trustedListType: 'ip', applicablePolicies: 'pol-1', trustedListEntries: ENTRIES } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseEntries', () => {
  it('parses a JSON array string', () => {
    expect(parseEntries(ENTRIES).entries).toEqual([{ ipCidr: '203.0.113.0/24' }])
  })

  it('flags a non-array JSON value', () => {
    expect(parseEntries('{"a":1}').entriesError).toBe('Entries must be a JSON array')
  })
})

describe('extractAnomalyTrustedListSpecs', () => {
  it('defaults accountId and vpc to any', () => {
    const specs = extractAnomalyTrustedListSpecs({
      items: [{ id: 'i1', name: 'T', fields: { name: 'T', trustedListType: 'ip', applicablePolicies: 'pol-1', trustedListEntries: ENTRIES } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].accountId).toBe('any')
    expect(specs[0].vpc).toBe('any')
  })
})
