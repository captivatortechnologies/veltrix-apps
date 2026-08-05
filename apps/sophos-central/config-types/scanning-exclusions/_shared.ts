// =============================================================================
// Shared helpers for the Sophos Central Scanning Exclusions config type.
//
// A scanning exclusion is reconciled by its (type, value) pair — Sophos
// assigns the id on create. PATCH accepts value/scanMode/comment (type is
// immutable); "behavioral" and "detectedExploit" exclusions do not support
// changing `value` after creation, per
// https://developer.sophos.com/docs/endpoint-v1/1/routes/settings/exclusions/scanning/{exclusionId}/patch.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { str } from '../../lib/sophosCommon'
import type { SophosScanningExclusion } from '../../lib/sophosApi'

export interface ScanningExclusionSpec {
  itemName: string
  type: string
  value: string
  scanMode: string
  comment: string
}

/** The exclusion's logical identity: its (type, value) pair, value lower-cased for matching. */
export function scanningExclusionKey(type: string, value: string): string {
  return `${type.trim()}::${value.trim().toLowerCase()}`
}

export function extractScanningExclusionSpecs(canvas: CanvasSnapshot): ScanningExclusionSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      type: str(fields.type),
      value: str(fields.value),
      scanMode: str(fields.scanMode),
      comment: str(fields.comment),
    }
  })
}

/** Build the create request body from a declared spec (blank scanMode/comment omitted so Sophos applies its own default). */
export function buildScanningExclusionBody(
  spec: ScanningExclusionSpec,
): Pick<SophosScanningExclusion, 'type' | 'value'> & Partial<Pick<SophosScanningExclusion, 'scanMode' | 'comment'>> {
  const body: Pick<SophosScanningExclusion, 'type' | 'value'> & Partial<Pick<SophosScanningExclusion, 'scanMode' | 'comment'>> = {
    type: spec.type,
    value: spec.value,
  }
  if (spec.scanMode) body.scanMode = spec.scanMode
  if (spec.comment) body.comment = spec.comment
  return body
}

/** Does the live exclusion already match the declared scanMode/comment? (value/type are the match key, so already equal.) */
export function scanningExclusionMatches(spec: ScanningExclusionSpec, live: SophosScanningExclusion): boolean {
  const liveScanMode = live.scanMode ?? ''
  const liveComment = live.comment ?? ''
  return (!spec.scanMode || liveScanMode === spec.scanMode) && liveComment === spec.comment
}
