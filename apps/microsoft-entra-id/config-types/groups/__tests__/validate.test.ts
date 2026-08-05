import validate, { slugifyNickname, isManageableSecurityGroup, extractGroupSpecs } from '../validate'
import type { CanvasSnapshot, PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'SOC Analysts', fields: { name: 'SOC Analysts', description: 'Tier 1' } }]))
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

  it('rejects an invalid explicit mail nickname', () => {
    const r = validate(ctxWith([{ name: 'Team', fields: { name: 'Team', mailNickname: 'has spaces' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_mail_nickname')).toBe(true)
  })

  it('rejects a name that cannot derive a mail nickname', () => {
    const r = validate(ctxWith([{ name: '***', fields: { name: '***' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'invalid_mail_nickname')).toBe(true)
  })

  it('enforces the description length limit', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', description: 'x'.repeat(1025) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })
})

describe('slugifyNickname', () => {
  it('slugifies a display name into a valid mail nickname', () => {
    expect(slugifyNickname('SOC Analysts')).toBe('SOC-Analysts')
    expect(slugifyNickname('  Corp / IT  ')).toBe('Corp-IT')
    expect(slugifyNickname('***')).toBe('')
  })
})

describe('extractGroupSpecs owners/members', () => {
  it('accepts an array value (remote-multiselect) as-is', () => {
    const canvas = { items: [{ id: 'i1', name: 'G', fields: { name: 'G', owners: ['u-1', 'sp-1'], members: ['u-1', 'g-2'] } }] } as unknown as CanvasSnapshot
    const [spec] = extractGroupSpecs(canvas)
    expect(spec.owners).toEqual(['u-1', 'sp-1'])
    expect(spec.members).toEqual(['u-1', 'g-2'])
  })

  it('splits a delimited string value (legacy pre-picker convention) by newline/comma', () => {
    const canvas = { items: [{ id: 'i1', name: 'G', fields: { name: 'G', owners: 'u-1,u-2\nu-3' } }] } as unknown as CanvasSnapshot
    const [spec] = extractGroupSpecs(canvas)
    expect(spec.owners).toEqual(['u-1', 'u-2', 'u-3'])
  })

  it('defaults to an empty array when unset', () => {
    const canvas = { items: [{ id: 'i1', name: 'G', fields: { name: 'G' } }] } as unknown as CanvasSnapshot
    const [spec] = extractGroupSpecs(canvas)
    expect(spec.owners).toEqual([])
    expect(spec.members).toEqual([])
  })
})

describe('isManageableSecurityGroup', () => {
  it('accepts a plain assigned security group', () => {
    expect(isManageableSecurityGroup({ securityEnabled: true, mailEnabled: false, groupTypes: [] })).toBe(true)
  })
  it('protects mail-enabled, M365 and dynamic groups', () => {
    expect(isManageableSecurityGroup({ mailEnabled: true })).toBe(false)
    expect(isManageableSecurityGroup({ securityEnabled: true, groupTypes: ['Unified'] })).toBe(false)
    expect(isManageableSecurityGroup({ securityEnabled: true, groupTypes: ['DynamicMembership'] })).toBe(false)
  })
})
