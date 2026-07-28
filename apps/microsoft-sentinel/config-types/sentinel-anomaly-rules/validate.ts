import type { CanvasSnapshot, PipelineContext, ValidationResult } from '@veltrixsecops/app-sdk'
import { isIso8601Duration, slugify } from '../../lib/sentinel'

/** Microsoft.SecurityInsights SettingsStatus enum for anomaly settings. */
export const SETTINGS_STATUSES = ['Production', 'Flighting'] as const
export type SettingsStatus = (typeof SETTINGS_STATUSES)[number]

/** Microsoft.SecurityInsights AttackTactic enum (api-version 2024-09-01). */
export const ATTACK_TACTICS = [
  'Reconnaissance', 'ResourceDevelopment', 'InitialAccess', 'Execution', 'Persistence',
  'PrivilegeEscalation', 'DefenseEvasion', 'CredentialAccess', 'Discovery', 'LateralMovement',
  'Collection', 'Exfiltration', 'CommandAndControl', 'Impact', 'PreAttack',
  'ImpairProcessControl', 'InhibitResponseFunction',
] as const

/** A GUID (settingsDefinitionId is typed uuid by ARM). */
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** One customizable threshold observation ({ name, minimum?, maximum?, value }). */
export interface ThresholdObservation {
  name: string
  minimum?: string
  maximum?: string
  value: string
}

/** One anomaly (ML) analytics setting authored on the canvas. */
export interface AnomalySettingSpec {
  sectionName: string
  name: string
  /** URL-safe ARM securityMLAnalyticsSettings resource name derived from the name. */
  settingsResourceName: string
  description: string
  enabled: boolean
  /** GUID of the built-in anomaly definition being tuned. */
  settingsDefinitionId: string
  settingsStatus: string
  /** ISO-8601 run frequency; defaults to PT1H when the field is blank. */
  frequency: string
  /** anomalyVersion of the built-in definition (ARM-required); defaults to 1.0.0. */
  anomalyVersion: string
  isDefaultSettings: boolean
  tactics: string[]
  techniques: string[]
  /** Parsed customizableObservations object, or null when none / unparseable. */
  customizableObservations: Record<string, unknown> | null
  /** A JSON parse / shape error for customizableObservations, else null. */
  customizableObservationsError: string | null
}

/** The reconciliation key is the slug of the setting name (also the ARM resource name). */
export function anomalyKey(name: string): string {
  return slugify(name)
}

function readBool(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true'
  return fallback
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Read a tags/list field into a trimmed string array (accepts a comma string too). */
export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter((v) => v.length > 0)
  if (typeof value === 'string') return value.split(',').map((v) => v.trim()).filter((v) => v.length > 0)
  return []
}

/**
 * Read the customizableObservations field. Accepts an already-parsed object (the
 * platform may store JSON structurally) or a JSON string from the textarea.
 * NON-UNION result: object is null when empty or on a parse/shape error, and
 * `error` carries the reason. Must be a JSON object, never an array or primitive.
 */
export function readObservations(value: unknown): {
  value: Record<string, unknown> | null
  error: string | null
} {
  if (value == null) return { value: null, error: null }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return { value: null, error: null }
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return { value: null, error: 'must be valid JSON' }
    }
    return coerceObservationsObject(parsed)
  }
  if (typeof value === 'object') return coerceObservationsObject(value)
  return { value: null, error: 'must be a JSON object' }
}

function coerceObservationsObject(parsed: unknown): {
  value: Record<string, unknown> | null
  error: string | null
} {
  if (parsed == null) return { value: null, error: null }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { value: null, error: 'must be a JSON object (not an array or primitive)' }
  }
  return { value: parsed as Record<string, unknown>, error: null }
}

/** The customizableObservations array keys ARM recognises. */
const OBSERVATION_KEYS = [
  'multiSelectObservations',
  'singleSelectObservations',
  'prioritizeExcludeObservations',
  'thresholdObservations',
  'singleValueObservations',
] as const

/** Pull the thresholdObservations out of a parsed customizableObservations object. */
export function thresholdObservationsOf(obs: Record<string, unknown> | null): ThresholdObservation[] {
  if (!obs) return []
  const raw = obs.thresholdObservations
  if (!Array.isArray(raw)) return []
  const out: ThresholdObservation[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    out.push({
      name: readString(e.name),
      minimum: typeof e.minimum === 'string' || typeof e.minimum === 'number' ? String(e.minimum) : undefined,
      maximum: typeof e.maximum === 'string' || typeof e.maximum === 'number' ? String(e.maximum) : undefined,
      value: typeof e.value === 'string' || typeof e.value === 'number' ? String(e.value) : '',
    })
  }
  return out
}

/** Each canvas item is one anomaly (ML) analytics setting. */
export function extractAnomalySpecs(canvas: CanvasSnapshot): AnomalySettingSpec[] {
  return (canvas.sections ?? []).map((section) => {
    const fields = section.fields ?? {}
    const name = readString(fields.name)
    const observations = readObservations(fields.customizable_observations)
    return {
      sectionName: section.name,
      name,
      settingsResourceName: slugify(name),
      description: readString(fields.description),
      enabled: readBool(fields.enabled, true),
      settingsDefinitionId: readString(fields.settings_definition_id),
      settingsStatus: readString(fields.settings_status) || 'Production',
      // Blank frequency / version fall back to the ARM-required defaults so the
      // request body is always complete.
      frequency: readString(fields.frequency) || 'PT1H',
      anomalyVersion: readString(fields.anomaly_version) || '1.0.0',
      isDefaultSettings: readBool(fields.is_default_settings, false),
      tactics: readList(fields.tactics),
      techniques: readList(fields.techniques),
      customizableObservations: observations.value,
      customizableObservationsError: observations.error,
    }
  })
}

/** True when a string is a numeric value (for threshold range checks). */
function asFiniteNumber(value: string | undefined): number | null {
  if (value == null || value.trim() === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * Validate anomaly (ML) analytics settings. Each needs a unique name, a
 * settingsDefinitionId (GUID of the built-in anomaly), a valid settingsStatus,
 * an ISO-8601 frequency, valid MITRE tactics, and — when supplied — a well-formed
 * customizableObservations object whose threshold values sit within their range.
 */
export default async function validate(ctx: PipelineContext): Promise<ValidationResult> {
  const errors: ValidationResult['errors'] = []
  const warnings: ValidationResult['warnings'] = []

  const sections = ctx.canvas.sections ?? []
  if (sections.length === 0) {
    errors.push({ field: 'sections', message: 'Canvas has no anomaly settings', code: 'empty_canvas' })
    return { valid: false, errors, warnings }
  }

  const seen = new Set<string>()

  for (const spec of extractAnomalySpecs(ctx.canvas)) {
    const prefix = spec.sectionName

    if (!spec.name) {
      errors.push({ field: `${prefix}.name`, message: 'Setting name is required', code: 'required' })
    } else {
      const key = anomalyKey(spec.name)
      if (seen.has(key)) {
        errors.push({
          field: `${prefix}.name`,
          message: `Duplicate setting name "${spec.name}" (names must be unique after slugging to "${key}")`,
          code: 'duplicate_setting',
        })
      }
      seen.add(key)
    }

    if (!spec.settingsDefinitionId) {
      errors.push({
        field: `${prefix}.settings_definition_id`,
        message: 'Anomaly definition ID (settingsDefinitionId) is required',
        code: 'required',
      })
    } else if (!GUID_RE.test(spec.settingsDefinitionId)) {
      errors.push({
        field: `${prefix}.settings_definition_id`,
        message: `Anomaly definition ID "${spec.settingsDefinitionId}" must be a GUID`,
        code: 'invalid_guid',
      })
    }

    if (!SETTINGS_STATUSES.includes(spec.settingsStatus as SettingsStatus)) {
      errors.push({
        field: `${prefix}.settings_status`,
        message: `Settings status must be one of ${SETTINGS_STATUSES.join(', ')}`,
        code: 'invalid_status',
      })
    }

    if (!isIso8601Duration(spec.frequency)) {
      errors.push({
        field: `${prefix}.frequency`,
        message: `Frequency "${spec.frequency}" must be an ISO-8601 duration (e.g. PT1H, P1D)`,
        code: 'invalid_duration',
      })
    }

    if (!spec.anomalyVersion) {
      errors.push({ field: `${prefix}.anomaly_version`, message: 'Anomaly version is required', code: 'required' })
    }

    for (const tactic of spec.tactics) {
      if (!ATTACK_TACTICS.includes(tactic as (typeof ATTACK_TACTICS)[number])) {
        errors.push({
          field: `${prefix}.tactics`,
          message: `Invalid MITRE tactic "${tactic}" — must be a Microsoft.SecurityInsights AttackTactic value`,
          code: 'invalid_tactic',
        })
      }
    }

    if (spec.customizableObservationsError) {
      errors.push({
        field: `${prefix}.customizable_observations`,
        message: `Customizable observations ${spec.customizableObservationsError}`,
        code: 'invalid_json',
      })
    } else if (spec.customizableObservations) {
      for (const key of Object.keys(spec.customizableObservations)) {
        const val = spec.customizableObservations[key]
        if (!OBSERVATION_KEYS.includes(key as (typeof OBSERVATION_KEYS)[number])) {
          warnings.push({
            field: `${prefix}.customizable_observations`,
            message: `Unknown observation group "${key}" — expected one of ${OBSERVATION_KEYS.join(', ')}`,
            code: 'unknown_observation',
          })
        } else if (val !== null && !Array.isArray(val)) {
          errors.push({
            field: `${prefix}.customizable_observations`,
            message: `Observation group "${key}" must be an array or null`,
            code: 'invalid_observation',
          })
        }
      }

      for (const threshold of thresholdObservationsOf(spec.customizableObservations)) {
        if (!threshold.name) {
          errors.push({
            field: `${prefix}.customizable_observations`,
            message: 'Each threshold observation requires a "name"',
            code: 'invalid_threshold',
          })
        }
        const value = asFiniteNumber(threshold.value)
        if (value === null) {
          errors.push({
            field: `${prefix}.customizable_observations`,
            message: `Threshold "${threshold.name || '(unnamed)'}" must have a numeric "value"`,
            code: 'invalid_threshold',
          })
          continue
        }
        const min = asFiniteNumber(threshold.minimum)
        const max = asFiniteNumber(threshold.maximum)
        if ((min !== null && value < min) || (max !== null && value > max)) {
          errors.push({
            field: `${prefix}.customizable_observations`,
            message: `Threshold "${threshold.name}" value ${value} is outside its range [${threshold.minimum ?? '-∞'}, ${threshold.maximum ?? '∞'}]`,
            code: 'threshold_out_of_range',
          })
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}
