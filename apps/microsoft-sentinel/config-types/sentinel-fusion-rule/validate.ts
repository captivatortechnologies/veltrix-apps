import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

/**
 * Microsoft Sentinel's built-in Fusion (Advanced Multi-Stage Attack Detection)
 * analytics rule. It is a Microsoft.SecurityInsights/alertRules resource — the
 * same collection Scheduled/NRT (sentinel-analytics-rules) and Microsoft
 * Security (sentinel-ms-security-rules) rules live in — but kind: Fusion is a
 * per-workspace SINGLETON with a FIXED alertRuleTemplateName (the built-in
 * Fusion template GUID). Verified against learn.microsoft.com "Alert Rules -
 * Create Or Update" for the GA api-version 2024-09-01: FusionAlertRule's only
 * writable properties are `alertRuleTemplateName` and `enabled` — severity,
 * tactics and description are inherited from the built-in template and
 * returned read-only on GET, never accepted on write.
 *
 * Because Fusion already exists on every onboarded workspace (enabled by
 * default) under a SYSTEM-ASSIGNED ruleId, this config type does NOT slug a
 * customer-typed name into the ARM ruleId the way Scheduled/NRT/Microsoft
 * Security rules do. Reconciliation is instead by KIND — deploy.ts lists the
 * workspace's alertRules and matches the one item with kind === "Fusion",
 * whatever its ruleId happens to be. A canvas may declare Fusion at most once.
 */
export const FUSION_KIND = 'Fusion'

/** The built-in Fusion detection's fixed alertRuleTemplateName (GA, every tenant). */
export const FUSION_ALERT_RULE_TEMPLATE_NAME = 'f71aba3d-28fb-450b-b192-4e76a83015c8'

/** One Fusion rule item authored on the canvas (there is at most one). */
export interface FusionRuleSpec {
  sectionName: string
  /** Cosmetic only — the canvas item's display identity. Reconciliation is by kind, not this label. */
  label: string
  enabled: boolean
}

function readBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

/** Each canvas item is the Fusion rule toggle (there should be at most one). */
export function extractFusionRuleSpecs(canvas: CanvasSnapshot): FusionRuleSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const label = typeof fields.label === 'string' && fields.label.trim() ? fields.label.trim() : 'Fusion'
    return {
      sectionName: section.name,
      label,
      enabled: readBool(fields.enabled, true),
    }
  })
}

/**
 * Validate the Fusion rule. Fusion is a per-workspace singleton, so a canvas
 * may declare it at most once.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no Fusion rule declared', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  if (sections.length > 1) {
    errors.push({
      field: 'sections',
      message: 'Only one Fusion rule may be declared — Fusion is a per-workspace singleton',
      code: 'duplicate_singleton',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
