import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { parseFlatScalarObject } from '../lib/qualysJson'

/**
 * Supported authentication record technologies and the classic v2 API block tag
 * each type's `action=list` response repeats (e.g. `<AUTH_UNIX>` inside
 * `<AUTH_UNIX_LIST>`). Confirmed against the Qualys API (VM/PC) User Guide's
 * "List Authentication Records by Type" `<type>` enumeration and per-type Record
 * pages (Scan Authentication chapter). This is a curated subset of the ~30
 * documented record types — the ones with first-party OS/database/appliance
 * scanning support most subscriptions use; niche/rarely-used types (DataStax,
 * MarkLogic, Neo4j, Nginx, Infoblox, SAP HANA/IQ, Cassandra, InformixDB,
 * Kubernetes, vCenter mapping, …) are left to a future pass rather than guessed.
 */
export const AUTH_RECORD_TYPES = [
  { value: 'unix', label: 'Unix / Cisco / Checkpoint Firewall', blockTag: 'AUTH_UNIX' },
  { value: 'windows', label: 'Windows', blockTag: 'AUTH_WINDOWS' },
  { value: 'oracle', label: 'Oracle', blockTag: 'AUTH_ORACLE' },
  { value: 'oracle_listener', label: 'Oracle Listener', blockTag: 'AUTH_ORACLE_LISTENER' },
  { value: 'oracle_weblogic', label: 'Oracle WebLogic Server', blockTag: 'AUTH_ORACLE_WEBLOGIC' },
  { value: 'snmp', label: 'SNMP', blockTag: 'AUTH_SNMP' },
  { value: 'vmware', label: 'VMware', blockTag: 'AUTH_VMWARE' },
  { value: 'ms_sql', label: 'MS SQL Server', blockTag: 'AUTH_MS_SQL' },
  { value: 'mysql', label: 'MySQL', blockTag: 'AUTH_MYSQL' },
  { value: 'postgresql', label: 'PostgreSQL', blockTag: 'AUTH_POSTGRESQL' },
  { value: 'ibm_db2', label: 'IBM DB2', blockTag: 'AUTH_IBM_DB2' },
  { value: 'docker', label: 'Docker', blockTag: 'AUTH_DOCKER' },
  { value: 'http', label: 'HTTP', blockTag: 'AUTH_HTTP' },
  { value: 'network_ssh', label: 'Network Device (SSH)', blockTag: 'AUTH_NETWORK_SSH' },
  { value: 'mongodb', label: 'MongoDB', blockTag: 'AUTH_MONGODB' },
  { value: 'tomcat', label: 'Apache Tomcat', blockTag: 'AUTH_TOMCAT' },
  { value: 'apache', label: 'Apache HTTP Server', blockTag: 'AUTH_APACHE' },
  { value: 'ms_iis', label: 'Microsoft IIS', blockTag: 'AUTH_MS_IIS' },
  { value: 'ibm_websphere', label: 'IBM WebSphere', blockTag: 'AUTH_IBM_WEBSPHERE' },
  { value: 'sybase', label: 'Sybase', blockTag: 'AUTH_SYBASE' },
  { value: 'palo_alto_firewall', label: 'Palo Alto Firewall', blockTag: 'AUTH_PALO_ALTO_FIREWALL' },
  { value: 'ms_exchange', label: 'Microsoft Exchange Server', blockTag: 'AUTH_MS_EXCHANGE' },
] as const

export type AuthRecordType = (typeof AUTH_RECORD_TYPES)[number]['value']

const AUTH_RECORD_TYPE_VALUES = new Set<string>(AUTH_RECORD_TYPES.map((t) => t.value))

/** The block tag a record type's `action=list` response repeats, or undefined if unknown. */
export function authRecordBlockTag(recordType: string): string | undefined {
  return AUTH_RECORD_TYPES.find((t) => t.value === recordType)?.blockTag
}

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AuthRecordSpec {
  sectionName: string
  recordType: string
  title: string
  ips: string
  comments: string
  credentialsJson: string
}

/** Shape of an authentication record parsed from an `action=list` block. Never carries a secret. */
export interface LiveAuthRecord {
  id: string
  title: string
  comments: string
}

/** The (type, title) natural key — auth records are namespaced per technology. */
export function authRecordKey(spec: { recordType: string; title: string }): string {
  return `${spec.recordType.trim().toLowerCase()}::${spec.title.trim().toLowerCase()}`
}

/** Each canvas item describes one Qualys authentication record. */
export function extractAuthRecordSpecs(canvas: CanvasSnapshot): AuthRecordSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      recordType: typeof fields.record_type === 'string' ? fields.record_type.trim() : '',
      title: typeof fields.title === 'string' ? fields.title.trim() : '',
      ips: typeof fields.ips === 'string' ? fields.ips.trim() : '',
      comments: typeof fields.comments === 'string' ? fields.comments.trim() : '',
      credentialsJson: typeof fields.credentials_json === 'string' ? fields.credentials_json : '',
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate authentication record configurations: a supported record type, a
 * unique (per-type) title, at least one target IP/range, and a flat JSON object
 * of type-specific credential parameters (username, password, vault/Kerberos
 * settings, …) are required. The credential material is never inspected beyond
 * "is it flat JSON" — Qualys itself enforces which sub-fields a given technology
 * requires and returns a clear error at deploy time.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAuthRecordSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    if (!spec.recordType) {
      errors.push({ field: `${prefix}.record_type`, message: 'Authentication record type is required', code: 'required' })
    } else if (!AUTH_RECORD_TYPE_VALUES.has(spec.recordType)) {
      errors.push({
        field: `${prefix}.record_type`,
        message: `Unsupported authentication record type "${spec.recordType}"`,
        code: 'invalid_value',
      })
    }

    if (!spec.title) {
      errors.push({ field: `${prefix}.title`, message: 'Authentication record title is required', code: 'required' })
    }

    if (!spec.ips) {
      errors.push({
        field: `${prefix}.ips`,
        message: 'At least one target IP, range or CIDR block is required',
        code: 'required',
      })
    }

    const parsed = parseFlatScalarObject(spec.credentialsJson, { allowEmpty: false })
    if (parsed.error) {
      errors.push({
        field: `${prefix}.credentials_json`,
        message: `Credentials ${parsed.error}`,
        code: 'invalid_json',
      })
    }

    if (spec.recordType && spec.title) {
      const key = authRecordKey(spec)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.title`,
          message: `Duplicate ${spec.recordType} authentication record "${spec.title}" — each (type, title) pair may only be declared once`,
          code: 'duplicate_auth_record',
        })
      }
      seen.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
