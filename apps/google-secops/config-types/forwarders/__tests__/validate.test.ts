import validate, { extractForwarderSpecs, parseConfig } from '../validate'
import { forwarderBody, forwarderIdOf, resolveForwarder } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

const CONFIG = JSON.stringify({ uploadCompression: true, metadata: { assetNamespace: 'corp' } })

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('forwarders validate', () => {
  it('accepts a valid forwarder', () => {
    const r = validate(ctxWith([{ name: 'f1', fields: { displayName: 'Prod forwarder', config: CONFIG } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('accepts a forwarder with no config', () => {
    const r = validate(ctxWith([{ name: 'f1', fields: { displayName: 'bare' } }]))
    expect(r.valid).toBe(true)
  })

  it('requires a display name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects malformed config JSON', () => {
    const r = validate(ctxWith([{ name: 'f1', fields: { displayName: 'x', config: '{bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate display names', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { displayName: 'dup' } },
        { name: 'b', fields: { displayName: 'dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('extractForwarderSpecs / forwarderBody / helpers', () => {
  it('maps items to specs with a parsed config', () => {
    const specs = extractForwarderSpecs(ctxWith([{ id: 'i1', name: 'f', fields: { displayName: 'Prod', config: CONFIG } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].displayName).toBe('Prod')
    expect((specs[0].config as { uploadCompression: boolean }).uploadCompression).toBe(true)
  })

  it('builds a create/update body and finds the id tail', () => {
    const specs = extractForwarderSpecs(ctxWith([{ name: 'f', fields: { displayName: 'Prod', config: CONFIG } }]).canvas)
    const body = forwarderBody(specs[0]) as { displayName: string; config: Record<string, unknown> }
    expect(body.displayName).toBe('Prod')
    expect(forwarderIdOf('projects/p/locations/us/instances/i/forwarders/fwd-9')).toBe('fwd-9')
  })

  it('resolves a forwarder by display name', () => {
    const live = [{ name: 'projects/p/.../forwarders/a', displayName: 'Prod' }]
    expect(resolveForwarder(live, 'Prod')?.name).toBe('projects/p/.../forwarders/a')
    expect(parseConfig('{}')).toEqual({})
  })
})
