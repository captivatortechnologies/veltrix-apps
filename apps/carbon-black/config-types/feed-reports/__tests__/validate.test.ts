import validate, { extractReportSpecs, splitValues } from '../validate'
import { buildReport, reportIdFor } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

describe('feed-reports validate', () => {
  it('accepts a valid hash report', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { feedName: 'Bad', title: 'R', description: 'd', severity: 5, iocField: 'process_hash', values: HASH } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires feed name, title, description and at least one value', () => {
    const r = validate(ctxWith([{ name: '', fields: { iocField: 'process_hash' } }]))
    expect(r.errors.filter((e) => e.code === 'required').length >= 4).toBe(true)
  })

  it('rejects a severity out of range', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { feedName: 'F', title: 'R', description: 'd', severity: 42, iocField: 'netconn_domain', values: 'a.com' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects a bad sha256 for a hash report', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { feedName: 'F', title: 'R', description: 'd', severity: 5, iocField: 'process_hash', values: 'nothex' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_hash')).toBe(true)
  })

  it('rejects an invalid ioc field', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { feedName: 'F', title: 'R', description: 'd', severity: 5, iocField: 'weird', values: 'x' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_ioc_field')).toBe(true)
  })

  it('flags a duplicate title within the same feed', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { feedName: 'F', title: 'Dup', description: 'd', severity: 5, iocField: 'netconn_domain', values: 'a.com' } },
        { name: 'B', fields: { feedName: 'f', title: 'dup', description: 'd', severity: 5, iocField: 'netconn_domain', values: 'b.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_title')).toBe(true)
  })

  it('allows the same title in different feeds', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { feedName: 'F1', title: 'Same', description: 'd', severity: 5, iocField: 'netconn_domain', values: 'a.com' } },
        { name: 'B', fields: { feedName: 'F2', title: 'Same', description: 'd', severity: 5, iocField: 'netconn_domain', values: 'b.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_title')).toBe(false)
  })
})

describe('buildReport / reportIdFor', () => {
  it('builds a report with one equality iocs_v2 entry', () => {
    const spec = extractReportSpecs(
      ctxWith([{ id: 'it-1', name: 'R', fields: { feedName: 'F', title: 'R', description: 'd', severity: 7, iocField: 'netconn_domain', values: 'a.com\nb.com' } }]).canvas
    )[0]
    const id = reportIdFor(spec)
    const report = buildReport(spec, id, 100) as { id: string; timestamp: number; severity: number; iocs_v2: Array<{ match_type: string; field: string; values: string[] }> }
    expect(report.id).toBe('veltrix-it-1')
    expect(report.timestamp).toBe(100)
    expect(report.severity).toBe(7)
    expect(report.iocs_v2[0].match_type).toBe('equality')
    expect(report.iocs_v2[0].field).toBe('netconn_domain')
    expect(report.iocs_v2[0].values).toEqual(['a.com', 'b.com'])
  })
})

describe('splitValues', () => {
  it('splits and de-duplicates', () => {
    expect(splitValues('a\nb, a')).toEqual(['a', 'b'])
  })
})
