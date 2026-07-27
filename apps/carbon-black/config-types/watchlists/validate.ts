import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Carbon Black watchlist constraints --------------------------------------

/** The classifier key a feed-subscription watchlist matches on. */
export const FEED_CLASSIFIER_KEY = 'feed_id' as const

export interface WatchlistSpec {
  itemId?: string
  /** name — the watchlist's human identity (watchlists are id-addressed; matched by name). */
  name: string
  description: string
  /** the feed_id this watchlist subscribes to (goes into classifier.value). */
  feedId: string
  tagsEnabled: boolean
  alertsEnabled: boolean
}

/** A watchlist as returned by the watchlist manager. */
export interface LiveWatchlist {
  id?: string
  name?: string
  description?: string
  tags_enabled?: boolean
  alerts_enabled?: boolean
  classifier?: { key?: string; value?: string } | null
  report_ids?: string[] | null
  create_timestamp?: number
  last_update_timestamp?: number
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true'
}

export function extractWatchlistSpecs(canvas: CanvasSnapshot): WatchlistSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      description: asString(f.description),
      feedId: asString(f.feedId),
      tagsEnabled: f.tags_enabled === undefined ? true : asBool(f.tags_enabled),
      alertsEnabled: asBool(f.alerts_enabled),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractWatchlistSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate watchlist "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.feedId) errors.push({ field: `${prefix}.feedId`, message: 'Feed ID is required', code: 'required' })

    if (spec.alertsEnabled && !spec.tagsEnabled) {
      errors.push({ field: `${prefix}.alerts_enabled`, message: 'Alerts can only be enabled when tags are enabled', code: 'alerts_require_tags' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
