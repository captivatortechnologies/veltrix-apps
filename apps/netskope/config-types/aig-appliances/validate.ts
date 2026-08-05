import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Netskope AI Gateway appliance constraints --------------------------------
// Backed by /api/v2/aig/appliances. Manages the appliance record itself
// (name, host, ports, associated AI providers / MCP servers, SKU add-ons) —
// never the one-time JWT enrollment token returned inline on create, which is
// secret material used to enroll the physical/virtual box and is neither
// read back nor diffed by this app.

export const MAX_NAME_LENGTH = 15
export const SKU_PRODUCT_CODES = ['NK-A-AIGW-10K', 'NK-A-AIGW-100K'] as const

export interface SkuAddon {
  productCode: string
  quantity?: number
}

export interface AigApplianceSpec {
  itemId?: string
  /** name — the logical identity (appliances are id-addressed). */
  name: string
  host: string
  httpEnable: boolean
  httpPort: number
  httpsEnable: boolean
  httpsPort: number
  /** AI provider NAMES; resolved to provider_ids against aig-ai-providers at deploy. */
  aiProviders: string[]
  /** MCP server NAMES; resolved to server_ids against aig-mcp-servers at deploy. */
  mcpServers: string[]
  /** Capacity-pack add-ons — billing/licensing implications, see README. */
  skuAddons: SkuAddon[]
  /** Raw text of the sku_addons field, kept for surfacing JSON parse errors. */
  skuAddonsRaw: string
  skuAddonsError?: string
}

/** An appliance as returned by GET /api/v2/aig/appliances. Read-only telemetry
 *  (status, ips, version, cpu/memory, timestamps, enrollment_token, ...) is
 *  never sent and never diffed. */
export interface LiveAigAppliance {
  id?: string
  name?: string
  host?: string
  ports?: { http?: { enable?: boolean; port?: number }; https?: { enable?: boolean; port?: number } }
  ai_provider_ids?: string[]
  mcp_server_ids?: string[]
  sku_addons?: Array<{ product_code?: string; quantity?: number }>
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

export function asNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const n = Number(asString(v))
  return Number.isFinite(n) && asString(v) !== '' ? n : fallback
}

/** Split a textarea/array value into trimmed, non-empty entries. */
export function splitEntries(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter((t) => t.length > 0)
  return asString(v)
    .split(/[\n,]/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

export function liveAigApplianceId(l: LiveAigAppliance): string | undefined {
  return l.id === undefined || l.id === null ? undefined : String(l.id)
}

/** Parse the sku_addons textarea as a JSON array of {productCode, quantity?}. */
function parseSkuAddons(raw: string): { addons: SkuAddon[]; error?: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { addons: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { addons: [], error: 'sku_addons must be valid JSON' }
  }
  if (!Array.isArray(parsed)) return { addons: [], error: 'sku_addons must be a JSON array' }
  const addons: SkuAddon[] = parsed.map((entry) => {
    const obj = (entry ?? {}) as Record<string, unknown>
    const productCode = asString(obj.productCode ?? obj.product_code)
    const quantity = obj.quantity === undefined ? undefined : asNumber(obj.quantity, NaN)
    return { productCode, quantity }
  })
  return { addons }
}

export function extractAigApplianceSpecs(canvas: CanvasSnapshot): AigApplianceSpec[] {
  const items = canvas.items ?? canvas.sections ?? []
  return items.map((item) => {
    const f = item.fields ?? {}
    const skuAddonsRaw = asString(f.sku_addons)
    const { addons, error } = parseSkuAddons(skuAddonsRaw)
    return {
      itemId: item.id,
      name: asString(f.name) || item.name,
      host: asString(f.host),
      httpEnable: f.http_enable === true,
      httpPort: asNumber(f.http_port, 80),
      httpsEnable: f.https_enable !== false,
      httpsPort: asNumber(f.https_port, 443),
      aiProviders: splitEntries(f.ai_provider_ids),
      mcpServers: splitEntries(f.mcp_server_ids),
      skuAddons: addons,
      skuAddonsRaw,
      skuAddonsError: error,
    }
  })
}

export default function validate(ctx: PipelineContext): ValidationResult {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []
  const specs = extractAigApplianceSpecs(ctx.canvas)
  const seenNames = new Set<string>()

  specs.forEach((spec, i) => {
    const prefix = `items[${i}]`

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Name is required', code: 'required' })
    } else {
      if (spec.name.length > MAX_NAME_LENGTH) {
        errors.push({ field: `${prefix}.name`, message: `Name must be ${MAX_NAME_LENGTH} characters or fewer`, code: 'too_long' })
      }
      const key = spec.name.toLowerCase()
      if (seenNames.has(key)) {
        errors.push({ field: `${prefix}.name`, message: `Duplicate AI Gateway appliance "${spec.name}"`, code: 'duplicate_name' })
      }
      seenNames.add(key)
    }

    if (!spec.host) {
      errors.push({ field: `${prefix}.host`, message: 'Host is required', code: 'required' })
    }

    if (!Number.isInteger(spec.httpPort) || spec.httpPort < 1 || spec.httpPort > 65535) {
      errors.push({ field: `${prefix}.http_port`, message: 'HTTP port must be an integer between 1 and 65535', code: 'invalid_port' })
    }
    if (!Number.isInteger(spec.httpsPort) || spec.httpsPort < 1 || spec.httpsPort > 65535) {
      errors.push({ field: `${prefix}.https_port`, message: 'HTTPS port must be an integer between 1 and 65535', code: 'invalid_port' })
    }
    if (!spec.httpEnable && !spec.httpsEnable) {
      errors.push({ field: `${prefix}.http_enable`, message: 'At least one of HTTP or HTTPS must be enabled', code: 'no_port_enabled' })
    }

    if (spec.aiProviders.length > 10) {
      errors.push({ field: `${prefix}.ai_provider_ids`, message: 'At most 10 AI providers may be associated', code: 'too_many' })
    }
    if (spec.mcpServers.length > 10) {
      errors.push({ field: `${prefix}.mcp_server_ids`, message: 'At most 10 MCP servers may be associated', code: 'too_many' })
    }

    if (spec.skuAddonsError) {
      errors.push({ field: `${prefix}.sku_addons`, message: spec.skuAddonsError, code: 'invalid_json' })
    } else {
      spec.skuAddons.forEach((addon, j) => {
        if (!(SKU_PRODUCT_CODES as readonly string[]).includes(addon.productCode)) {
          errors.push({ field: `${prefix}.sku_addons[${j}].productCode`, message: `productCode must be one of ${SKU_PRODUCT_CODES.join(', ')}`, code: 'invalid_product_code' })
        }
        if (addon.quantity !== undefined && (!Number.isInteger(addon.quantity) || addon.quantity < 1)) {
          errors.push({ field: `${prefix}.sku_addons[${j}].quantity`, message: 'quantity must be a positive integer', code: 'invalid_quantity' })
        }
      })
      if (spec.skuAddons.length > 0) {
        warnings.push({ field: `${prefix}.sku_addons`, message: 'SKU add-ons attach paid capacity packs — verify licensing impact before deploying', code: 'billing_impact' })
      }
    }
  })

  return { valid: errors.length === 0, errors, warnings }
}
