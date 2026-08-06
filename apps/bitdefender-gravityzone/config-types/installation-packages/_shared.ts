// =============================================================================
// Shared helpers for the GravityZone Installation Packages config type.
//
// Packages are reconciled by packageName (GravityZone assigns the package id
// on create). List items are a summary — the JSON sub-objects (modules,
// scanMode, settings, roles, deploymentOptions) are only reliably present on
// packages.getPackageDetails, the same "list is a summary, get is full"
// reasoning apps/sophos-central applies to its own resources.
// =============================================================================

import type { CanvasSnapshot } from '@veltrixsecops/app-sdk'
import { canonicalJson, listAllPaged, parseJsonObject, readOptionalNumber, str } from '../../lib/gravityZoneCommon'
import { getPackagesList, type GzPackage, type GzPackageBody } from '../../lib/gravityZoneApi'
import type { GravityZoneClient } from '../../lib/gravityZone'

export interface InstallationPackageSpec {
  itemName: string
  packageName: string
  description: string
  language: string
  productType: number | undefined
  modulesRaw: string
  scanModeRaw: string
  settingsRaw: string
  rolesRaw: string
  deploymentOptionsRaw: string
}

/** The package's logical identity: its name, trimmed and lower-cased for matching. */
export function installationPackageKey(packageName: string): string {
  return packageName.trim().toLowerCase()
}

export function extractInstallationPackageSpecs(canvas: CanvasSnapshot): InstallationPackageSpec[] {
  return (canvas.items ?? canvas.sections ?? []).map((item) => {
    const fields = item.fields ?? {}
    return {
      itemName: item.name,
      packageName: str(fields.packageName),
      description: str(fields.description),
      language: str(fields.language),
      productType: readOptionalNumber(fields.productType),
      modulesRaw: str(fields.modules),
      scanModeRaw: str(fields.scanMode),
      settingsRaw: str(fields.settings),
      rolesRaw: str(fields.roles),
      deploymentOptionsRaw: str(fields.deploymentOptions),
    }
  })
}

export interface ParsedPackageJson {
  modules: Record<string, unknown> | null
  scanMode: Record<string, unknown> | null
  settings: Record<string, unknown> | null
  roles: Record<string, unknown> | null
  deploymentOptions: Record<string, unknown> | null
  errors: string[]
}

/** Parse every declared JSON sub-object, collecting every parse error rather than stopping at the first. */
export function parsePackageJsonFields(spec: InstallationPackageSpec): ParsedPackageJson {
  const errors: string[] = []
  const parse = (raw: string, label: string) => {
    const { value, error } = parseJsonObject(raw, `Package "${spec.packageName}" ${label}`)
    if (error) errors.push(error)
    return value
  }
  return {
    modules: parse(spec.modulesRaw, 'Modules'),
    scanMode: parse(spec.scanModeRaw, 'Scan Mode'),
    settings: parse(spec.settingsRaw, 'Settings'),
    roles: parse(spec.rolesRaw, 'Roles'),
    deploymentOptions: parse(spec.deploymentOptionsRaw, 'Deployment Options'),
    errors,
  }
}

/** Build the create/update request body — this app always sends the full declared object, never a partial patch. */
export function buildPackageBody(spec: InstallationPackageSpec, parsed: ParsedPackageJson): GzPackageBody {
  return {
    packageName: spec.packageName,
    description: spec.description,
    language: spec.language || undefined,
    productType: spec.productType ?? 0,
    modules: parsed.modules ?? undefined,
    scanMode: parsed.scanMode ?? undefined,
    settings: parsed.settings ?? undefined,
    roles: parsed.roles ?? undefined,
    deploymentOptions: parsed.deploymentOptions ?? undefined,
  }
}

export function findLivePackage(live: GzPackage[], packageName: string): GzPackage | undefined {
  const key = installationPackageKey(packageName)
  return live.find((p) => installationPackageKey(p.packageName ?? p.name ?? '') === key)
}

export function livePackageId(pkg: GzPackage): string {
  const id = pkg.id ?? pkg.packageId
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : ''
}

/** Fetch every package across every page (see lib/gravityZoneCommon.ts listAllPaged). */
export async function listAllPackages(client: GravityZoneClient): Promise<GzPackage[]> {
  return listAllPaged((page, perPage) => getPackagesList(client, { page, perPage }))
}

/** Does the live (full-detail) package already match every declared field? */
export function packageFieldsMatch(spec: InstallationPackageSpec, parsed: ParsedPackageJson, live: GzPackage): boolean {
  return (
    (live.description ?? '') === spec.description &&
    (live.language ?? '') === spec.language &&
    (live.productType ?? 0) === (spec.productType ?? 0) &&
    canonicalJson(live.modules ?? {}) === canonicalJson(parsed.modules ?? {}) &&
    canonicalJson(live.scanMode ?? {}) === canonicalJson(parsed.scanMode ?? {}) &&
    canonicalJson(live.settings ?? {}) === canonicalJson(parsed.settings ?? {}) &&
    canonicalJson(live.roles ?? {}) === canonicalJson(parsed.roles ?? {}) &&
    canonicalJson(live.deploymentOptions ?? {}) === canonicalJson(parsed.deploymentOptions ?? {})
  )
}
