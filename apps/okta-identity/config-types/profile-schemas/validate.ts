import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'

// --- Okta Profile Schemas API constraints ------------------------------------
//
// A profile schema defines the ATTRIBUTES of a profile object. This config type
// manages the CUSTOM attributes (the `#custom` subschema) of a user schema (one
// per user type) or the single group schema. It is UPDATE-ONLY:
//   GET  /meta/schemas/user/{typeId|default}   — read a user-type schema
//   POST /meta/schemas/user/{typeId|default}   — add/update/remove custom props
//   GET  /meta/schemas/group/default           — read the (single) group schema
//   POST /meta/schemas/group/default           — add/update/remove custom props
//
// Rules Okta enforces (mirrored here):
//   - the schema OBJECT itself is never created or deleted — only updated.
//   - BASE (`#base`) attributes are Okta-defined and immutable; a custom attribute
//     may not reuse a base attribute name (a case-insensitive collision).
//   - POST is a PARTIAL update: only the attribute names you send are touched. To
//     REMOVE a custom attribute you POST it explicitly set to `null`.
// This type only ever writes under `definitions.custom.properties`; unmanaged
// custom attributes (names not declared here) are never pruned.

/** Attribute data types Okta accepts for a custom profile property. */
export const ATTRIBUTE_TYPES = new Set(['array', 'boolean', 'integer', 'number', 'string'])

/** A custom attribute name must start with a letter, then letters/digits/underscores. */
export const ATTRIBUTE_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]*$/

/**
 * Okta-defined BASE user profile attributes (SCIM core). A custom attribute may
 * not reuse one of these names — they are immutable and live in `#base`. Compared
 * case-insensitively (Okta rejects a custom name that differs only by case).
 */
export const USER_BASE_ATTRIBUTES = new Set(
  [
    'login', 'email', 'secondEmail', 'firstName', 'lastName', 'middleName',
    'honorificPrefix', 'honorificSuffix', 'title', 'displayName', 'nickName',
    'profileUrl', 'primaryPhone', 'mobilePhone', 'streetAddress', 'city', 'state',
    'zipCode', 'countryCode', 'postalAddress', 'preferredLanguage', 'locale',
    'timezone', 'userType', 'employeeNumber', 'costCenter', 'organization',
    'division', 'department', 'managerId', 'manager',
  ].map((n) => n.toLowerCase()),
)

/** Okta-defined BASE group profile attributes — immutable and un-removable. */
export const GROUP_BASE_ATTRIBUTES = new Set(['name', 'description'])

// --- Spec extraction shared by deploy / rollback / healthCheck / drift --------

export interface ProfileSchemaSpec {
  sectionName: string
  /** Which schema family — 'user' or 'group'; '' when the value is invalid. */
  schemaType: 'user' | 'group' | ''
  /**
   * For a user schema, the user-type id or 'default'. Always 'default' for a group
   * schema (there is only one group schema). Part of the (schemaType, userTypeId)
   * identity.
   */
  userTypeId: string
  /** Raw JSON string authored on the canvas (for error reporting). */
  attributesJson?: string
  /**
   * Parsed custom-attribute map: name -> attribute definition (object) or `null`
   * (a removal). null when attributesJson is absent or does not parse to an object.
   */
  attributes: Record<string, unknown> | null
}

/**
 * Parse a raw JSON string, returning the object or null when it is not a JSON
 * object (a JSON array or primitive counts as invalid). The object's VALUES may be
 * null — that is how a removal is expressed — but the top level must be an object.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
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

/** The immutable base-attribute name set for a schema type (empty for unknown). */
export function baseAttributesFor(schemaType: string): Set<string> {
  if (schemaType === 'user') return USER_BASE_ATTRIBUTES
  if (schemaType === 'group') return GROUP_BASE_ATTRIBUTES
  return new Set()
}

/** Each canvas item describes the custom attributes of one profile schema. */
export function extractProfileSchemaSpecs(canvas: CanvasSnapshot): ProfileSchemaSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}

    const rawType = typeof fields.schemaType === 'string' ? fields.schemaType.trim() : ''
    const schemaType: ProfileSchemaSpec['schemaType'] =
      rawType === 'user' || rawType === 'group' ? rawType : ''

    // Group schema is always 'default'; user schema defaults to 'default' when blank.
    const rawTypeId = typeof fields.userTypeId === 'string' ? fields.userTypeId.trim() : ''
    const userTypeId = schemaType === 'group' ? 'default' : rawTypeId || 'default'

    const attributesJson =
      typeof fields.attributesJson === 'string' && fields.attributesJson.trim()
        ? fields.attributesJson.trim()
        : undefined

    return {
      sectionName: section.name,
      schemaType,
      userTypeId,
      attributesJson,
      attributes: attributesJson ? parseJsonObject(attributesJson) : null,
    }
  })
}

// --- Validate handler ---------------------------------------------------------

/**
 * Validate profile-schema configurations. Static only — NO network:
 *   - schemaType is required and one of 'user' | 'group'
 *   - attributesJson is required and parses to a JSON OBJECT of at least one
 *     custom attribute (name -> definition, or name -> null for a removal)
 *   - a custom attribute name may not collide (case-insensitively) with an
 *     immutable BASE attribute — this surfaces the immutable-field rule up front
 *   - each non-null attribute is an object whose `type` (if present) is a valid
 *     Okta attribute type; a missing `title` is warned (Okta requires one)
 *   - the (schemaType, userTypeId) PAIR — the schema's identity — is unique
 *
 * The "schema is update-only / must already exist" rule depends on live state, so
 * it is enforced in deploy (a 404 on GET is surfaced clearly).
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections
  if (!sections || sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no configuration sections', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const specs = extractProfileSchemaSpecs(ctx.canvas)
  const seenPairs = new Set<string>()

  for (const spec of specs) {
    const prefix = spec.sectionName

    // schemaType — required, one of user | group
    if (!spec.schemaType) {
      errors.push({
        field: `${prefix}.schemaType`,
        message: 'Schema type is required and must be "user" or "group"',
        code: 'invalid_schema_type',
      })
    }

    // attributesJson — required, parses to a non-empty object of custom attributes
    if (!spec.attributesJson) {
      errors.push({
        field: `${prefix}.attributesJson`,
        message:
          'At least one custom attribute is required — a JSON object of name -> definition (or name -> null to remove)',
        code: 'required',
      })
    } else if (spec.attributes === null) {
      errors.push({
        field: `${prefix}.attributesJson`,
        message:
          'Attributes must be a JSON OBJECT keyed by custom attribute name, e.g. {"badgeId":{"title":"Badge ID","type":"string"}}',
        code: 'invalid_attributes',
      })
    } else {
      const names = Object.keys(spec.attributes)
      if (names.length === 0) {
        errors.push({
          field: `${prefix}.attributesJson`,
          message: 'Declare at least one custom attribute',
          code: 'empty_attributes',
        })
      }

      const baseNames = baseAttributesFor(spec.schemaType)
      for (const name of names) {
        // Immutable base-attribute collision (case-insensitive).
        if (baseNames.has(name.toLowerCase())) {
          errors.push({
            field: `${prefix}.attributesJson`,
            message: `"${name}" is an Okta base (#base) profile attribute — base attributes are immutable and cannot be added or overridden as custom attributes. Choose a different name.`,
            code: 'immutable_base_attribute',
          })
          continue
        }

        // Attribute name shape (warning — Okta owns the authoritative rules).
        if (!ATTRIBUTE_NAME_PATTERN.test(name)) {
          warnings.push({
            field: `${prefix}.attributesJson`,
            message: `Custom attribute name "${name}" should start with a letter and contain only letters, digits and underscores — Okta may reject it at deploy time`,
            code: 'suspicious_attribute_name',
          })
        }

        const def = spec.attributes[name]
        if (def === null) continue // an explicit removal

        if (typeof def !== 'object' || Array.isArray(def)) {
          errors.push({
            field: `${prefix}.attributesJson`,
            message: `Attribute "${name}" must be an object of attribute properties (title, type, ...) or null to remove it`,
            code: 'invalid_attribute',
          })
          continue
        }

        const attr = def as Record<string, unknown>
        if (attr.type !== undefined && !(typeof attr.type === 'string' && ATTRIBUTE_TYPES.has(attr.type))) {
          errors.push({
            field: `${prefix}.attributesJson`,
            message: `Attribute "${name}".type must be one of ${[...ATTRIBUTE_TYPES].join(', ')} (got "${String(attr.type)}")`,
            code: 'invalid_attribute_type',
          })
        }
        if (typeof attr.title !== 'string' || !attr.title.trim()) {
          warnings.push({
            field: `${prefix}.attributesJson`,
            message: `Attribute "${name}" has no "title" — Okta requires a non-empty display title for a custom attribute and will reject it at deploy time`,
            code: 'missing_attribute_title',
          })
        }
      }
    }

    // (schemaType, userTypeId) PAIR is the schema's logical identity — dedupe on it.
    if (spec.schemaType) {
      const key = JSON.stringify([spec.schemaType, spec.userTypeId])
      if (seenPairs.has(key)) {
        const which = spec.schemaType === 'group' ? 'the group schema' : `user schema "${spec.userTypeId}"`
        errors.push({
          field: `${prefix}.schemaType`,
          message: `Duplicate configuration for ${which} — each (schemaType, userTypeId) may only be declared once per canvas`,
          code: 'duplicate_schema',
        })
      }
      seenPairs.add(key)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
