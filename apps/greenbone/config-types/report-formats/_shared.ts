// Shared helpers for the Greenbone Report Formats config type (deploy +
// rollback + drift). Scoped to CLONE + param/active/name/summary tuning only
// (see lib/gmp/reportFormats.ts) — never the raw executable-file-import path.
//
// IDENTITY: a report format's canvas identity is `reportFormatId` — the
// operator either (a) types an EXISTING format's UUID (a predefined one, or
// one this app cloned earlier) to manage it, or (b) leaves it blank and
// supplies `cloneFrom`, in which case the FIRST deploy clones a new format and
// this app remembers the resulting id per CANVAS ITEM (identityDerived — see
// canvas.yaml). Either way, `deploy.ts` also tracks whether THIS APP owns the
// format's lifecycle (cloned by it) so item-removal cleanup only ever deletes
// a format this app created — never a predefined or pre-existing one an
// operator pointed at.

import type { CanvasItemSnapshot, CanvasSnapshot, PlatformDataApi } from '@veltrixsecops/app-sdk'
import type { ReportFormatParam } from '../../lib/gmp/reportFormats'

export interface ReportFormatSpec {
  itemId: string
  reportFormatId: string
  cloneFrom: string
  name: string
  summary: string
  active: boolean
  params: ReportFormatParam[]
}

function parseParams(raw: unknown): ReportFormatParam[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>).map(([name, value]) => ({ name, value: String(value ?? '') }))
}

export function specFromItem(item: CanvasItemSnapshot): ReportFormatSpec {
  const f = item.fields ?? {}
  return {
    itemId: item.id ?? item.name,
    reportFormatId: String(f.reportFormatId ?? '').trim(),
    cloneFrom: String(f.cloneFrom ?? '').trim(),
    name: String(f.name ?? '').trim(),
    summary: String(f.summary ?? '').trim(),
    active: f.active !== false,
    params: parseParams(f.params),
  }
}

export function extractSpecs(items: CanvasItemSnapshot[]): ReportFormatSpec[] {
  return items.map(specFromItem)
}

export interface RollbackEntry {
  itemId: string
  reportFormatId: string
  /** True only when THIS app cloned the format (create_report_format) — controls delete-on-removal and rollback's create-vs-restore branch. */
  ownedByClone: boolean
  /** Snapshot BEFORE this deploy's modify_report_format call; null only the run this app freshly cloned the format. */
  prior: { name: string; summary: string; active: boolean; params: ReportFormatParam[] } | null
}

/** The last successfully-deployed itemId -> gvmd report-format id map, shared by deploy/rollback/drift. */
export async function loadPriorEntries(platform: PlatformDataApi, canvas: CanvasSnapshot): Promise<RollbackEntry[]> {
  try {
    const prev = await platform.getLatestDeployment(canvas.canvasId, { status: 'SUCCEEDED' })
    const data = prev?.rollbackData as { previous?: RollbackEntry[] } | undefined
    return Array.isArray(data?.previous) ? data.previous : []
  } catch {
    return []
  }
}
