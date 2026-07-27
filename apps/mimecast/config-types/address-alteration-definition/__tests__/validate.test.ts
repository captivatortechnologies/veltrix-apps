import validate, { extractAddressAlterationDefinitionSpecs, definitionKey, liveDefinitionKey } from '../validate'
import { buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('address-alteration-definition validate', () => {
  it('accepts a valid definition', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { folderId: 'SET1', routing: 'inbound', addressType: 'from', originalAddress: 'old@example.com', newAddress: 'new@example.com' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires an original and new address', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { routing: 'all', addressType: 'from' } }]))
    expect(r.errors.some((e) => e.field === 'items[0].originalAddress' && e.code === 'required')).toBe(true)
    expect(r.errors.some((e) => e.field === 'items[0].newAddress' && e.code === 'required')).toBe(true)
  })

  it('rejects a malformed address', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { routing: 'all', addressType: 'from', originalAddress: 'nope', newAddress: 'new@example.com' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_address')).toBe(true)
  })

  it('accepts wildcard address forms', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { routing: 'all', addressType: 'from', originalAddress: '*@old.example', newAddress: 'local@*' } }]))
    expect(r.valid).toBe(true)
  })

  it('rejects an invalid routing', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { routing: 'sideways', addressType: 'from', originalAddress: 'a@b.com', newAddress: 'c@d.com' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_routing')).toBe(true)
  })

  it('rejects an invalid address type', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { routing: 'all', addressType: 'nope', originalAddress: 'a@b.com', newAddress: 'c@d.com' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_address_type')).toBe(true)
  })

  it('rejects a duplicate rule tuple', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { routing: 'all', addressType: 'from', originalAddress: 'a@b.com', newAddress: 'c@d.com' } },
        { name: 'B', fields: { routing: 'all', addressType: 'from', originalAddress: 'a@b.com', newAddress: 'c@d.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_definition')).toBe(true)
  })
})

describe('definitionKey / buildPayload', () => {
  it('builds a nested addressAlterations payload and matches a live tuple', () => {
    const spec = extractAddressAlterationDefinitionSpecs(
      ctxWith([{ name: 'D', fields: { folderId: 'SET1', routing: 'inbound', addressType: 'from', originalAddress: 'Old@Example.com', newAddress: 'new@example.com' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { folderId: string; addressAlterations: Array<{ routing: string; addressType: string; originalAddress: string; newAddress: string }> }
    expect(payload.folderId).toBe('SET1')
    expect(payload.addressAlterations[0].routing).toBe('inbound')
    expect(payload.addressAlterations[0].originalAddress).toBe('Old@Example.com')
    expect(definitionKey(spec)).toBe('SET1|inbound|from|old@example.com|new@example.com')
    expect(liveDefinitionKey({ folderId: 'SET1', routing: 'inbound', addressType: 'from', originalAddress: 'old@example.com', newAddress: 'new@example.com' })).toBe(definitionKey(spec))
  })
})
