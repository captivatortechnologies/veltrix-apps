import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Vault plugin catalog constraints ----------------------------------------

/**
 * The three catalog namespaces a plugin can be registered under. The type is
 * part of a plugin's identity and part of its path
 * (/sys/plugins/catalog/{type}/{name}); a name is only unique WITHIN a type, so
 * an "auth" plugin and a "secret" plugin may share a name.
 */
export const PLUGIN_TYPES = ['auth', 'database', 'secret'] as const
export type PluginType = (typeof PLUGIN_TYPES)[number]

/** A plugin name goes into a URL path segment — keep it to safe characters. */
export const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/

/** A SHA-256 digest is exactly 64 lower-case hex characters. */
export const SHA256_PATTERN = /^[a-f0-9]{64}$/

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface PluginSpec {
  sectionName: string
  /** Catalog namespace — auth | database | secret. Part of the identity + path. */
  type: string
  /** Plugin name — the catalog key WITHIN its type; part of the identity + path. */
  name: string
  /** Optional semantic version registered alongside the binary. */
  version?: string
  /** SHA-256 hex digest of the pre-staged plugin binary (64 lower-case hex chars). */
  sha256: string
  /** Executable path RELATIVE to the cluster's plugin_directory. */
  command: string
  /** Raw args JSON string — a JSON array of strings passed to the binary. */
  argsJson?: string
  /**
   * Raw env JSON string — a JSON array of "KEY=value" strings. NOT returned on
   * GET (may hold secrets), so it is authored here but never read back or
   * drift-checked. See driftDetect.
   */
  envJson?: string
}

/**
 * Shape of a catalog entry returned by GET /sys/plugins/catalog/{type}/{name}
 * (under `data`). NOTE: `env` is deliberately NOT modelled — Vault never returns
 * it on read, so no handler can (or should) read it back or diff it.
 */
export interface LivePlugin {
  name?: string
  sha256?: string
  command?: string
  args?: string[]
  version?: string
  /** true = a Vault BUILT-IN plugin. This app manages EXTERNAL plugins only and
   *  must never register/update/delete a builtin entry (see deploy). */
  builtin?: boolean
}

/** True when a string is one of the three valid catalog types. */
export function isValidPluginType(value: string): value is PluginType {
  return (PLUGIN_TYPES as readonly string[]).includes(value)
}

/** The composite catalog identity "type/name" — the dedup + match key. */
export function pluginKey(type: string, name: string): string {
  return `${type}/${name}`
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Parse a raw JSON string into an array of strings, or null when the string is
 * not a JSON array of strings (an object, a primitive, or an array containing a
 * non-string element all count as invalid). Shared by validate (to reject bad
 * input) and deploy (to build the register body's `args`/`env`).
 */
export function parseStringArray(raw: string): string[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  if (!parsed.every((v) => typeof v === 'string')) return null
  return parsed as string[]
}

/** Each canvas section describes one Vault plugin catalog entry. */
export function extractPluginSpecs(canvas: CanvasSnapshot): PluginSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    return {
      sectionName: section.name,
      // Types are lower-case in Vault; fold input so comparisons/paths hold.
      type: typeof fields.type === 'string' ? fields.type.trim().toLowerCase() : '',
      name: typeof fields.name === 'string' ? fields.name.trim() : '',
      version: optionalString(fields.version),
      // A SHA-256 is compared/registered as lower-case hex.
      sha256: typeof fields.sha256 === 'string' ? fields.sha256.trim().toLowerCase() : '',
      command: typeof fields.command === 'string' ? fields.command.trim() : '',
      argsJson: optionalString(fields.argsJson),
      envJson: optionalString(fields.envJson),
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate plugin catalog configurations against Vault's constraints (no
 * network): a valid catalog type, a name (safe path characters), a 64-hex-char
 * SHA-256, and a command are required; any args/env must be a JSON array of
 * strings; and the (type, name) pair — a plugin's identity — must be unique per
 * canvas. Static rules only.
 *
 * This does NOT check `builtin` — that is a LIVE property. The external-only
 * guarantee (never touching a builtin entry) is enforced at deploy time against
 * the running cluster, because the catalog's builtin plugins are not knowable
 * statically and there is no documented denylist to hardcode.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractPluginSpecs(ctx.canvas)
  const seenKeys = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // type — required, one of auth|database|secret
    if (!spec.type) {
      errors.push({ field: `${prefix}.type`, message: 'Plugin type is required', code: 'required' })
    } else if (!isValidPluginType(spec.type)) {
      errors.push({
        field: `${prefix}.type`,
        message: `Plugin type must be one of ${PLUGIN_TYPES.join(', ')}`,
        code: 'invalid_type',
      })
    }

    // name — required, safe path characters
    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Plugin name is required', code: 'required' })
    } else if (!PLUGIN_NAME_PATTERN.test(spec.name)) {
      errors.push({
        field: `${prefix}.name`,
        message: 'Plugin name may contain only letters, digits, and the characters _ . -',
        code: 'invalid_name',
      })
    }

    // sha256 — required, exactly 64 lower-case hex chars
    if (!spec.sha256) {
      errors.push({ field: `${prefix}.sha256`, message: 'SHA-256 of the plugin binary is required', code: 'required' })
    } else if (!SHA256_PATTERN.test(spec.sha256)) {
      errors.push({
        field: `${prefix}.sha256`,
        message: 'SHA-256 must be exactly 64 hexadecimal characters',
        code: 'invalid_sha256',
      })
    }

    // command — required (relative to plugin_directory; the binary must be pre-staged)
    if (!spec.command) {
      errors.push({
        field: `${prefix}.command`,
        message: 'Command is required — the plugin executable relative to the cluster plugin_directory',
        code: 'required',
      })
    }

    // args — optional; when present must be a JSON array of strings
    if (spec.argsJson !== undefined && parseStringArray(spec.argsJson) === null) {
      errors.push({
        field: `${prefix}.argsJson`,
        message: 'Args must be a JSON array of strings, e.g. ["--log-level","debug"]',
        code: 'invalid_args',
      })
    }

    // env — optional; when present must be a JSON array of strings. Its VALUES
    // are not inspected (they may be secrets) and are never drift-checked.
    if (spec.envJson !== undefined && parseStringArray(spec.envJson) === null) {
      errors.push({
        field: `${prefix}.envJson`,
        message: 'Env must be a JSON array of "KEY=value" strings, e.g. ["API_HOST=example.com"]',
        code: 'invalid_env',
      })
    }

    // (type, name) is the plugin's identity — dedupe on the composite key so it
    // agrees with the live match in deploy / drift. A name may repeat across
    // different types; only the same type AND name is a duplicate.
    if (spec.type && spec.name) {
      const key = pluginKey(spec.type, spec.name)
      if (seenKeys.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate plugin "${key}" — each (type, name) plugin may only be declared once per canvas`,
          code: 'duplicate_plugin',
        })
      }
      seenKeys.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
