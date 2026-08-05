import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault namespace constraints (Vault ENTERPRISE only) ----------------------
//
// See: https://developer.hashicorp.com/vault/api-docs/system/namespaces
// A namespace is an isolated Vault "tenant" within a cluster — its own mounts,
// policies, auth methods and identity store. This config type manages a
// namespace's EXISTENCE and custom_metadata only; everything created INSIDE a
// namespace (its mounts, policies, ...) is managed by every OTHER config type
// in this app, scoped to that namespace via the app's `namespace` setting.
//
// Namespace management calls are typically made from the PARENT namespace
// (usually root) — see the README for how this interacts with the app's
// `namespace` setting.

/**
 * A namespace path is one or more `/`-separated segments of letters, digits,
 * underscores and hyphens (nested namespaces use a "parent/child" path).
 * Vault stores/returns it with a trailing slash; this app always normalizes to
 * the no-trailing-slash form and adds the slash only where the API requires it.
 */
export const NAMESPACE_PATH_PATTERN = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface NamespaceSpec {
  sectionName: string
  /** Namespace path (no surrounding/trailing slashes) — the logical identity. */
  path: string
  /**
   * Raw metadata JSON string (a flat object of string values). Parsed lazily by
   * deploy / driftDetect via resolveMetadata; validate rejects a non-object or
   * a non-string value. Absent/blank means "no metadata".
   */
  customMetadataJson?: string
}

/** Shape of a namespace returned by GET /sys/namespaces/{path} (under `data`). */
export interface LiveNamespace {
  id?: string
  path?: string
  custom_metadata?: Record<string, string> | null
}

/** Trim a raw path and strip surrounding slashes so it is canonical. */
export function normalizeNamespacePath(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^\/+|\/+$/g, '')
}

/**
 * Parse a raw metadata string, returning the object or null when it is not a
 * JSON object (an array or primitive counts as invalid).
 */
export function parseMetadataObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

/** Resolve authored metadata to Vault's map[string]string; blank/invalid ⇒ {}. */
export function resolveMetadata(metadataJson: string | undefined): Record<string, string> {
  if (!metadataJson) return {}
  const parsed = parseMetadataObject(metadataJson)
  if (!parsed) return {}
  const out: Record<string, string> = {}
  for (const [key, val] of Object.entries(parsed)) {
    if (val === undefined || val === null) continue
    out[key] = typeof val === 'string' ? val : String(val)
  }
  return out
}

/** Each canvas section describes one Vault namespace. */
export function extractNamespaceSpecs(canvas: CanvasSnapshot): NamespaceSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const customMetadataJson =
      typeof fields.customMetadataJson === 'string' && fields.customMetadataJson.trim()
        ? fields.customMetadataJson.trim()
        : undefined
    return {
      sectionName: section.name,
      path: normalizeNamespacePath(fields.path),
      customMetadataJson,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate namespace configurations against Vault's constraints (no network):
 * a path is required (letters/digits/_/- per segment, "/"-separated for
 * nesting) and unique per canvas — the namespace's logical identity — and any
 * custom metadata is a flat JSON object of string values.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractNamespaceSpecs(ctx.canvas)
  const seenPaths = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // path — required, valid charset, unique in canvas
    if (!spec.path) {
      errors.push({ field: `${prefix}.path`, message: 'Namespace path is required', code: 'required' })
    } else {
      if (!NAMESPACE_PATH_PATTERN.test(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: 'Namespace path may contain only letters, digits, underscores and hyphens per segment, "/"-separated for nesting (e.g. "team-a" or "team-a/dev")',
          code: 'invalid_path',
        })
      }
      if (seenPaths.has(spec.path)) {
        errors.push({
          field: `${prefix}.path`,
          message: `Duplicate namespace path "${spec.path}" — each namespace may only be declared once per canvas`,
          code: 'duplicate_path',
        })
      }
      seenPaths.add(spec.path)
    }

    // customMetadataJson — optional; when present must be a flat JSON object of strings
    if (spec.customMetadataJson !== undefined) {
      const parsed = parseMetadataObject(spec.customMetadataJson)
      if (parsed === null) {
        errors.push({
          field: `${prefix}.customMetadataJson`,
          message: 'Custom metadata must be a JSON object, e.g. {"team":"platform","cost-center":"1234"}',
          code: 'invalid_metadata',
        })
      } else {
        for (const [key, val] of Object.entries(parsed)) {
          if (typeof val !== 'string') {
            errors.push({
              field: `${prefix}.customMetadataJson`,
              message: `Custom metadata value for "${key}" must be a string`,
              code: 'invalid_metadata_value',
            })
          }
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
