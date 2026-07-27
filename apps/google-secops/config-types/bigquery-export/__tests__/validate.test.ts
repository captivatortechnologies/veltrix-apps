import validate, { extractBigQueryExportSpec, BQ_SOURCES } from '../validate'
import { exportBody } from '../deploy'
import type { PipelineContext } from '@veltrixsecops/app-sdk'

function ctxWith(fields: Record<string, unknown>): PipelineContext {
  return { canvas: { items: [{ id: 'i1', name: 'bq', fields }] } } as unknown as PipelineContext
}

describe('bigquery-export validate', () => {
  it('accepts a valid singleton with an enabled source', () => {
    const r = validate(ctxWith({ udmEventsEnabled: true, udmEventsRetentionDays: 90 }))
    expect(r.valid).toBe(true)
    expect(r.errors).toHaveLength(0)
  })

  it('rejects a non-positive retention on an enabled source', () => {
    const r = validate(ctxWith({ ruleDetectionsEnabled: true, ruleDetectionsRetentionDays: 0 }))
    expect(r.errors.some((e) => e.code === 'invalid_retention')).toBe(true)
  })

  it('warns when no source is enabled', () => {
    const r = validate(ctxWith({}))
    expect(r.valid).toBe(true)
    expect(r.warnings.some((w) => w.code === 'none_enabled')).toBe(true)
  })
})

describe('extractBigQueryExportSpec / exportBody', () => {
  it('reads every source from the singleton item', () => {
    const spec = extractBigQueryExportSpec(ctxWith({ udmEventsEnabled: true, udmEventsRetentionDays: 90, entityGraphEnabled: false }).canvas)
    expect(spec?.sources.udmEvents.enabled).toBe(true)
    expect(spec?.sources.udmEvents.retentionDays).toBe(90)
    expect(spec?.sources.entityGraph.enabled).toBe(false)
  })

  it('builds a body with every managed source settings key', () => {
    const spec = extractBigQueryExportSpec(ctxWith({ iocMatchesEnabled: true, iocMatchesRetentionDays: 30 }).canvas)!
    const body = exportBody(spec) as Record<string, { enabled: boolean; retentionDays: number }>
    for (const s of BQ_SOURCES) {
      expect(typeof body[s.settings].enabled).toBe('boolean')
    }
    expect(body.iocMatchesSettings.enabled).toBe(true)
    expect(body.iocMatchesSettings.retentionDays).toBe(30)
  })
})
