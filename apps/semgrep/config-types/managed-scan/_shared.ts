// Shared helpers for the Semgrep Managed Scan Settings config type
// (validate + deploy + rollback + drift).
//
// Identity is the project NAME (the repository as a path, e.g. my-org/my-repo).
// The two managed toggles map straight onto the documented Managed Scans API:
//   fullScanEnabled → PATCH .../projects/{name}/managed-scan  body { full_scan: { enabled } }
//   diffScanEnabled → PATCH .../projects/{name}/managed-scan  body { diff_scan: { enabled } }
// The live state is read back from GET .../projects/{name} (managed_scan_config).
//
// FLAGGED: Managed Scans is a [Beta] Semgrep surface and only applies to
// deployments that have Semgrep Managed Scanning enabled for the project; a
// project not onboarded to Managed Scans may reject the PATCH.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canvasItems, readBool } from '../../lib/canvas'

/** One project's desired Managed Scans settings, parsed from a canvas item. */
export interface ManagedScanSpec {
  /** The project name (repository path). The stable identity. */
  projectName: string
  /** Desired state of weekly full scans. */
  fullScanEnabled: boolean
  /** Desired state of diff-aware (PR) scans. */
  diffScanEnabled: boolean
}

/** Build a ManagedScanSpec from one canvas item's fields. */
export function managedScanSpecFromFields(fields: Record<string, unknown>): ManagedScanSpec {
  return {
    projectName: String(fields.projectName ?? '').trim(),
    fullScanEnabled: readBool(fields.fullScanEnabled, false),
    diffScanEnabled: readBool(fields.diffScanEnabled, false),
  }
}

/** Every Managed Scans spec authored on the canvas. */
export function extractManagedScanSpecs(canvas: CanvasSnapshot): ManagedScanSpec[] {
  return canvasItems(canvas).map((item) => managedScanSpecFromFields(item.fields ?? {}))
}

/** The PATCH body that sets a project's Managed Scans config to the declared state. */
export function managedScanBody(spec: ManagedScanSpec): { full_scan: { enabled: boolean }; diff_scan: { enabled: boolean } } {
  return {
    full_scan: { enabled: spec.fullScanEnabled },
    diff_scan: { enabled: spec.diffScanEnabled },
  }
}
