import validate, { extractReportSpecs, splitValues } from '../validate'
import { buildReport } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(
  items: Array<{ id?: string; name: string; fields: Record<string, unknown> }>
): PipelineContext {
  return { canvas: { items } } as unknown as PipelineContext
}

const HASH = 'af62e6b3d475879c4234fe7bd8ba67ff6544ce6510131a069aaac75aa92aee7a'

describe('watchlist-reports validate', () => {
  it('accepts a valid hash report', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { title: 'R', description: 'd', severity: 5, iocField: 'process_hash', values: HASH } }]))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('requires title, description and at least one value', () => {
    const r = validate(ctxWith([{ name: '', fields: { iocField: 'process_hash' } }]))
    expect(r.errors.filter((e) => e.code === 'required').length >= 3).toBe(true)
  })

  it('rejects a severity out of range', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { title: 'R', description: 'd', severity: 99, iocField: 'netconn_domain', values: 'a.com' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_severity')).toBe(true)
  })

  it('rejects a bad sha256 for a hash report', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { title: 'R', description: 'd', severity: 5, iocField: 'process_hash', values: 'nothex' } }]))
    expect(r.errors.some((e) => e.code === 'invalid_hash')).toBe(true)
  })

  it('warns when a link is set (console non-editable)', () => {
    const r = validate(ctxWith([{ name: 'R', fields: { title: 'R', description: 'd', severity: 5, iocField: 'netconn_domain', values: 'a.com', link: 'https://x' } }]))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'console_noneditable')).toBe(true)
  })

  it('flags a duplicate title', () => {
    const r = validate(
      ctxWith([
        { name: 'A', fields: { title: 'Dup', description: 'd', severity: 5, iocField: 'netconn_domain', values: 'a.com' } },
        { name: 'B', fields: { title: 'dup', description: 'd', severity: 5, iocField: 'netconn_domain', values: 'b.com' } },
      ])
    )
    expect(r.errors.some((e) => e.code === 'duplicate_title')).toBe(true)
  })
})

describe('buildReport', () => {
  it('builds a report with one equality iocs_v2 entry and omits id on create', () => {
    const spec = extractReportSpecs(
      ctxWith([{ id: 'it-1', name: 'R', fields: { title: 'R', description: 'd', severity: 7, iocField: 'netconn_domain', values: 'a.com\nb.com' } }]).canvas
    )[0]
    const created = buildReport(spec, 100) as { id?: string; timestamp: number; severity: number; iocs_v2: Array<{ match_type: string; field: string; values: string[] }> }
    expect(created.id).toBe(undefined)
    expect(created.timestamp).toBe(100)
    expect(created.severity).toBe(7)
    expect(created.iocs_v2[0].match_type).toBe('equality')
    expect(created.iocs_v2[0].field).toBe('netconn_domain')
    expect(created.iocs_v2[0].values).toEqual(['a.com', 'b.com'])
    const updated = buildReport(spec, 100, 'rep-1') as { id?: string }
    expect(updated.id).toBe('rep-1')
  })
})

describe('splitValues', () => {
  it('splits and de-duplicates', () => {
    expect(splitValues('a\nb, a')).toEqual(['a', 'b'])
  })
})
