import validate, { extractShapingProfileSpecs, parseJsonField } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('firewall-shaping-profiles validate', () => {
  it('accepts a valid profile with shaping entries', () => {
    const r = validate(ctxWith([{ name: 'Gold', fields: { profileName: 'Gold', type: 'queuing', defaultClassId: 2, shapingEntries: '[{"class-id":2,"priority":3}]' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a profile name', () => {
    const r = validate(ctxWith([{ name: '', fields: { type: 'policing' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid type', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { profileName: 'P', type: 'shaping' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_type')).toBe(true)
  })

  it('rejects invalid shaping entries JSON', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { profileName: 'P', type: 'policing', shapingEntries: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects non-array shaping entries', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { profileName: 'P', type: 'policing', shapingEntries: '{"class-id":1}' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json_shape')).toBe(true)
  })

  it('rejects duplicate profile names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { profileName: 'Dup', type: 'policing' } },
        { name: 'Dup', fields: { profileName: 'Dup', type: 'policing' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseJsonField', () => {
  it('treats empty as valid and undefined', () => {
    const p = parseJsonField('   ')
    expect(p.ok).toBe(true)
    expect(p.value).toBe(undefined)
  })

  it('flags malformed JSON', () => {
    expect(parseJsonField('[1,').ok).toBe(false)
  })
})

describe('extractShapingProfileSpecs', () => {
  it('uses profileName as the identity', () => {
    const specs = extractShapingProfileSpecs({
      items: [{ id: 'i1', name: 'fallback', fields: { profileName: 'Gold', type: 'QUEUING' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].profileName).toBe('Gold')
    expect(specs[0].type).toBe('queuing')
  })
})
