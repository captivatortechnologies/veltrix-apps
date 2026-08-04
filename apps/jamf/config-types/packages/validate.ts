import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Jamf Pro Packages — modern API (GET/POST/PUT/DELETE /v1/packages).
// https://developer.jamf.com/jamf-pro/reference/get_v1-packages
//
// METADATA ONLY. The Package object also carries binary-integrity fields
// (size, md5, sha256, sha3512, hashType, hashValue) and a cloud-transfer
// status that only make sense once a `.pkg`/`.dmg` has actually been
// uploaded — this app never uploads or references package BINARIES (that is
// a separate, unlisted upload endpoint), so this config type manages only
// the durable metadata record: name, source filename, category, priority,
// info/notes/OS requirements, and installation-behavior flags. Deploying a
// package record here without first uploading the matching binary in Jamf Pro
// creates a record a policy can reference, but nothing will actually install.
//
// `categoryId` is a required field on Create/Update, but an admin thinks in
// terms of the category NAME — this config type declares `category_name` and
// resolves it to a live id at deploy time (reusing this app's own Categories
// config type's listing), the same pattern `policies` uses for its scope/
// scripts/packages references.
// =============================================================================

export interface PackageSpec {
  sectionName: string
  name: string
  fileName: string
  categoryName: string
  priority: number
  info: string
  notes: string
  osRequirements: string
  fillUserTemplate: boolean
  fillExistingUsers: boolean
  rebootRequired: boolean
  osInstall: boolean
  suppressUpdates: boolean
  suppressFromDock: boolean
  suppressEula: boolean
  suppressRegistration: boolean
  ignoreConflicts: boolean
  installLanguage: string
}

/** Shape of a Jamf Pro Package object (metadata fields only), as returned by list/create/update. */
export interface LivePackage {
  id?: string
  packageName?: string
  fileName?: string
  categoryId?: string
  priority?: number
  info?: string
  notes?: string
  osRequirements?: string
  fillUserTemplate?: boolean
  fillExistingUsers?: boolean
  rebootRequired?: boolean
  osInstall?: boolean
  suppressUpdates?: boolean
  suppressFromDock?: boolean
  suppressEula?: boolean
  suppressRegistration?: boolean
  ignoreConflicts?: boolean
  installLanguage?: string
}

/** The package's logical identity: its `packageName` (case-insensitive, trimmed). */
export function packageKey(name: string): string {
  return name.trim().toLowerCase()
}

export function indexPackagesByName(packages: LivePackage[]): Map<string, LivePackage> {
  const byName = new Map<string, LivePackage>()
  for (const p of packages) {
    if (!p.packageName) continue
    const key = packageKey(p.packageName)
    if (!byName.has(key)) byName.set(key, p)
  }
  return byName
}

export function extractPackageSpecs(canvas: CanvasSnapshot): PackageSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
    const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)
    const rawPriority = fields.priority
    const priority = typeof rawPriority === 'number' && Number.isFinite(rawPriority) ? rawPriority : 10
    return {
      sectionName: section.name,
      name: str(fields.name),
      fileName: str(fields.file_name),
      categoryName: str(fields.category_name),
      priority,
      info: str(fields.info),
      notes: str(fields.notes),
      osRequirements: str(fields.os_requirements),
      fillUserTemplate: bool(fields.fill_user_template, false),
      fillExistingUsers: bool(fields.fill_existing_users, false),
      rebootRequired: bool(fields.reboot_required, false),
      osInstall: bool(fields.os_install, false),
      suppressUpdates: bool(fields.suppress_updates, false),
      suppressFromDock: bool(fields.suppress_from_dock, false),
      suppressEula: bool(fields.suppress_eula, false),
      suppressRegistration: bool(fields.suppress_registration, false),
      ignoreConflicts: bool(fields.ignore_conflicts, false),
      installLanguage: str(fields.install_language),
    }
  })
}

/** The `Package` request body Jamf Pro's create/update endpoints accept, given a resolved `categoryId`. */
export function buildPackageBody(spec: PackageSpec, categoryId: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    packageName: spec.name,
    fileName: spec.fileName,
    categoryId,
    priority: spec.priority,
    info: spec.info,
    notes: spec.notes,
    osRequirements: spec.osRequirements,
    fillUserTemplate: spec.fillUserTemplate,
    fillExistingUsers: spec.fillExistingUsers,
    rebootRequired: spec.rebootRequired,
    osInstall: spec.osInstall,
    suppressUpdates: spec.suppressUpdates,
    suppressFromDock: spec.suppressFromDock,
    suppressEula: spec.suppressEula,
    suppressRegistration: spec.suppressRegistration,
    ignoreConflicts: spec.ignoreConflicts,
  }
  if (spec.installLanguage) body.installLanguage = spec.installLanguage
  return body
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate package configurations: name, file name and category name are
 * required (category existence is resolved live at deploy time — validate
 * has no guaranteed connectivity); name unique across the canvas
 * (case-insensitive); priority a non-negative integer.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPackageSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Package name is required', code: 'required' })
    }
    if (!spec.fileName) {
      errors.push({ field: `${prefix}.file_name`, message: 'File name is required (the .pkg/.dmg filename already uploaded to Jamf Pro)', code: 'required' })
    }
    if (!spec.categoryName) {
      errors.push({ field: `${prefix}.category_name`, message: 'Category name is required', code: 'required' })
    }
    if (!Number.isInteger(spec.priority) || spec.priority < 0) {
      errors.push({ field: `${prefix}.priority`, message: 'Priority must be a non-negative whole number', code: 'invalid_priority' })
    }

    if (spec.name) {
      const key = packageKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate package "${spec.name}" — each name may only be declared once in this canvas`,
          code: 'duplicate_package',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
