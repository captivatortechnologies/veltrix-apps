import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault audit device (sys/audit) constraints -------------------------------

/** The audit backends Vault supports through this app. */
export const AUDIT_DEVICE_TYPES = ['file', 'syslog', 'socket'] as const
export type AuditDeviceType = (typeof AUDIT_DEVICE_TYPES)[number]

/** Transports a "socket" audit device may use. */
export const SOCKET_TYPES = ['tcp', 'udp'] as const

/**
 * A mount path may contain letters, digits and the characters _ . / - (Vault
 * mounts a device at sys/audit/<path>). There is no reserved audit path: Vault
 * ships with NO audit devices enabled and never auto-creates one, so — unlike
 * secret mounts or auth methods — there is no built-in path to protect here.
 */
const PATH_PATTERN = /^[A-Za-z0-9_./-]+$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface AuditDeviceSpec {
  sectionName: string
  /** Mount path (the logical identity), stripped of any surrounding slashes. */
  path: string
  /** Backend type — file | syslog | socket (empty when unset). */
  type: string
  description?: string
  /** file device: absolute log path (options.file_path). */
  filePath?: string
  /** syslog device: options.facility (optional; Vault defaults AUTH). */
  syslogFacility?: string
  /** syslog device: options.tag (optional; Vault defaults vault). */
  syslogTag?: string
  /** socket device: options.address as host:port. */
  socketAddress?: string
  /** socket device: options.socket_type — tcp | udp. */
  socketType?: string
}

/** Shape of an audit device returned by GET /sys/audit (keyed by "<path>/"). */
export interface LiveAuditDevice {
  type?: string
  description?: string
  options?: Record<string, unknown>
}

/** Trim a path and strip leading/trailing slashes so "file/" and "file" match. */
export function normalizeAuditPath(raw: string): string {
  return raw.trim().replace(/^\/+|\/+$/g, '')
}

/** Each canvas section describes one Vault audit device. */
export function extractAuditDeviceSpecs(canvas: CanvasSnapshot): AuditDeviceSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const str = (key: string): string | undefined => {
      const v = fields[key]
      return typeof v === 'string' && v.trim() ? v.trim() : undefined
    }

    return {
      sectionName: section.name,
      path: typeof fields.path === 'string' ? normalizeAuditPath(fields.path) : '',
      type: typeof fields.type === 'string' ? fields.type.trim() : '',
      description: str('description'),
      filePath: str('filePath'),
      syslogFacility: str('syslogFacility'),
      syslogTag: str('syslogTag'),
      socketAddress: str('socketAddress'),
      socketType: str('socketType'),
    }
  })
}

/**
 * Build the Vault `options` map for a device from ONLY the fields relevant to
 * its type — a file device never carries socket options, and vice versa. Shared
 * by deploy (to build the enable body) and driftDetect (to diff managed keys).
 * An unset optional field is simply omitted so Vault keeps its own default.
 */
export function buildAuditOptions(spec: AuditDeviceSpec): Record<string, string> {
  const options: Record<string, string> = {}
  switch (spec.type) {
    case 'file':
      if (spec.filePath) options.file_path = spec.filePath
      break
    case 'syslog':
      if (spec.syslogFacility) options.facility = spec.syslogFacility
      if (spec.syslogTag) options.tag = spec.syslogTag
      break
    case 'socket':
      if (spec.socketAddress) options.address = spec.socketAddress
      if (spec.socketType) options.socket_type = spec.socketType
      break
  }
  return options
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate audit device configurations against the sys/audit API constraints:
 * a path is required (matching the mount-path pattern), a type is required and
 * must be one of file/syslog/socket, the type-specific required options are
 * present (file → file_path; socket → address + socket_type), and the path — an
 * audit device's logical identity — is unique within the canvas.
 *
 * Static rules only: whether a file path is writable or a socket/syslog target
 * is reachable cannot be known without touching the target, so that is left to
 * deploy (and flagged as a blocking risk in its message).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractAuditDeviceSpecs(ctx.canvas)
  const seenPaths = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // path — required, must match the mount-path pattern, unique in the canvas
    if (!spec.path) {
      errors.push({ field: `${prefix}.path`, message: 'Audit device path is required', code: 'required' })
    } else {
      if (!PATH_PATTERN.test(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: 'Audit device path may contain only letters, digits, and the characters _ . / -',
          code: 'invalid_path',
        })
      }
      // The path is the device's logical identity — dedupe on it (matched
      // exactly, as deploy resolves the live device by the same normalized path).
      if (seenPaths.has(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: `Duplicate audit device path "${spec.path}" — each path may only be declared once per canvas`,
          code: 'duplicate_device',
        })
      }
      seenPaths.add(spec.path)
    }

    // type — required, one of file/syslog/socket, with type-specific options
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Audit device type is required', code: 'required' })
    } else if (!AUDIT_DEVICE_TYPES.includes(spec.type as AuditDeviceType)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Audit device type must be one of: ${AUDIT_DEVICE_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    } else if (spec.type === 'file') {
      // file backend: a file_path is mandatory
      if (!spec.filePath) {
        errors.push({
          field: `${prefix}.filePath`,
          message: 'A file audit device requires a file path (options.file_path)',
          code: 'required',
        })
      }
    } else if (spec.type === 'socket') {
      // socket backend: address and socket_type are both mandatory
      if (!spec.socketAddress) {
        errors.push({
          field: `${prefix}.socketAddress`,
          message: 'A socket audit device requires an address (host:port)',
          code: 'required',
        })
      }
      if (!spec.socketType) {
        errors.push({
          field: `${prefix}.socketType`,
          message: 'A socket audit device requires a socket type (tcp or udp)',
          code: 'required',
        })
      } else if (!SOCKET_TYPES.includes(spec.socketType as (typeof SOCKET_TYPES)[number])) {
        errors.push({
          field: `${prefix}.socketType`,
          message: 'Socket type must be tcp or udp',
          code: 'invalid_socket_type',
        })
      }
    }
    // syslog backend: facility and tag are optional — Vault defaults them.
  }

  return { valid: errors.length === 0, errors, warnings }
}
