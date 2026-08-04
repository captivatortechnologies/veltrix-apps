// Shared helpers for the Greenbone Scan Configs config type (deploy + rollback
// + drift). A scan config is CLONED from an existing base config (create is
// clone-only — see lib/gmp/scanConfigs.ts) then tuned via modify_config. The
// config NAME is the stable identity used to upsert — gvmd does not enforce
// unique names, so this app treats the name as the key (last one wins).

import type { FamilySelectionInput, NvtSelectionEntry, PreferenceInput, GmpScanConfig, ScanConfigModifyInput } from '../../lib/gmp/scanConfigs'
import { SCAN_CONFIG_FULL_AND_FAST } from '../../lib/gmp/scanConfigs'

export { SCAN_CONFIG_FULL_AND_FAST }

export interface JsonParseResult<T> {
  value: T | null
  error: string | null
}

function parseJson<T>(raw: unknown): JsonParseResult<T> {
  const text = String(raw ?? '').trim()
  if (!text) return { value: null, error: null }
  try {
    return { value: JSON.parse(text) as T, error: null }
  } catch (e) {
    return { value: null, error: e instanceof Error ? e.message : 'Invalid JSON' }
  }
}

export function parseFamilySelectionField(raw: unknown): JsonParseResult<Array<{ name: string; all?: boolean; growing?: boolean }>> {
  const { value, error } = parseJson<Array<{ name: string; all?: boolean; growing?: boolean }>>(raw)
  if (error) return { value: null, error }
  if (value !== null && !Array.isArray(value)) return { value: null, error: 'familySelection must be a JSON array of { name, all?, growing? }' }
  return { value, error: null }
}

export function parseNvtSelectionField(raw: unknown): JsonParseResult<NvtSelectionEntry[]> {
  const { value, error } = parseJson<NvtSelectionEntry[]>(raw)
  if (error) return { value: null, error }
  if (value !== null && !Array.isArray(value)) return { value: null, error: 'nvtSelection must be a JSON array of { family, oids: string[] }' }
  return { value, error: null }
}

export function parsePreferencesField(raw: unknown): JsonParseResult<PreferenceInput[]> {
  const { value, error } = parseJson<PreferenceInput[]>(raw)
  if (error) return { value: null, error }
  if (value !== null && !Array.isArray(value)) return { value: null, error: 'preferences must be a JSON array of { name, nvtOid?, value }' }
  return { value, error: null }
}

export interface ScanConfigItem {
  name: string
  baseConfigId: string
  comment: string
  modify: ScanConfigModifyInput
}

/** Build the scan-config item from a canvas item's fields. Assumes fields already passed validate.ts (JSON parses). */
export function buildScanConfigItem(fields: Record<string, unknown>): ScanConfigItem {
  const name = String(fields.name ?? '').trim()
  const baseConfigId = String(fields.baseConfigId ?? '').trim() || SCAN_CONFIG_FULL_AND_FAST
  const comment = String(fields.comment ?? '').trim()

  const families = parseFamilySelectionField(fields.familySelection).value
  const familySelection: FamilySelectionInput | undefined = families
    ? { growing: fields.familyGrowing === true, families }
    : undefined
  const nvtSelections = parseNvtSelectionField(fields.nvtSelection).value ?? undefined
  const preferences = parsePreferencesField(fields.preferences).value ?? undefined

  return {
    name,
    baseConfigId,
    comment,
    modify: { name, comment, familySelection, nvtSelections, preferences },
  }
}

/** Find a live scan config by name (trimmed, case-sensitive). */
export function findConfigByName(configs: GmpScanConfig[], name: string): GmpScanConfig | null {
  const n = name.trim()
  if (!n) return null
  return configs.find((c) => c.name.trim() === n) ?? null
}
