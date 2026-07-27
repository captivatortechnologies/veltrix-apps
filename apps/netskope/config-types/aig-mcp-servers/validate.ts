import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope AI Gateway custom MCP server constraints -----------------------

export interface McpServerSpec {
  itemId?: string
  /** name — the logical identity (servers are id-addressed). */
  name: string
  host: string
  port: number
  path: string
  protocol: string
  schema: string
  /** Optional TLS certificate — write-only (never returned by the API). */
  certificate: string
  tools: string[]
  resources: string[]
  prompts: string[]
}

/** An MCP server as returned by GET /api/v2/aig/mcpservers. The certificate is
 *  never returned (write-only). */
export interface LiveMcpServer {
  server_id?: number | string
  id?: number | string
  name?: string
  host?: string
  port?: number
  path?: string
  protocol?: string
  schema?: string
  tools?: string[]
  resources?: string[]
  prompts?: string[]
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(asString(v))
  return Number.isFinite(n) && asString(v) !== '' ? n : fallback
}

export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function liveMcpServerId(l: LiveMcpServer): string | undefined {
  const v = l.server_id ?? l.id
  return v === undefined || v === null ? undefined : String(v)
}

export function extractMcpServerSpecs(canvas: CanvasSnapshot): McpServerSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      host: asString(f.host),
      port: asNumber(f.port, 0),
      path: asString(f.path),
      protocol: asString(f.protocol),
      schema: asString(f.schema),
      certificate: asString(f.certificate),
      tools: splitEntries(f.tools),
      resources: splitEntries(f.resources),
      prompts: splitEntries(f.prompts),
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractMcpServerSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate MCP server "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.host) {
      errors.push({ field: `${prefix}.host`, message: 'Host is required', code: 'required' })
    }
    if (!spec.path) {
      errors.push({ field: `${prefix}.path`, message: 'Path is required', code: 'required' })
    }
    if (!spec.protocol) {
      errors.push({ field: `${prefix}.protocol`, message: 'Protocol is required', code: 'required' })
    }
    if (!Number.isInteger(spec.port) || spec.port < 1 || spec.port > 65535) {
      errors.push({ field: `${prefix}.port`, message: 'Port must be an integer between 1 and 65535', code: 'invalid_port' })
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
