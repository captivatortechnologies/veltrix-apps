// Shared helpers for the JumpCloud Software Apps (Catalog) config type
// (validate + deploy + rollback + healthCheck + driftDetect).
//
// Applied over the JumpCloud API v2 (/softwareapps), SCOPED to App-Catalog-
// referenced apps — see canvas.yaml for why custom/private package uploads are
// out of scope.
//
// VERIFIED against JumpCloud's published API v2 OpenAPI spec
// (github.com/TheJumpCloud/jumpcloud-docs-public, docs/api/2.0/index.yaml):
//   software-app: { id, organization, displayName, settings: software-app-settings[] }
//   software-app-settings (catalog-relevant subset): { appCatalogInstallableObjectId,
//     autoUpdate, allowUpdateDelay, desiredState, displayVersion, packageManager,
//     packageId, ... } — this config type authors exactly ONE settings entry per app.

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'

export const SOFTWARE_APP_DESIRED_STATES = ['Install', 'Uninstall'] as const

/** The one settings entry this config type authors within `software-app.settings[]`. */
export interface JumpCloudSoftwareAppSettings {
  appCatalogInstallableObjectId?: string
  autoUpdate?: boolean
  allowUpdateDelay?: boolean
  desiredState?: string
  displayVersion?: string
  [key: string]: unknown
}

/** One JumpCloud Software App as returned by GET /softwareapps and GET /softwareapps/{id}. */
export interface JumpCloudSoftwareApp {
  id?: string
  displayName?: string
  settings?: JumpCloudSoftwareAppSettings[]
  [key: string]: unknown
}

/** The desired state for one Software App, extracted from a canvas item. */
export interface SoftwareAppSpec {
  itemId?: string
  displayName: string
  appCatalogInstallableObjectId: string
  displayVersion: string
  desiredState: string
  autoUpdate: boolean
  allowUpdateDelay: boolean
}

/** Coerce a checkbox-ish value to a boolean, with a caller-supplied default. */
export function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  const s = String(value ?? '').trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/** Each canvas item describes one JumpCloud catalog-based Software App. */
export function extractSoftwareAppSpecs(canvas: CanvasSnapshot): SoftwareAppSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const fields = item.fields ?? {}
    return {
      itemId: item.id,
      displayName: String(fields.displayName ?? '').trim(),
      appCatalogInstallableObjectId: String(fields.appCatalogInstallableObjectId ?? '').trim(),
      displayVersion: String(fields.displayVersion ?? '').trim(),
      desiredState: String(fields.desiredState ?? 'Install').trim() || 'Install',
      autoUpdate: normalizeBool(fields.autoUpdate, true),
      allowUpdateDelay: normalizeBool(fields.allowUpdateDelay, false),
    }
  })
}

/** Find a live Software App by displayName (case-insensitive — the stable identity). */
export function findSoftwareAppByName(apps: JumpCloudSoftwareApp[], displayName: string): JumpCloudSoftwareApp | null {
  const target = displayName.trim().toLowerCase()
  if (!target) return null
  return apps.find((a) => String(a.displayName ?? '').trim().toLowerCase() === target) ?? null
}

/** Build the single settings entry this config type authors. */
export function buildSoftwareAppSettings(spec: SoftwareAppSpec): JumpCloudSoftwareAppSettings {
  const settings: JumpCloudSoftwareAppSettings = {
    appCatalogInstallableObjectId: spec.appCatalogInstallableObjectId,
    autoUpdate: spec.autoUpdate,
    allowUpdateDelay: spec.allowUpdateDelay,
    desiredState: spec.desiredState,
  }
  if (spec.displayVersion) settings.displayVersion = spec.displayVersion
  return settings
}

/** Build the JumpCloud software-app body for POST/PUT /softwareapps[/{id}]. */
export function buildSoftwareAppBody(spec: SoftwareAppSpec): Record<string, unknown> {
  return { displayName: spec.displayName, settings: [buildSoftwareAppSettings(spec)] }
}

/** The subset of a live app's fields this config type manages — captured for rollback. */
export function priorFieldsOf(app: JumpCloudSoftwareApp): Record<string, unknown> {
  return {
    displayName: String(app.displayName ?? ''),
    settings: Array.isArray(app.settings) ? app.settings : [],
  }
}
