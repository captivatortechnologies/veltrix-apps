// Shared helpers for the Semgrep Detection Policy config type (validate + deploy
// + rollback + drift).
//
// Identity is the PRODUCT ("code" or "secrets") — a deployment-wide singleton
// bundle per product, applied via the Policies V2 [Beta] API:
//   GET  /api/policies/v2/deployments/{deploymentId}/detection-policy/{product}
//   PUT  /api/policies/v2/deployments/{deploymentId}/detection-policy/{product}
//        (strict apply — the submitted bundle REPLACES the current state;
//        exceptions absent from it are deleted; requires If-Match: state_version)
//   POST /api/policies/v2/deployments/{deploymentId}/detection-policy/{product}:dryRun
//        (preview — validates + diffs without changing anything)
//
// Exceptions (per-project / per-tag include/exclude overrides) are a nested list
// of typed objects, which the canvas has no first-class field for (the same
// constraint cisco-meraki's Group Policies / L7 rule "value" object hit) —
// declared as a JSON array in a textarea, in the EXACT wire (snake_case) shape,
// so a hand-authored bundle matches what Semgrep's docs and dry-run errors
// reference. Structurally validated in validate.ts.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canvasItems, strList } from '../../lib/canvas'
import type { DetectionPolicyBundle, DetectionPolicyException, DetectionPolicyProduct } from '../../lib/semgrepApi'

export const DETECTION_POLICY_PRODUCTS: DetectionPolicyProduct[] = ['code', 'secrets']

/** Type guard narrowing a canvas-authored string to a valid detection policy product. */
export function isDetectionPolicyProduct(value: string): value is DetectionPolicyProduct {
  return (DETECTION_POLICY_PRODUCTS as string[]).includes(value)
}

export interface DetectionPolicySpec {
  product: string
  rulesets: string[]
  rules: string[]
  disabled: string[]
  /** Parsed exceptions, or null when the canvas JSON failed to parse (validate.ts blocks a deploy on this). */
  exceptions: DetectionPolicyException[] | null
}

function parseExceptions(raw: string): DetectionPolicyException[] | null {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as DetectionPolicyException[]) : null
  } catch {
    return null
  }
}

export function detectionPolicySpecFromFields(fields: Record<string, unknown>): DetectionPolicySpec {
  return {
    product: String(fields.product ?? '').trim().toLowerCase(),
    rulesets: strList(fields.rulesets),
    rules: strList(fields.rules),
    disabled: strList(fields.disabled),
    exceptions: parseExceptions(String(fields.exceptionsJson ?? '')),
  }
}

/** Every Detection Policy spec authored on the canvas. */
export function extractDetectionPolicySpecs(canvas: CanvasSnapshot): DetectionPolicySpec[] {
  return canvasItems(canvas).map((item) => detectionPolicySpecFromFields(item.fields ?? {}))
}

/** The bundle body the PUT / dry-run endpoints expect for a spec. */
export function bundleFromSpec(spec: DetectionPolicySpec): DetectionPolicyBundle {
  return {
    product: spec.product,
    rulesets: spec.rulesets,
    rules: spec.rules,
    disabled: spec.disabled,
    exceptions: spec.exceptions ?? [],
  }
}

/** Whether two exception lists declare the same SET (order-insensitive, per-entry deep-compared). */
export function exceptionsEqual(a: DetectionPolicyException[], b: DetectionPolicyException[]): boolean {
  if (a.length !== b.length) return false
  const key = (e: DetectionPolicyException) =>
    JSON.stringify([e.exception_type, e.project ?? '', e.project_tag_name ?? '', e.rule, e.rule_type])
  const sa = a.map(key).sort()
  const sb = b.map(key).sort()
  return sa.every((v, i) => v === sb[i])
}
