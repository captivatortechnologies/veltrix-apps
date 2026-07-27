import validate, { extractDnsProfileSpecs, parseConfigBlob } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('dns-profiles validate', () => {
  it('accepts a valid profile', () => {
    const r = validate(ctxWith([{ name: 'Corp DNS', fields: { name: 'Corp DNS', log_traffic: 'All DNS' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { log_traffic: 'Blocked DNS' } }]))
    expect(r.valid).toBe(false)
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid log_traffic', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', log_traffic: 'Everything' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_enum')).toBe(true)
  })

  it('rejects invalid JSON in a config blob', () => {
    const r = validate(ctxWith([{ name: 'A', fields: { name: 'A', log_traffic: 'All DNS', domain_config: '{not json' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { name: 'Dup', log_traffic: 'All DNS' } },
        { name: 'Dup', fields: { name: 'Dup', log_traffic: 'Blocked DNS' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('parseConfigBlob', () => {
  it('treats empty as not provided', () => {
    expect(parseConfigBlob('').provided).toBe(false)
    expect(parseConfigBlob('   ').provided).toBe(false)
  })

  it('parses a JSON object', () => {
    const r = parseConfigBlob('{"enable": true}')
    expect(r.provided).toBe(true)
    expect(r.value).toEqual({ enable: true })
  })

  it('reports invalid JSON and non-objects', () => {
    expect(typeof parseConfigBlob('{bad').error).toBe('string')
    expect(typeof parseConfigBlob('[1,2]').error).toBe('string')
  })
})

describe('extractDnsProfileSpecs', () => {
  it('reads fields and defaults log_traffic', () => {
    const specs = extractDnsProfileSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' Corp ', description: 'x' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('Corp')
    expect(specs[0].description).toBe('x')
    expect(specs[0].logTraffic).toBe('Blocked DNS')
  })
})
