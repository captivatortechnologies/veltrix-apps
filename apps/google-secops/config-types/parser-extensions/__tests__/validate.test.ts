import validate, { extractParserExtensionSpecs } from '../validate'
import { extensionBody } from '../deploy'
import { decodeCbn } from '../../parsers/deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

describe('parser-extensions validate', () => {
  it('accepts a valid extension', () => {
    const r = validate(ctxWith([{ name: 'e1', fields: { logType: 'WINEVTLOG', cbnSnippet: 'filter { }' } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires a log type and a snippet', () => {
    const r = validate(ctxWith([{ name: '', fields: {} }]))
    expect(r.errors.some((e) => e.code === 'required')).toBe(true)
  })

  it('rejects an invalid log type', () => {
    const r = validate(ctxWith([{ name: 'e1', fields: { logType: 'bad!', cbnSnippet: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_log_type')).toBe(true)
  })

  it('rejects two extensions for the same log type', () => {
    const r = validate(
      ctxWith([
        { name: 'a', fields: { logType: 'WINEVTLOG', cbnSnippet: 'x' } },
        { name: 'b', fields: { logType: 'WINEVTLOG', cbnSnippet: 'y' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_log_type')).toBe(true)
  })
})

describe('extractParserExtensionSpecs / extensionBody', () => {
  it('maps items to specs', () => {
    const specs = extractParserExtensionSpecs(ctxWith([{ id: 'i1', name: 'e', fields: { logType: 'WINEVTLOG', cbnSnippet: 'filter { }', logSample: 'raw log' } }]).canvas)
    expect(specs[0].itemId).toBe('i1')
    expect(specs[0].logSample).toBe('raw log')
  })

  it('builds a base64 body including the sample when present', () => {
    const body = extensionBody({ logType: 'WINEVTLOG', cbnSnippet: 'filter { }', logSample: 'raw log' }) as { cbnSnippet: string; log?: string }
    expect(decodeCbn(body.cbnSnippet)).toBe('filter { }')
    expect(decodeCbn(body.log ?? '')).toBe('raw log')
  })

  it('omits the sample when not provided', () => {
    const body = extensionBody({ logType: 'WINEVTLOG', cbnSnippet: 'filter { }', logSample: '' }) as { cbnSnippet: string; log?: string }
    expect(body.log).toBe(undefined)
  })
})
