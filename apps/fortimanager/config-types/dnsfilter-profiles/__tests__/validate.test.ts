import validate, { isValidIpv4, parseBodyJson, extractDnsFilterProfileSpecs } from '../validate'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('dnsfilter-profiles validate', () => {
  it('accepts a valid profile', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', blockAction: 'redirect', redirectPortal: '10.0.0.1' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid block action', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', blockAction: 'drop' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_block_action')).toBe(true)
  })

  it('rejects an invalid redirect portal IP', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', redirectPortal: '10.0.0.999' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ip')).toBe(true)
  })

  it('rejects a malformed advanced body', () => {
    const r = validate(ctxWith([{ name: 'Corp', fields: { name: 'Corp', bodyJson: 'nope' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_json')).toBe(true)
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

describe('isValidIpv4 / parseBodyJson', () => {
  it('validates IPv4', () => {
    expect(isValidIpv4('10.0.0.1')).toBe(true)
    expect(isValidIpv4('10.0.0.256')).toBe(false)
  })
  it('accepts an empty body as an empty object', () => {
    expect(parseBodyJson('').ok).toBe(true)
  })
})

describe('extractDnsFilterProfileSpecs', () => {
  it('defaults the block action and lowercases it', () => {
    const specs = extractDnsFilterProfileSpecs({
      items: [{ id: 'i1', name: 'Corp', fields: { name: 'Corp', blockAction: 'BLOCK' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0].blockAction).toBe('block')
  })
})
