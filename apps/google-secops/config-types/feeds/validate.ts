import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Google SecOps data feed constraints -------------------------------------

/**
 * Known FeedSourceType enum values. The real enum is large and evolves (dozens of
 * third-party pullers), so an unrecognized value is a warning, not an error — the
 * hard requirements are a source type, a log type and a matching `*Settings` key.
 */
export const KNOWN_FEED_SOURCE_TYPES = [
  'HTTP',
  'API',
  'AMAZON_S3',
  'AMAZON_SQS',
  'AZURE_BLOBSTORE',
  'GOOGLE_CLOUD_STORAGE',
  'GOOGLE_CLOUD_STORAGE_V2',
  'KAFKA',
  'THIRD_PARTY_API',
  'HTTPS_PUSH_WEBHOOK',
  'HTTPS_PUSH_GOOGLE_CLOUD_PUBSUB',
  'HTTPS_PUSH_AMAZON_KINESIS_FIREHOSE',
] as const

export interface FeedSpec {
  itemId?: string
  /** displayName = the feed's identity we own (the feed id itself is a server UUID). */
  displayName: string
  detailsRaw: string
  /** Parsed `details` object, or null when the JSON is malformed. */
  details: Record<string, unknown> | null
  feedSourceType: string
  logType: string
}

/** A feed as returned by the SecOps API. `name` is `{parent}/feeds/{feedId}`. */
export interface LiveFeed {
  name?: string
  displayName?: string
  details?: { feedSourceType?: string; logType?: string; [k: string]: unknown }
  state?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** Parse the `details` JSON blob into an object, or null when it is not a JSON object. */
export function parseDetails(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** The `<source>Settings` key inside details (the one source-config object), if present. */
export function settingsKeyOf(details: Record<string, unknown> | null): string {
  if (!details) return ''
  return Object.keys(details).find((k) => k.endsWith('Settings')) ?? ''
}

export function extractFeedSpecs(canvas: CanvasSnapshot): FeedSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const detailsRaw = asString(f.details)
    const details = parseDetails(detailsRaw)
    return {
      itemId: item.id,
      displayName: asString(f.displayName) || item.name,
      detailsRaw,
      details,
      feedSourceType: details && typeof details.feedSourceType === 'string' ? details.feedSourceType : '',
      logType: details && typeof details.logType === 'string' ? details.logType : '',
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractFeedSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.displayName) {
      errors.push({ field: `${prefix}.displayName`, message: 'Display name is required', code: 'required' })
    } else {
      const key = spec.displayName.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.displayName`, message: `Duplicate feed "${spec.displayName}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.detailsRaw) {
      errors.push({ field: `${prefix}.details`, message: 'Feed details JSON is required', code: 'required' })
      return
    }
    if (!spec.details) {
      errors.push({ field: `${prefix}.details`, message: 'Feed details must be a JSON object', code: 'invalid_json' })
      return
    }

    if (!spec.feedSourceType) {
      errors.push({ field: `${prefix}.details`, message: 'Feed details must include a "feedSourceType"', code: 'missing_source_type' })
    } else if (!(KNOWN_FEED_SOURCE_TYPES as readonly string[]).includes(spec.feedSourceType)) {
      warnings.push({ field: `${prefix}.details`, message: `Unrecognized feedSourceType "${spec.feedSourceType}" — deploy will still send it; verify it against the SecOps feed catalog`, code: 'unknown_source_type' })
    }

    if (!spec.logType) {
      errors.push({ field: `${prefix}.details`, message: 'Feed details must include a "logType" (the full logTypes/{LOGTYPE} resource path)', code: 'missing_log_type' })
    }

    if (!settingsKeyOf(spec.details)) {
      errors.push({ field: `${prefix}.details`, message: 'Feed details must include exactly one "<source>Settings" object (e.g. httpSettings) for the chosen source type', code: 'missing_settings' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
