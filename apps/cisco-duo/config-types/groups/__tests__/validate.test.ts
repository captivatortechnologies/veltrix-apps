import validate, { extractGroupSpecs } from '../validate'
import { duoEncode, canonicalParams, rfc2822 } from '../../../lib/duo'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('groups validate', () => {
  it('accepts a valid group', () => {
    const r = validate(ctxWith([{ name: 'SOC', fields: { name: 'SOC', desc: 'Tier 1' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a name', () => {
    const r = validate(ctxWith([{ name: '', fields: { desc: 'x' } }]))
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

  it('enforces the description length limit', () => {
    const r = validate(ctxWith([{ name: 'G', fields: { name: 'G', desc: 'x'.repeat(256) } }]))
    expect(r.errors.some((e) => e.code === 'too_long')).toBe(true)
  })
})

describe('extractGroupSpecs', () => {
  it('reads name and desc, trimming', () => {
    const specs = extractGroupSpecs({
      items: [{ id: 'i1', name: 'Fallback', fields: { name: '  Real  ', desc: ' d ' } }],
    } as unknown as PipelineContext['canvas'])
    expect(specs[0]).toEqual({ itemId: 'i1', name: 'Real', desc: 'd' })
  })
})

describe('duo signing helpers', () => {
  it('percent-encodes per RFC 3986 (space, and !*\'())', () => {
    expect(duoEncode('First Last')).toBe('First%20Last')
    expect(duoEncode("a!*'()")).toBe('a%21%2A%27%28%29')
    expect(duoEncode('keep-_.~')).toBe('keep-_.~')
  })

  it('builds sorted, encoded canonical params', () => {
    expect(canonicalParams({ username: 'root', realname: 'First Last' })).toBe(
      'realname=First%20Last&username=root'
    )
    expect(canonicalParams({})).toBe('')
  })

  it('formats an RFC 2822 UTC date with a -0000 offset', () => {
    // 2012-08-21T17:29:18Z — Duo's own documented example.
    const d = new Date(Date.UTC(2012, 7, 21, 17, 29, 18))
    expect(rfc2822(d)).toBe('Tue, 21 Aug 2012 17:29:18 -0000')
  })
})
