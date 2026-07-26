import validate, { extractFeedSpecs, splitValues } from '../validate'
import { buildReport, feedinfoBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

describe('threat-feeds validate', () => {
  it('accepts a valid hash feed', () => {
    const r = validate(ctxWith([{ name: 'Bad', fields: { name: 'Bad', providerUrl: 'https://x', summary: 's', iocField: 'process_hash', values: HASH } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires name, provider url and summary', () => {
    const r = validate(ctxWith([{ name: '', fields: { iocField: 'process_hash' } }]))
    expect(r.errors.filter((e) => e.code === 'required').length >= 3).toBe(true)
  })

  it('rejects a bad sha256 for a hash feed', () => {
    const r = validate(ctxWith([{ name: 'F', fields: { name: 'F', providerUrl: 'https://x', summary: 's', iocField: 'process_hash', values: 'nothex' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_hash')).toBe(true)
  })

  it('rejects an invalid ioc field', () => {
    const r = validate(ctxWith([{ name: 'F', fields: { name: 'F', providerUrl: 'https://x', summary: 's', iocField: 'weird' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ioc_field')).toBe(true)
  })

  it('warns on a feed with no IOC values', () => {
    const r = validate(ctxWith([{ name: 'F', fields: { name: 'F', providerUrl: 'https://x', summary: 's', iocField: 'netconn_domain' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'empty_feed')).toBe(true)
  })
})

describe('buildReport / feedinfoBody', () => {
  it('builds a report with one iocs_v2 entry and feedinfo', () => {
    const spec = extractFeedSpecs(
      ctxWith([{ name: 'F', fields: { name: 'F', providerUrl: 'https://x', summary: 's', category: 'c', iocField: 'netconn_domain', values: 'a.com\nb.com' } }]).canvas
    )[0]
    const report = buildReport(spec, 100) as { timestamp: number; iocs_v2: Array<{ field: string; values: string[] }> }
    expect(report.timestamp).toBe(100)
    expect(report.iocs_v2[0].field).toBe('netconn_domain')
    expect(report.iocs_v2[0].values).toEqual(['a.com', 'b.com'])
    const info = feedinfoBody(spec)
    expect(info.name).toBe('F')
    expect(info.provider_url).toBe('https://x')
    expect(info.category).toBe('c')
  })
})

describe('splitValues', () => {
  it('splits and de-duplicates', () => {
    expect(splitValues('a\nb, a')).toEqual(['a', 'b'])
  })
})
