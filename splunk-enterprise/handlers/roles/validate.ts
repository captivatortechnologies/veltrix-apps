import type { PipelineContext, ValidationResult } from '../../../../core/pipeline-engine/types'

const RESERVED_ROLE_NAMES = ['admin', 'can_delete', 'power', 'splunk-system-role', 'user']
const MAX_ROLE_NAME_LENGTH = 80

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no role definitions', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const roleNames = new Set<string>()

  for (const section of sections) {
    const fields = section.fields || {}
    const prefix = section.name

    // Role name
    const name = fields.name as string | undefined
    if (!name || name.trim().length === 0) {
      errors.push({ field: `${prefix}.name`, message: 'Role name is required', code: 'required' })
    } else {
      if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Role name must start with a lowercase letter and contain only lowercase letters, numbers, hyphens, and underscores',
          code: 'invalid_format',
        })
      }
      if (name.length > MAX_ROLE_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Role name must be ${MAX_ROLE_NAME_LENGTH} characters or fewer`, code: 'max_length' })
      }
      if (RESERVED_ROLE_NAMES.includes(name)) {
        errors.push({ field: `${prefix}.name`, message: `"${name}" is a reserved Splunk role`, code: 'reserved_name' })
      }
      if (roleNames.has(name)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate role name: "${name}"`, code: 'duplicate' })
      }
      roleNames.add(name)
    }

    // Capabilities
    const capabilities = fields.capabilities as string[] | undefined
    if (capabilities && !Array.isArray(capabilities)) {
      errors.push({ field: `${prefix}.capabilities`, message: 'Capabilities must be an array', code: 'invalid_type' })
    }

    // Search filter
    const srchFilter = fields.srchFilter as string | undefined
    if (srchFilter && typeof srchFilter === 'string' && srchFilter.length > 2000) {
      warnings.push({ field: `${prefix}.srchFilter`, message: 'Search filter is very long — may impact performance', code: 'long_filter' })
    }

    // Imported roles circular check
    const importedRoles = fields.importedRoles as string[] | undefined
    if (importedRoles && Array.isArray(importedRoles)) {
      if (name && importedRoles.includes(name)) {
        errors.push({ field: `${prefix}.importedRoles`, message: 'Role cannot import itself', code: 'circular_import' })
      }
    }

    // srchDiskQuota
    const diskQuota = fields.srchDiskQuota as number | undefined
    if (diskQuota !== undefined && (typeof diskQuota !== 'number' || diskQuota < 0)) {
      errors.push({ field: `${prefix}.srchDiskQuota`, message: 'Search disk quota must be a non-negative number', code: 'invalid_value' })
    }

    // srchJobsQuota
    const jobsQuota = fields.srchJobsQuota as number | undefined
    if (jobsQuota !== undefined) {
      if (typeof jobsQuota !== 'number' || jobsQuota < 0) {
        errors.push({ field: `${prefix}.srchJobsQuota`, message: 'Search jobs quota must be a non-negative number', code: 'invalid_value' })
      } else if (jobsQuota > 100) {
        warnings.push({ field: `${prefix}.srchJobsQuota`, message: 'High search jobs quota may impact cluster performance', code: 'high_quota' })
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
