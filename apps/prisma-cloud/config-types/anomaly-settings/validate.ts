import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Prisma Cloud anomaly settings constraints -------------------------------
// Distinct from the Anomaly Trusted List type: this manages the tuning
// (alertDisposition / trainingModelThreshold) of Prisma's BUILT-IN, per-policy
// UEBA/anomaly-detection models — there is no create/delete, only GET-merge-POST
// of the two writable fields per built-in policyId. policyId is a raw id (this
// app does not resolve anomaly policy names — find the id via the Prisma Cloud
// Policies page filtered to policyType=anomaly, or GET /v2/policy).

export const ALERT_DISPOSITIONS = ['Aggressive', 'Moderate', 'Conservative']
export const TRAINING_MODEL_THRESHOLDS = ['Low', 'Medium', 'High']

export interface AnomalySettingsSpec {
  itemId?: string
  /** policyId — the identity (a built-in anomaly policy's id; not created/deleted by this app). */
  policyId: string
  /** '' means "leave unchanged". */
  alertDisposition: string
  trainingModelThreshold: string
}

/** One entry of GET /anomalies/settings — { [policyId]: AnomaliesSettings }. */
export interface LiveAnomalySettings {
  alertDisposition?: string
  trainingModelThreshold?: string
  policyName?: string
  policyDescription?: string
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function extractAnomalySettingsSpecs(canvas: CanvasSnapshot): AnomalySettingsSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      policyId: asString(f.policyId) || item.name,
      alertDisposition: asString(f.alertDisposition),
      trainingModelThreshold: asString(f.trainingModelThreshold),
    }
  })
}

/** The overlay to send to POST /anomalies/settings/{policyId} — only declared (non-blank) fields. */
export function buildOverlay(spec: AnomalySettingsSpec): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  if (spec.alertDisposition) o.alertDisposition = spec.alertDisposition
  if (spec.trainingModelThreshold) o.trainingModelThreshold = spec.trainingModelThreshold
  return o
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAnomalySettingsSpecs(ctx.canvas)
  const seenIds = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.policyId) {
      errors.push({ field: `${prefix}.policyId`, message: 'Policy id is required', code: 'required' })
    } else {
      const key = spec.policyId.toLowerCase()
      if (seenIds.has(key)) {
        errors.push({ field: `${prefix}.policyId`, message: `Duplicate policy id "${spec.policyId}"`, code: 'duplicate_policy_id' })
      }
      seenIds.add(key)
    }

    if (spec.alertDisposition && !ALERT_DISPOSITIONS.includes(spec.alertDisposition)) {
      errors.push({
        field: `${prefix}.alertDisposition`,
        message: `Alert disposition must be one of: ${ALERT_DISPOSITIONS.join(', ')}`,
        code: 'invalid_alert_disposition',
      })
    }

    if (spec.trainingModelThreshold && !TRAINING_MODEL_THRESHOLDS.includes(spec.trainingModelThreshold)) {
      errors.push({
        field: `${prefix}.trainingModelThreshold`,
        message: `Training model threshold must be one of: ${TRAINING_MODEL_THRESHOLDS.join(', ')}`,
        code: 'invalid_training_model_threshold',
      })
    }

    if (Object.keys(buildOverlay(spec)).length === 0) {
      warnings.push({ field: `${prefix}`, message: 'Neither alert disposition nor training model threshold is set — this item is a no-op', code: 'empty' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
