// Shared helpers for the OpenCTI Entity Settings config type
// (deploy + rollback + drift).
//
// Verified against the OpenCTI GraphQL backend schema (opencti-platform/opencti,
// src/modules/entitySetting/entitySetting.graphql). This type has a UNIQUE
// shape versus every other type in this app: OpenCTI seeds an EntitySetting
// singleton for every known entity type at platform install time — there is NO
// `entitySettingAdd`/`entitySettingDelete` mutation. This type only ever
// field-patches an EXISTING setting (looked up by `target_type` via
// `entitySettingByType`); deploy fails clearly (not "create") when a
// `target_type` doesn't resolve, and rollback always restores prior fields
// (never deletes, since these are permanent platform singletons).

/** The node fields we read back on every entity setting (lookup + patch payloads). */
export const ENTITY_SETTING_NODE_FIELDS = `id target_type platform_entity_files_ref platform_hidden_type enforce_reference
  attributes_configuration overview_layout_customization { key width label }`

// --- GraphQL documents --------------------------------------------------------

/** Look up the (always pre-existing) EntitySetting singleton for one entity type. */
export const LOOKUP_ENTITY_SETTING_QUERY = `query EntitySettingByType($targetType: String!) {
  entitySettingByType(targetType: $targetType) { ${ENTITY_SETTING_NODE_FIELDS} }
}`

/**
 * Patch one or more entity settings by internal id. Since each canvas item
 * targets exactly ONE `target_type`, this is always called with a single-item
 * `ids` array. input: [EditInput!]!
 */
export const PATCH_ENTITY_SETTINGS_MUTATION = `mutation EntitySettingsFieldPatch($ids: [ID!]!, $input: [EditInput!]!) {
  entitySettingsFieldPatch(ids: $ids, input: $input) { ${ENTITY_SETTING_NODE_FIELDS} }
}`

/** One `OverviewWidgetCustomization` entry on an entity setting's overview layout. */
export interface OverviewWidgetCustomization {
  key: string
  width: number
  label: string
}

/** One OpenCTI entity setting node. */
export interface OpenctiEntitySetting {
  id?: string
  target_type?: string
  platform_entity_files_ref?: boolean | null
  platform_hidden_type?: boolean | null
  enforce_reference?: boolean | null
  attributes_configuration?: string | null
  overview_layout_customization?: OverviewWidgetCustomization[] | null
  [key: string]: unknown
}

/**
 * One EditInput entry for entitySettingsFieldPatch. `value` is `[Any]!` on the
 * OpenCTI backend — send native JS values, never stringify booleans. An
 * array-valued attribute (`overview_layout_customization`) is patched with
 * `value` set to the FULL replacement array (not wrapped in another array).
 */
export interface EditInput {
  key: string
  value: unknown[]
}

/** Coerce a canvas checkbox field to a boolean (fallback when blank). */
export function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const s = String(value).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no') return false
  return fallback
}

/** Trim a string field (undefined when blank). */
export function normalizeText(value: unknown): string | undefined {
  const s = String(value ?? '').trim()
  return s === '' ? undefined : s
}

/**
 * Build the entitySettingsFieldPatch `input` (an array of EditInput) from
 * canvas fields. The three booleans are always sent (a checkbox never renders
 * blank); the two JSON-textarea fields are only sent when non-blank, leaving
 * the existing value untouched otherwise.
 */
export function buildEntitySettingPatch(fields: Record<string, unknown>): EditInput[] {
  const patch: EditInput[] = [
    { key: 'platform_hidden_type', value: [normalizeBool(fields.platform_hidden_type, false)] },
    { key: 'enforce_reference', value: [normalizeBool(fields.enforce_reference, false)] },
    { key: 'platform_entity_files_ref', value: [normalizeBool(fields.platform_entity_files_ref, false)] },
  ]
  const attributesConfiguration = normalizeText(fields.attributes_configuration)
  if (attributesConfiguration !== undefined) patch.push({ key: 'attributes_configuration', value: [attributesConfiguration] })
  const overviewLayoutRaw = normalizeText(fields.overview_layout_customization)
  if (overviewLayoutRaw !== undefined) {
    patch.push({ key: 'overview_layout_customization', value: JSON.parse(overviewLayoutRaw) })
  }
  return patch
}

/** Build an EditInput[] that restores a prior entity setting body (for rollback). */
export function buildRestorePatch(prior: OpenctiEntitySetting): EditInput[] {
  return [
    { key: 'platform_hidden_type', value: [prior.platform_hidden_type ?? false] },
    { key: 'enforce_reference', value: [prior.enforce_reference ?? false] },
    { key: 'platform_entity_files_ref', value: [prior.platform_entity_files_ref ?? false] },
    { key: 'attributes_configuration', value: [prior.attributes_configuration ?? ''] },
    { key: 'overview_layout_customization', value: Array.isArray(prior.overview_layout_customization) ? prior.overview_layout_customization : [] },
  ]
}
