// =============================================================================
// Shared spec/validation/wire-format helpers for the OPNsense firewall-
// categories config type. Categories are pure metadata tags — no live pf
// effect — referenced by NAME from firewall-aliases, firewall-rules and
// source-nat. See lib/opnsenseApi.ts's Category resource doc for citations.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import type { CategoryBody, LiveCategory } from '../../lib/opnsenseApi'

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * A category's logical identity: its exact `name`. Category.xml's
 * UniqueConstraint on `name` is a case-SENSITIVE string comparison (same
 * reasoning as firewall-aliases' `aliasKey`), so this does not lower-case.
 */
export function categoryKey(name: string): string {
  return name.trim()
}

/** A live category this app should never touch — see LiveCategory's `auto` doc. */
export function isSystemManaged(live: LiveCategory): boolean {
  return String(live.auto ?? '0') === '1'
}

export interface CategorySpec {
  itemId?: string
  name: string
  color: string
}

export function extractCategorySpecs(canvas: CanvasSnapshot): CategorySpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      color: asString(f.color).replace(/^#/, '').toUpperCase(),
    }
  })
}

/** Category.xml's own Mask: 6 hex digits, case-insensitive. Blank (no color) is always valid. */
const COLOR_RE = /^[0-9A-Fa-f]{6}$/
export function isValidColor(value: string): boolean {
  return value === '' || COLOR_RE.test(value)
}

export function buildCategoryBody(spec: CategorySpec): CategoryBody {
  return { name: spec.name, color: spec.color }
}

export function snapshotLive(live: LiveCategory): CategoryBody {
  return { name: String(live.name ?? ''), color: String(live.color ?? '') }
}
