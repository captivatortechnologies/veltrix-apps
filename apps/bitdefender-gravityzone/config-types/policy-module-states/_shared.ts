// =============================================================================
// Shared helpers for the GravityZone Policy Module States config type.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { parseJsonObject, str } from '../../lib/gravityZoneCommon'

export interface PolicyModuleStateSpec {
  itemName: string
  policyId: string
  settingsRaw: string
}

export function extractPolicyModuleStateSpecs(canvas: CanvasSnapshot): PolicyModuleStateSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      policyId: str(fields.policyId),
      settingsRaw: str(fields.settings),
    }
  })
}

export function parseSettings(spec: PolicyModuleStateSpec): { value: Record<string, unknown> | null; error: string | null } {
  return parseJsonObject(spec.settingsRaw, `Policy "${spec.policyId}" Settings`)
}
