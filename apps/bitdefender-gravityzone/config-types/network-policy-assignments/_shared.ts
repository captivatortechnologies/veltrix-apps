// =============================================================================
// Shared helpers for the GravityZone Network Policy Assignments config type.
//
// An "assignment" has no id of its own in the GravityZone API — assignPolicy
// is a fire-and-forget action, not a persisted object with a GET. This app
// identifies a declaration by its canvas-only assignmentName and re-applies
// assignPolicy on every deploy (idempotent — GravityZone converges targets
// to the declared assignment regardless of their current state).
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { coerceBoolean, splitList, str } from '../../lib/gravityZoneCommon'

export interface PolicyAssignmentSpec {
  itemName: string
  assignmentName: string
  targetIds: string[]
  policyId: string
  inheritFromAbove: boolean
  forcePolicyInheritance: boolean
}

export function extractPolicyAssignmentSpecs(canvas: CanvasSnapshot): PolicyAssignmentSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      assignmentName: str(fields.assignmentName),
      targetIds: splitList(fields.targetIds),
      policyId: str(fields.policyId),
      inheritFromAbove: coerceBoolean(fields.inheritFromAbove, false),
      forcePolicyInheritance: coerceBoolean(fields.forcePolicyInheritance, false),
    }
  })
}
