import validate, { extractDeliveryRouteDefinitionSpecs } from '../validate'
import { definitionEquals, buildPayload } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('delivery-route-definition validate', () => {
  it('accepts a valid definition', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { description: 'Primary MX', hostname: 'mx.example.com', port: 25 } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a description', () => {
    const r = validate(ctxWith([{ name: '', fields: { hostname: 'mx.example.com' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.description'))).toBe(true)
  })

  it('requires a hostname', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { description: 'D' } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.hostname'))).toBe(true)
  })

  it('rejects an invalid port', () => {
    const r = validate(ctxWith([{ name: 'D', fields: { description: 'D', hostname: 'mx.example.com', port: 70000 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects a duplicate description', () => {
    const r = validate(
      ctxWith([
        { name: 'D', fields: { description: 'Same', hostname: 'a.example.com' } },
        { name: 'D2', fields: { description: 'same', hostname: 'b.example.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_description')).toBe(true)
  })
})

describe('buildPayload / definitionEquals', () => {
  it('builds a create/update payload', () => {
    const spec = extractDeliveryRouteDefinitionSpecs(
      ctxWith([{ name: 'D', fields: { description: 'D', hostname: 'mx.example.com', port: 25, alternateRouteId: 'alt-1' } }]).canvas
    )[0]
    const payload = buildPayload(spec) as { description: string; hostname: string; port: number; alternateRouteId?: string }
    expect(payload.hostname).toBe('mx.example.com')
    expect(payload.port).toBe(25)
    expect(payload.alternateRouteId).toBe('alt-1')
  })

  it('never includes smtpAuthentication in the payload', () => {
    const spec = extractDeliveryRouteDefinitionSpecs(ctxWith([{ name: 'D', fields: { description: 'D', hostname: 'mx.example.com', port: 25 } }]).canvas)[0]
    const payload = buildPayload(spec) as Record<string, unknown>
    expect(payload.smtpAuthentication).toBeUndefined()
  })

  it('compares a live definition to the desired spec', () => {
    const spec = extractDeliveryRouteDefinitionSpecs(ctxWith([{ name: 'D', fields: { description: 'D', hostname: 'mx.example.com', port: 25 } }]).canvas)[0]
    const live = { id: 'R1', description: 'D', hostname: 'mx.example.com', port: 25 }
    expect(definitionEquals(live, spec)).toBe(true)
    const changed = { ...live, port: 587 }
    expect(definitionEquals(changed, spec)).toBe(false)
  })
})
