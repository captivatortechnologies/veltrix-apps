import validate, { extractLogSourceGroupSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('log-source-groups validate', () => {
  it('accepts a valid root group', () => {
    const r = validate(ctxWith([{ name: 'Firewalls', fields: { name: 'Firewalls', description: 'All firewall log sources' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a valid child group referencing a parent declared in the same canvas', () => {
    const r = validate(ctxWith([
      { name: 'Network', fields: { name: 'Network' } },
      { name: 'Firewalls', fields: { name: 'Firewalls', parentName: 'Network' } },
    ]))
    expect(r.valid).toBe(true)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects a duplicate name', () => {
    const r = validate(ctxWith([
      { name: 'Firewalls', fields: { name: 'Firewalls' } },
      { name: 'firewalls', fields: { name: 'firewalls' } },
    ]))
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })

  it('rejects a group that is its own parent', () => {
    const r = validate(ctxWith([{ name: 'Loop', fields: { name: 'Loop', parentName: 'Loop' } }]))
    expect(r.errors.some((e) => e.code === 'self_parent')).toBe(true)
  })

  it('rejects a parent-chain cycle formed across items', () => {
    const r = validate(ctxWith([
      { name: 'A', fields: { name: 'A', parentName: 'B' } },
      { name: 'B', fields: { name: 'B', parentName: 'A' } },
    ]))
    expect(r.errors.some((e) => e.code === 'parent_cycle')).toBe(true)
  })

  it('rejects a description over 255 characters', () => {
    const r = validate(ctxWith([{ name: 'Firewalls', fields: { name: 'Firewalls', description: 'x'.repeat(256) } }]))
    expect(r.errors.some((e) => e.field === 'items[0].description')).toBe(true)
  })

  it('warns that groups are append-only', () => {
    const r = validate(ctxWith([{ name: 'Firewalls', fields: { name: 'Firewalls' } }]))
    expect(r.warnings.some((w) => w.code === 'append_only')).toBe(true)
  })
})

describe('extractLogSourceGroupSpecs', () => {
  it('reads name, description and parent from fields', () => {
    const specs = extractLogSourceGroupSpecs({
      items: [{ id: 'i1', name: 'Firewalls', fields: { name: 'Firewalls', description: 'desc', parentName: 'Network' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Firewalls')
    expect(specs[0].description).toBe('desc')
    expect(specs[0].parentName).toBe('Network')
  })
})
