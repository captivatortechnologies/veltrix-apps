import type { PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { PROTOCOL_POLICIES, extractResourceSpecs, parsePortRanges, resourceKey, type ResourceSpec } from './_shared'

/**
 * Validate Twingate Resource configurations: name, address and remote network
 * name are required and the resource name must be unique across the canvas
 * (case-insensitive); TCP/UDP policy must be a supported `ProtocolPolicy`; a
 * "Restricted" policy requires at least one valid port entry, and a port entry
 * on a non-Restricted policy is flagged (harmless — Twingate ignores it — but
 * likely a leftover). Purely static: no live Twingate calls (remote network /
 * group NAME resolution happens at deploy/drift time, against the live tenant).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const items = ctx.canvas.items ?? ctx.canvas.sections ?? []
  if (items.length === 0) {
    errors.push({ field: 'items', message: 'Canvas has no configuration items', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractResourceSpecs(ctx.canvas)
  const seen = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.itemName
    validateRequiredFields(spec, prefix, errors)
    validatePolicy(spec.tcpPolicy, 'tcp_policy', prefix, errors)
    validatePolicy(spec.udpPolicy, 'udp_policy', prefix, errors)
    validatePortsForPolicy(spec.tcpPolicy, spec.tcpPorts, 'tcp_ports', prefix, errors, warnings)
    validatePortsForPolicy(spec.udpPolicy, spec.udpPorts, 'udp_ports', prefix, errors, warnings)
    validateUniqueName(spec, prefix, seen, errors)
  }

  return { valid: errors.length === 0, errors, warnings }
}

function validateRequiredFields(spec: ResourceSpec, prefix: string, errors: ValidationResult['errors']): void {
  if (!spec.name) {
    errors.push({ field: `${prefix}.name`, message: 'Resource name is required', code: 'required' })
  }
  if (!spec.address) {
    errors.push({ field: `${prefix}.address`, message: 'Address is required', code: 'required' })
  }
  if (!spec.remoteNetworkName) {
    errors.push({
      field: `${prefix}.remote_network_name`,
      message: 'Remote Network name is required',
      code: 'required',
    })
  }
}

function validatePolicy(
  policy: string,
  field: 'tcp_policy' | 'udp_policy',
  prefix: string,
  errors: ValidationResult['errors'],
): void {
  if (!PROTOCOL_POLICIES.includes(policy as (typeof PROTOCOL_POLICIES)[number])) {
    errors.push({ field: `${prefix}.${field}`, message: `Unsupported policy "${policy}"`, code: 'invalid_policy' })
  }
}

function validatePortsForPolicy(
  policy: string,
  ports: string[],
  field: 'tcp_ports' | 'udp_ports',
  prefix: string,
  errors: ValidationResult['errors'],
  warnings: ValidationResult['warnings'],
): void {
  const { ranges, invalid } = parsePortRanges(ports)
  for (const raw of invalid) {
    errors.push({
      field: `${prefix}.${field}`,
      message: `"${raw}" is not a valid port (1-65535) or range (e.g. "8000-9000")`,
      code: 'invalid_port',
    })
  }

  if (policy === 'RESTRICTED' && ranges.length === 0 && invalid.length === 0) {
    errors.push({
      field: `${prefix}.${field}`,
      message: 'At least one port or port range is required when the policy is Restricted',
      code: 'required',
    })
  }
  if (policy !== 'RESTRICTED' && (ranges.length > 0 || invalid.length > 0)) {
    warnings.push({
      field: `${prefix}.${field}`,
      message: `Ports are only enforced when the policy is Restricted — they are ignored while it is "${policy}"`,
      code: 'ignored_ports',
    })
  }
}

function validateUniqueName(
  spec: ResourceSpec,
  prefix: string,
  seen: Set<string>,
  errors: ValidationResult['errors'],
): void {
  if (!spec.name) return
  const key = resourceKey(spec.name)
  if (seen.has(key)) {
    errors.push({
      field: `${prefix}.name`,
      message: `Duplicate resource "${spec.name}" — each resource name may only be declared once`,
      code: 'duplicate_resource',
    })
  }
  seen.add(key)
}
