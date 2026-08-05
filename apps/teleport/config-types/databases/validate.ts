import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

export const DB_NAME_PATTERN = /^[A-Za-z0-9._-]+$/
export const PROTOCOL_PATTERN = /^[a-z0-9-]+$/

export interface Label {
  name: string
  value: string
}

export interface AwsRds {
  accountId: string
  resourceId: string
  vpcId: string
  subnets: string[]
}

export interface DatabaseSpec {
  sectionName: string
  name: string
  protocol: string
  uri: string
  labels: Label[]
  caCert: string | null
  awsRds: AwsRds | null
}

/** Convert a `keyvalue` field's `{name: value}` object into the wire format's `Label[]`. */
export function labelsFromKeyValue(raw: unknown): Label[] {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
  return Object.entries(raw as Record<string, unknown>)
    .filter(([name]) => name.trim().length > 0)
    .map(([name, value]) => ({ name: name.trim(), value: typeof value === 'string' ? value.trim() : '' }))
}

/** Each canvas item describes one database resource registration. */
export function extractDatabaseSpecs(canvas: CanvasSnapshot): DatabaseSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = typeof fields.name === 'string' ? fields.name.trim() : ''
    const protocol = typeof fields.protocol === 'string' ? fields.protocol.trim().toLowerCase() : ''
    const uri = typeof fields.uri === 'string' ? fields.uri.trim() : ''
    const labels = labelsFromKeyValue(fields.labels)
    const caCert = typeof fields.caCert === 'string' && fields.caCert.trim() ? fields.caCert.trim() : null

    const awsAccountId = typeof fields.awsAccountId === 'string' ? fields.awsAccountId.trim() : ''
    const awsResourceId = typeof fields.awsResourceId === 'string' ? fields.awsResourceId.trim() : ''
    const awsVpcId = typeof fields.awsVpcId === 'string' ? fields.awsVpcId.trim() : ''
    const awsSubnets = Array.isArray(fields.awsSubnets)
      ? fields.awsSubnets.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim())
      : []
    const hasAnyAwsField = !!(awsAccountId || awsResourceId || awsVpcId || awsSubnets.length > 0)
    const awsRds = hasAnyAwsField ? { accountId: awsAccountId, resourceId: awsResourceId, vpcId: awsVpcId, subnets: awsSubnets } : null

    return { sectionName: section.name, name, protocol, uri, labels, caCert, awsRds }
  })
}

export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractDatabaseSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Database name is required', code: 'required' })
    } else {
      if (!DB_NAME_PATTERN.test(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: 'Database name may only contain letters, numbers, dots, underscores and hyphens',
          code: 'invalid_name',
        })
      }
      if (seenNames.has(spec.name)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate database "${spec.name}" — each database name may only be declared once per canvas`,
          code: 'duplicate_database',
        })
      }
      seenNames.add(spec.name)
    }

    if (!spec.protocol) {
      errors.push({ field: `${prefix}.protocol`, message: 'Protocol is required', code: 'required' })
    } else if (!PROTOCOL_PATTERN.test(spec.protocol)) {
      errors.push({
        field: `${prefix}.protocol`,
        message: 'Protocol may only contain lowercase letters, numbers and hyphens',
        code: 'invalid_protocol',
      })
    }

    if (!spec.uri) {
      errors.push({ field: `${prefix}.uri`, message: 'Connection URI is required', code: 'required' })
    }

    if (spec.awsRds) {
      if (!spec.awsRds.accountId) errors.push({ field: `${prefix}.awsAccountId`, message: 'AWS Account ID is required once any AWS RDS field is set', code: 'incomplete_aws_rds' })
      if (!spec.awsRds.resourceId) errors.push({ field: `${prefix}.awsResourceId`, message: 'AWS RDS Resource ID is required once any AWS RDS field is set', code: 'incomplete_aws_rds' })
      if (!spec.awsRds.vpcId) errors.push({ field: `${prefix}.awsVpcId`, message: 'AWS VPC ID is required once any AWS RDS field is set', code: 'incomplete_aws_rds' })
      if (spec.awsRds.subnets.length === 0) errors.push({ field: `${prefix}.awsSubnets`, message: 'At least one AWS subnet is required once any AWS RDS field is set', code: 'incomplete_aws_rds' })
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
