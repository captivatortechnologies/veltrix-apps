import validate, { graphVisibility, extractAdministrativeUnitSpecs } from '../validate'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('administrative-units validate', () => {
  it('accepts a valid administrative unit', () => {
    const r = validate(ctxWith([{ name: 'West Region', fields: { name: 'West Region', description: 'West', visibility: 'public' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { description: 'x' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
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

  it('rejects an invalid visibility', () => {
    const r = validate(ctxWith([{ name: 'AU', fields: { name: 'AU', visibility: 'secret' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_visibility')).toBe(true)
  })

  it('enforces the description length limit', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', description: 'x'.repeat(1025) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })
})

describe('graphVisibility', () => {
  it('maps hidden membership to HiddenMembership and public to null', () => {
    expect(graphVisibility({ name: 'a', description: '', visibility: 'hiddenmembership', members: [] })).toBe('HiddenMembership')
    expect(graphVisibility({ name: 'a', description: '', visibility: 'public', members: [] })).toBe(null)
  })
})

describe('extractAdministrativeUnitSpecs — members', () => {
  it('reads members as an array (multiselect) value', () => {
    const canvas = { items: [{ fields: { name: 'AU', members: ['Ada Lovelace', 'g-1'] } }] } as unknown as CanvasSnapshot
    const [spec] = extractAdministrativeUnitSpecs(canvas)
    expect(spec.members).toEqual(['Ada Lovelace', 'g-1'])
  })

  it('defaults to an empty array when members is omitted', () => {
    const canvas = { items: [{ fields: { name: 'AU' } }] } as unknown as CanvasSnapshot
    const [spec] = extractAdministrativeUnitSpecs(canvas)
    expect(spec.members).toEqual([])
  })

  it('validate() accepts a unit with members declared', () => {
    const r = validate(ctxWith([{ name: 'AU', fields: { name: 'AU', members: ['Ada Lovelace'] } }]))
    expect(r.valid).toBe(true)
  })
})
