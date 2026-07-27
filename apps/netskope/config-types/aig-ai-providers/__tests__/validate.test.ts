import validate, { extractAiProviderSpecs, asNumber } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const valid = { name: 'OpenAI', schema: 'openai', host: 'api.openai.com', port: 443, protocol: 'https' }

describe('aig-ai-providers validate', () => {
  it('accepts a valid provider', () => {
    const r = validate(ctxWith([{ name: 'OpenAI', fields: { ...valid } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, schema, host and protocol', () => {
    const r = validate(ctxWith([{ name: '', fields: { port: 443 } }]))
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.name'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.schema'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.host'))).toBe(true)
    expect(r.errors.some((e) => e.code === 'required' && e.field.endsWith('.protocol'))).toBe(true)
  })

  it('rejects an invalid port', () => {
    const r = validate(ctxWith([{ name: 'P', fields: { ...valid, port: 70000 } }]))
    expect(r.errors.some((e) => e.code === 'invalid_port')).toBe(true)
  })

  it('rejects duplicate names', () => {
    const r = validate(
      ctxWith([
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
        { name: 'Dup', fields: { ...valid, name: 'Dup' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_name')).toBe(true)
  })
})

describe('asNumber', () => {
  it('parses numbers and strings', () => {
    expect(asNumber(443, 0)).toBe(443)
    expect(asNumber('8080', 0)).toBe(8080)
    expect(asNumber('', 0)).toBe(0)
  })
})

describe('extractAiProviderSpecs', () => {
  it('reads fields and the numeric port', () => {
    const specs = extractAiProviderSpecs({
      items: [{ id: 'i1', name: 'F', fields: { name: ' OpenAI ', schema: 'openai', host: 'h', port: '443', protocol: 'https' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].name).toBe('OpenAI')
    expect(specs[0].port).toBe(443)
  })
})
