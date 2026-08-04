// Shared helpers for the Axonius Lifecycle Settings config type (deploy +
// rollback + drift + validate). A tenant-wide SINGLETON over the discovery
// (lifecycle) schedule settings — declare this config type at most once per
// canvas, the same shape as Auth0's tenant-settings singleton in this
// monorepo. The full settings surface (api/settings/plugins/{plugin}/{config})
// is generic and version-specific, so — like Cisco Meraki's whole-object
// settings singletons — this config type curates NOT a fixed field list but a
// partial, shallow, top-level JSON overlay: only the top-level keys declared
// here are ever touched; every other live key is preserved untouched. This
// avoids guessing at internal schedule schema field names while still being
// genuinely declarative and safely reversible.
//
// Endpoint + plugin/config identity (verified against axonius_api_client
// master — api/system/settings.py's `SettingsLifecycle` class, api_endpoints.py,
// json_api/system_settings.py):
//   GET api/settings/plugins/system_scheduler/SystemSchedulerService
//   PUT api/settings/plugins/system_scheduler/SystemSchedulerService
//     body: { data: { type: "settings_schema", attributes: { config, configName, pluginId } } }
//     (type_ "settings_schema" confirmed on SystemSettingsUpdateSchema.Meta)
//
// To discover the exact live keys/shape for your tenant/version, inspect a
// healthCheck / GET response, or the Axonius GUI's Lifecycle Settings page —
// this config type never hardcodes internal field names.

/** The `system_scheduler` plugin backs the GUI's "Lifecycle Settings" (discovery schedule). */
export const LIFECYCLE_PLUGIN_NAME = 'system_scheduler'
/** The `SystemSchedulerService` config name backs the GUI's "Lifecycle Settings". */
export const LIFECYCLE_CONFIG_NAME = 'SystemSchedulerService'

/** GET/PUT — the Lifecycle Settings document for this plugin/config pair. */
export const LIFECYCLE_SETTINGS_RESOURCE = `settings/plugins/${LIFECYCLE_PLUGIN_NAME}/${LIFECYCLE_CONFIG_NAME}`

/** JSON:API resource type for the settings get/update body (settings_schema). */
const SETTINGS_SCHEMA_TYPE = 'settings_schema'

// --- Field parsing --------------------------------------------------------

/**
 * Parse the `overrides` canvas field into a JSON object of top-level keys to
 * shallow-merge onto the live config. An empty value yields an empty object
 * (a deploy that touches nothing).
 */
export function parseOverrides(value: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const raw = String(value ?? '').trim()
  if (!raw) return { ok: true, value: {} }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'invalid JSON' }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'must be a JSON object' }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

// --- Body building --------------------------------------------------------

/** JSON:API update body for the settings endpoint — see the file header for the exact verified shape. */
export function buildSettingsUpdateBody(config: Record<string, unknown>): {
  data: { type: string; attributes: Record<string, unknown> }
} {
  return {
    data: {
      type: SETTINGS_SCHEMA_TYPE,
      attributes: { config, configName: LIFECYCLE_CONFIG_NAME, pluginId: LIFECYCLE_PLUGIN_NAME },
    },
  }
}

/** Shallow-merge declared top-level `overrides` onto the live config — declared keys win, everything else is preserved. */
export function mergeOverrides(live: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...live, ...overrides }
}

// --- Response parsing ---------------------------------------------------------

/** Extract the `config` object from the settings GET/PUT response document. */
export function configFromResponse(json: unknown): Record<string, unknown> {
  const attrs = (json as { data?: { attributes?: { config?: unknown } } })?.data?.attributes
  const config = attrs?.config
  return config && typeof config === 'object' && !Array.isArray(config) ? (config as Record<string, unknown>) : {}
}
