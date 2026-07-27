import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps BigQuery Export constraints -------------------------------
// BigQuery Export is an instance SINGLETON: there is no create/list/delete, only
// a get + patch of per-data-source export toggles. This type manages it as ONE
// config object (a non-repeatable item).

/** The per-data-source export settings this type manages (proto field ⇄ canvas key). */
export const BQ_SOURCES = [
  { key: 'udmEvents', settings: 'udmEventsSettings', label: 'UDM Events' },
  { key: 'udmEventsAggregates', settings: 'udmEventsAggregatesSettings', label: 'UDM Events Aggregates' },
  { key: 'ruleDetections', settings: 'ruleDetectionsSettings', label: 'Rule Detections' },
  { key: 'iocMatches', settings: 'iocMatchesSettings', label: 'IoC Matches' },
  { key: 'entityGraph', settings: 'entityGraphSettings', label: 'Entity Graph' },
] as const

export interface SourceSetting {
  enabled: boolean
  retentionDays: number
}

export interface BigQueryExportSpec {
  itemId?: string
  /** Keyed by BQ_SOURCES[].key. */
  sources: Record<string, SourceSetting>
}

/** BigQuery Export as returned by the SecOps API — each source is a DataSourceExportSettings. */
export interface LiveBigQueryExport {
  name?: string
  provisioned?: boolean
  udmEventsSettings?: { enabled?: boolean; retentionDays?: number }
  udmEventsAggregatesSettings?: { enabled?: boolean; retentionDays?: number }
  ruleDetectionsSettings?: { enabled?: boolean; retentionDays?: number }
  iocMatchesSettings?: { enabled?: boolean; retentionDays?: number }
  entityGraphSettings?: { enabled?: boolean; retentionDays?: number }
}

function asBool(v: unknown): boolean {
  return v === true
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return 0
}

export function extractBigQueryExportSpec(canvas: CanvasSnapshot): BigQueryExportSpec | null {
  const items = canvas.items ?? canvas.sections ?? []
  const item = items[0]
  if (!item) return null
  const f = item.fields ?? {}
  const sources: Record<string, SourceSetting> = {}
  for (const s of BQ_SOURCES) {
    sources[s.key] = { enabled: asBool(f[`${s.key}Enabled`]), retentionDays: asNumber(f[`${s.key}RetentionDays`]) }
  }
  return { itemId: item.id, sources }
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const spec = extractBigQueryExportSpec(ctx.canvas)

  if (!spec) return { valid: true, errors, warnings }

  let anyEnabled = false
  for (const s of BQ_SOURCES) {
    const setting = spec.sources[s.key]
    if (setting.enabled) {
      anyEnabled = true
      if (!Number.isInteger(setting.retentionDays) || setting.retentionDays <= 0) {
        errors.push({ field: `items[0].${s.key}RetentionDays`, message: `${s.label} is enabled — its retention days must be a positive whole number`, code: 'invalid_retention' })
      }
    }
  }

  if (!anyEnabled) {
    warnings.push({ field: 'items[0]', message: 'No data source is enabled for BigQuery export — deploy will disable all managed exports', code: 'none_enabled' })
  }

  return { valid: errors.length === 0, errors, warnings }
}
