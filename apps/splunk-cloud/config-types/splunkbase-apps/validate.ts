import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// =============================================================================
// Splunk Cloud Splunkbase apps — validation + the spec extraction shared by
// deploy / rollback / healthCheck / driftDetect.
//
// A SEPARATE thing from this app's "Splunk Apps" (private app / add-on) type:
// that one BUILDS a package from files you author and vets it with AppInspect.
// This one installs an app someone else already published on Splunkbase, by
// its numeric catalog id — no files, no vetting (Splunkbase apps are already
// reviewed by Splunk before publication). Splunk's own `terraform-provider-scp`
// models these as two distinct resources ("Private App" / "Splunkbase App"),
// which this app follows.
//
// ACS shares the `apps`/`apps/victoria` collection for both kinds, switched by
// a `?splunkbase=true` query parameter (see deploy.ts). Once installed, a
// Splunkbase app is addressed by its TECHNICAL app name (e.g.
// "SplunkforPaloAltoNetworks") for describe/upgrade/uninstall — NOT by the
// numeric splunkbaseID used only at install/upgrade time. Both values come
// from the app's Splunkbase listing page.
//
// Docs: help.splunk.com …/manage-splunkbase-apps-in-splunk-cloud-platform
// =============================================================================

/** App names appear in ACS URLs, same rules as a private app id. */
const APP_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]*$/
const MAX_APP_NAME_LENGTH = 100

/** The numeric Splunkbase catalog id, e.g. 491 for splunkbase.splunk.com/app/491. */
const SPLUNKBASE_ID_PATTERN = /^\d+$/

export interface SplunkbaseAppSpec {
  sectionName: string
  appName: string
  splunkbaseId: string
  version: string
  licenseAck: string
}

/** Each canvas section describes one Splunkbase app to install/manage. */
export function extractSplunkbaseAppSpecs(canvas: CanvasSnapshot): SplunkbaseAppSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      appName: typeof fields.appName === 'string' ? fields.appName.trim() : '',
      splunkbaseId:
        typeof fields.splunkbaseId === 'string'
          ? fields.splunkbaseId.trim()
          : typeof fields.splunkbaseId === 'number'
            ? String(fields.splunkbaseId)
            : '',
      version: typeof fields.version === 'string' ? fields.version.trim() : '',
      licenseAck: typeof fields.licenseAck === 'string' ? fields.licenseAck.trim() : '',
    }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no Splunkbase app definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seenNames = new Set<string>()
  const seenIds = new Set<string>()

  for (const spec of extractSplunkbaseAppSpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    // --- App name (technical id, used for describe/upgrade/uninstall) -------
    if (!spec.appName) {
      errors.push({
        field: `${prefix}.appName`,
        message: 'App name is required — the technical app id shown on the app\'s Splunkbase listing (e.g. "SplunkforPaloAltoNetworks")',
        code: 'required',
      })
    } else {
      if (!APP_NAME_PATTERN.test(spec.appName)) {
        errors.push({
          field: `${prefix}.appName`,
          message: 'App name must start with a letter and contain only letters, digits, ".", "_" and "-"',
          code: 'invalid_format',
        })
      }
      if (spec.appName.length > MAX_APP_NAME_LENGTH) {
        errors.push({
          field: `${prefix}.appName`,
          message: `App name must be ${MAX_APP_NAME_LENGTH} characters or fewer`,
          code: 'max_length',
        })
      }
      if (seenNames.has(spec.appName)) {
        errors.push({ field: `${prefix}.appName`, message: `Duplicate app name: "${spec.appName}"`, code: 'duplicate' })
      }
      seenNames.add(spec.appName)
    }

    // --- Splunkbase catalog id -----------------------------------------------
    if (!spec.splunkbaseId) {
      errors.push({
        field: `${prefix}.splunkbaseId`,
        message: 'Splunkbase app id is required — the number in the app\'s Splunkbase URL (splunkbase.splunk.com/app/<id>)',
        code: 'required',
      })
    } else if (!SPLUNKBASE_ID_PATTERN.test(spec.splunkbaseId)) {
      errors.push({
        field: `${prefix}.splunkbaseId`,
        message: `"${spec.splunkbaseId}" is not a valid Splunkbase app id — it must be numeric`,
        code: 'invalid_format',
      })
    } else {
      if (seenIds.has(spec.splunkbaseId)) {
        warnings.push({
          field: `${prefix}.splunkbaseId`,
          message: `Splunkbase id "${spec.splunkbaseId}" is declared more than once`,
          code: 'duplicate_id',
        })
      }
      seenIds.add(spec.splunkbaseId)
    }

    // --- License acknowledgement ---------------------------------------------
    if (!spec.licenseAck) {
      errors.push({
        field: `${prefix}.licenseAck`,
        message:
          'License URL is required — ACS requires acknowledging the app\'s license before it will install a Splunkbase app (find it on the app\'s Splunkbase listing, e.g. an OSI license URL)',
        code: 'required',
      })
    } else if (!/^https?:\/\//i.test(spec.licenseAck)) {
      errors.push({
        field: `${prefix}.licenseAck`,
        message: 'License URL must start with http:// or https://',
        code: 'invalid_format',
      })
    }

    // --- Version (optional) ---------------------------------------------------
    if (spec.version) {
      warnings.push({
        field: `${prefix}.version`,
        message:
          'ACS supports upgrading a Splunkbase app to a newer version only — it cannot downgrade an installed app. Omit this field to always install the latest cloud-compatible, self-service version.',
        code: 'no_downgrade',
      })
    }

    warnings.push({
      field: `${prefix}.appName`,
      message:
        'Not every Splunkbase app is self-service installable through ACS — if the app requires review, ACS rejects the install and a Splunk Support case is the only route.',
      code: 'self_service_reminder',
    })
  }

  return { valid: errors.length === 0, errors, warnings }
}
