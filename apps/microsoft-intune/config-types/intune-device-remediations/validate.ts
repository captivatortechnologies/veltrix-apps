import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import {
  RUN_AS_ACCOUNTS,
  hasAnyAssignment,
  normalizeFrequency,
  readBool,
  readList,
  readNumber,
  readScript,
  readString,
  type RemediationSpec,
  type RunAsAccount,
} from './remediation'

/** The remediation name (displayName) is the reconciliation key. */
export function remediationKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Each canvas item is one device remediation: identity + scripts + run options + schedule + assignment. */
export function extractRemediationSpecs(canvas: CanvasSnapshot): RemediationSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      name: readString(fields.name),
      description: readString(fields.description),
      publisher: readString(fields.publisher),
      detectionScript: readScript(fields.detectionScript),
      remediationScript: readScript(fields.remediationScript),
      runAsAccount: typeof fields.runAsAccount === 'string' && fields.runAsAccount.trim() !== '' ? fields.runAsAccount.trim().toLowerCase() : 'system',
      enforceSignatureCheck: readBool(fields.enforceSignatureCheck),
      runAs32Bit: readBool(fields.runAs32Bit),
      schedule: {
        frequency: normalizeFrequency(fields.scheduleFrequency),
        interval: readNumber(fields.scheduleInterval) ?? 1,
        time: readString(fields.scheduleTime) || '01:00',
      },
      assignments: {
        includeGroupIds: readList(fields.includeGroups),
        excludeGroupIds: readList(fields.excludeGroups),
        allDevices: readBool(fields.allDevices),
        allUsers: readBool(fields.allUsers),
      },
    }
  })
}

/** Interval bounds per frequency: hourly runs every 1-23 hours, daily every 1-31 days. */
function intervalBounds(frequency: RemediationSpec['schedule']['frequency']): { min: number; max: number } {
  return frequency === 'hourly' ? { min: 1, max: 23 } : { min: 1, max: 31 }
}

/**
 * Validate device remediations: each needs a name (unique across the canvas) and a
 * detection script; runAsAccount must be system/user and the schedule interval must be
 * in range (daily needs a HH:MM time). A remediation with no assignment target warns.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no device remediation items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractRemediationSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Remediation name is required', code: 'required' })
    } else {
      const key = remediationKey(spec.name)
      if (seen.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate remediation name "${spec.name}"`, code: 'duplicate_remediation' })
      }
      seen.add(key)
    }

    if (spec.detectionScript.trim() === '') {
      errors.push({ field: `${prefix}.detectionScript`, message: 'A detection script is required', code: 'required' })
    }

    if (!RUN_AS_ACCOUNTS.includes(spec.runAsAccount as RunAsAccount)) {
      errors.push({
        field: `${prefix}.runAsAccount`,
        message: `Run as account "${spec.runAsAccount}" must be one of: ${RUN_AS_ACCOUNTS.join(', ')}`,
        code: 'invalid_run_as',
      })
    }

    const bounds = intervalBounds(spec.schedule.frequency)
    if (!Number.isInteger(spec.schedule.interval) || spec.schedule.interval < bounds.min || spec.schedule.interval > bounds.max) {
      errors.push({
        field: `${prefix}.scheduleInterval`,
        message: `Schedule interval must be a whole number between ${bounds.min} and ${bounds.max} for a ${spec.schedule.frequency} schedule`,
        code: 'out_of_range',
      })
    }

    if (spec.schedule.frequency === 'daily' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(spec.schedule.time)) {
      errors.push({ field: `${prefix}.scheduleTime`, message: 'Schedule time must be a 24-hour HH:MM value (e.g. 01:00)', code: 'invalid_time' })
    }

    if (!hasAnyAssignment(spec.assignments)) {
      warnings.push({
        field: `${prefix}.includeGroups`,
        message: `Remediation "${spec.name || prefix}" has no assignment target — add include groups or target all devices/users, or it will run on nothing`,
        code: 'no_assignment',
      })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
