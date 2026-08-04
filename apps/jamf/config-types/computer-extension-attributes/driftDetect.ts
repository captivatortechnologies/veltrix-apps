import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildJamfClient } from '../../lib/jamfApi'
import { listExtensionAttributes } from './deploy'
import { extensionAttributeKey, extractExtensionAttributeSpecs, indexExtensionAttributesByName } from './validate'

/**
 * Detect drift between the deployed extension-attribute configuration and
 * the live Jamf Pro tenant. A missing attribute is critical drift; a changed
 * managed field (including input-type-specific ones: scriptContents,
 * popupMenuChoices, ldapAttributeMapping) is a warning.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildJamfClient(ctx.component, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractExtensionAttributeSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listExtensionAttributes(client, ctx.settings)
    const byName = indexExtensionAttributesByName(live)

    for (const spec of specs) {
      const label = spec.name
      const found = byName.get(extensionAttributeKey(spec.name))
      if (!found) {
        diffs.push({ field: label, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      diffField(diffs, label, 'description', spec.description, found.description ?? '')
      diffField(diffs, label, 'data_type', spec.dataType, found.dataType ?? '')
      diffField(diffs, label, 'input_type', spec.inputType, found.inputType ?? '')
      diffField(diffs, label, 'inventory_display_type', spec.inventoryDisplayType, found.inventoryDisplayType ?? '')
      diffBool(diffs, label, 'enabled', spec.enabled, found.enabled ?? true)

      if (spec.inputType === 'SCRIPT' || found.inputType === 'SCRIPT') {
        diffField(diffs, label, 'script_contents', spec.scriptContents, found.scriptContents ?? '')
      }
      if (spec.inputType === 'POPUP' || found.inputType === 'POPUP') {
        if (!sameStringSet(spec.popupMenuChoices, found.popupMenuChoices ?? [])) {
          diffs.push({
            field: `${label}.popup_menu_choices`,
            expected: spec.popupMenuChoices.join(', ') || '(none)',
            actual: (found.popupMenuChoices ?? []).join(', ') || '(none)',
            severity: 'warning',
          })
        }
      }
      if (spec.inputType === 'DIRECTORY_SERVICE_ATTRIBUTE_MAPPING' || found.inputType === 'DIRECTORY_SERVICE_ATTRIBUTE_MAPPING') {
        diffField(diffs, label, 'ldap_attribute_mapping', spec.ldapAttributeMapping, found.ldapAttributeMapping ?? '')
        diffBool(diffs, label, 'ldap_extension_attribute_allowed', spec.ldapExtensionAttributeAllowed, found.ldapExtensionAttributeAllowed ?? false)
      }
    }
  } catch (error) {
    diffs.push({
      field: 'jamf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}

function diffField(diffs: DriftDiff[], label: string, field: string, expected: string, actual: string): void {
  if (expected === actual) return
  diffs.push({ field: `${label}.${field}`, expected: expected || '(empty)', actual: actual || '(empty)', severity: 'warning' })
}

function diffBool(diffs: DriftDiff[], label: string, field: string, expected: boolean, actual: boolean): void {
  if (expected === actual) return
  diffs.push({ field: `${label}.${field}`, expected, actual, severity: 'warning' })
}

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a.map((s) => s.toLowerCase()))
  return b.every((s) => setA.has(s.toLowerCase()))
}
