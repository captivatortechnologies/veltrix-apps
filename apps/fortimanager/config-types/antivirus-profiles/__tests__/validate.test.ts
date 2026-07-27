import validate, { extractAntivirusProfileSpecs, isPlainObject, asToggle } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('antivirus-profiles validate', () => {
  it('accepts a valid profile with per-protocol settings', () => {
    const r = validate(ctxWith([{ name: 'AV', fields: { name: 'AV', inspectionMode: 'flow', featureSet: 'flow', scanMode: 'full', protocols: '{"http":{"av-scan":"block"}}' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { protocols: '{}' } }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid inspection mode', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', inspectionMode: 'sniffer' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_mode')).toBe(true)
  })

  it('rejects an invalid scan mode', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', scanMode: 'turbo' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_scan_mode')).toBe(true)
  })

  it('rejects invalid protocols JSON', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', protocols: '{bad' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects a non-object protocols value', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { name: 'P', protocols: '[1,2]' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json_shape')).toBe(true)
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
})

describe('isPlainObject', () => {
  it('distinguishes objects from arrays and null', () => {
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
  })
})

describe('extractAntivirusProfileSpecs', () => {
  it('lowercases and defaults the modes', () => {
    const specs = extractAntivirusProfileSpecs({
      items: [{ id: 'i1', name: 'P', fields: { name: 'P', inspectionMode: 'FLOW', analyticsDb: true } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].inspectionMode).toBe('flow')
    expect(specs[0].featureSet).toBe('proxy')
    expect(specs[0].scanMode).toBe('default')
    expect(specs[0].analyticsDb).toBe('enable')
  })

  it('maps checkbox booleans via asToggle', () => {
    expect(asToggle(true)).toBe('enable')
    expect(asToggle(false)).toBe('disable')
  })
})
