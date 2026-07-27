import validate, { extractQidRecordSpecs, parseMappings, recordKey } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const base = {
  logSourceType: 'Linux OS',
  name: 'Failed Login',
  lowLevelCategory: 'User Login Failure',
  eventMappings: '[{"eventId":"4625","eventCategory":"Security"}]',
}

describe('qid-records validate', () => {
  it('accepts a valid QID record', () => {
    const r = validate(ctxWith([{ name: 'Failed Login', fields: { ...base } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires type, name and category', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.field === 'items[0].logSourceType')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].name')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].lowLevelCategory')).toBe(true)
  })

  it('rejects a severity out of range', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, severity: 99 } }]))
    expect(r.errors.some((e) => e.code === 'out_of_range')).toBe(true)
  })

  it('rejects invalid event mappings JSON', () => {
    const r = validate(ctxWith([{ name: 'X', fields: { ...base, eventMappings: 'nope' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_event_mappings')).toBe(true)
  })

  it('warns that the type is append-only', () => {
    const r = validate(ctxWith([{ name: 'Failed Login', fields: { ...base } }]))
    expect(r.warnings.some((w) => w.code === 'append_only')).toBe(true)
  })
})

describe('parseMappings / recordKey / extractQidRecordSpecs', () => {
  it('parses event mappings', () => {
    const { mappings, error } = parseMappings('[{"eventId":"4625","eventCategory":"Security"}]')
    expect(error).toBe(undefined)
    expect(mappings).toHaveLength(1)
    expect(mappings[0].eventId).toBe('4625')
  })
  it('builds a case-insensitive record key', () => {
    expect(recordKey('Linux OS', 'Failed Login')).toBe(recordKey('linux os', 'failed login'))
  })
  it('reads fields', () => {
    const specs = extractQidRecordSpecs({
      items: [{ id: 'i1', name: 'Failed Login', fields: { ...base, severity: 5 } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].logSourceType).toBe('Linux OS')
    expect(specs[0].severity).toBe(5)
  })
})
