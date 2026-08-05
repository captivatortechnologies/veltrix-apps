import validate, { extractPublisherAlertsSpec, splitEntries } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const valid = { adminUsers: 'admin1@abc.com\nadmin2@abc.com', eventTypes: 'CONNECTION_FAILED', selectedUsers: 'abc@xyz.com,def@xyz.com' }

describe('npa-publishers-alerts-configuration validate', () => {
  it('accepts a valid configuration', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: { ...valid } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires admin users', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: { ...valid, adminUsers: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.adminUsers'))).toBe(true)
  })

  it('requires selected users', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: { ...valid, selectedUsers: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.selectedUsers'))).toBe(true)
  })

  it('requires at least one event type', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: { ...valid, eventTypes: '' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.eventTypes'))).toBe(true)
  })

  it('rejects an invalid event type', () => {
    const r = validate(ctxWith([{ name: 'Config', fields: { ...valid, eventTypes: 'publisher_up' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_event_type')).toBe(true)
  })

  it('rejects more than 5 event types', () => {
    const r = validate(
      ctxWith([
        {
          name: 'Config',
          fields: { ...valid, eventTypes: 'UPGRADE_WILL_START\nUPGRADE_STARTED\nUPGRADE_SUCCEEDED\nUPGRADE_FAILED\nCONNECTION_FAILED\nUPGRADE_STARTED' },
        },
      ])
    )
    expect(r.errors.some((e) => e.code === 'too_many')).toBe(true)
  })

  it('requires at least one item', () => {
    const r = validate(ctxWith([]))
    expect(r.valid).toBe(false)
  })

  it('warns when more than one item is declared', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { ...valid } }, { name: 'B', fields: { ...valid } }]))
    expect(r.warnings.some((w) => w.code === 'singleton')).toBe(true)
  })
})

describe('extractPublisherAlertsSpec', () => {
  it('reads and splits fields', () => {
    const spec = extractPublisherAlertsSpec({
      items: [{ id: 'i1', name: 'Config', fields: { ...valid } }],
    } as unknown as PipelineContext['canvas'])
    expect(spec.adminUsers).toEqual(['admin1@abc.com', 'admin2@abc.com'])
    expect(spec.eventTypes).toEqual(['CONNECTION_FAILED'])
    expect(spec.selectedUsers).toBe('abc@xyz.com,def@xyz.com')
  })
})

describe('splitEntries', () => {
  it('splits arrays and delimited strings, trimming', () => {
    expect(splitEntries(['a', ' b '])).toEqual(['a', 'b'])
    expect(splitEntries('a\nb, c')).toEqual(['a', 'b', 'c'])
  })
})
