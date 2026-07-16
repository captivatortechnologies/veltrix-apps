import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { readBool, readOptionalString, readString, readStringArray } from '../../lib/fields'

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

/** Incident type a job runs under when none is specified. Always present in XSOAR. */
export const DEFAULT_JOB_TYPE = 'Unclassified'

export interface JobSpec {
  sectionName: string
  /** The job name — its logical identity (search + match). */
  name: string
  /** The incident type the job runs under. */
  type: string
  playbookId?: string
  /** Recurring (cron-scheduled) vs a one-time scheduled run. */
  recurrent: boolean
  cron?: string
  tags: string[]
  disabled: boolean
}

/** Shape of a job returned by POST /jobs/search (`{ data: Job[], total }`). */
export interface LiveJob {
  id?: string
  name?: string
  type?: string
  playbookId?: string
  recurrent?: boolean
  cron?: string
  tags?: string[]
  disabled?: boolean
  scheduled?: boolean
  version?: number
}

/** A cron expression is 5 (classic) or 6 (with seconds) whitespace-separated fields. */
function looksLikeCron(value: string): boolean {
  const parts = value.trim().split(/\s+/)
  return parts.length === 5 || parts.length === 6
}

/** Each canvas item describes one XSOAR scheduled job. */
export function extractJobSpecs(canvas: CanvasSnapshot): JobSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.name),
      type: readOptionalString(fields.type) ?? DEFAULT_JOB_TYPE,
      playbookId: readOptionalString(fields.playbookId),
      recurrent: readBool(fields.recurrent, false),
      cron: readOptionalString(fields.cron),
      tags: readStringArray(fields.tags),
      disabled: readBool(fields.disabled, false),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate XSOAR job configurations: a name is required and unique, a recurring
 * job needs a cron schedule, and a cron value that does not look like a 5/6-field
 * expression is flagged. Declaring no playbook is warned about (the job would run
 * nothing).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractJobSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Job name is required', code: 'required' })
      continue
    }

    if (seen.has(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: `Duplicate job "${spec.name}" — each job name may only be declared once`,
        code: 'duplicate_job',
      })
    }
    seen.add(spec.name)

    if (spec.recurrent && !spec.cron) {
      errors.push({
        field: `${prefix}.cron`,
        message: `Recurring job "${spec.name}" requires a cron schedule`,
        code: 'cron_required',
      })
    } else if (spec.cron && !looksLikeCron(spec.cron)) {
      errors.push({
        field: `${prefix}.cron`,
        message: `Cron "${spec.cron}" for job "${spec.name}" must be a 5- or 6-field expression (e.g. "0 9 * * *")`,
        code: 'invalid_cron',
      })
    }

    if (!spec.playbookId) {
      warnings.push({
        field: `${prefix}.playbookId`,
        message: `Job "${spec.name}" declares no playbook — it will run nothing`,
        code: 'no_playbook',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
