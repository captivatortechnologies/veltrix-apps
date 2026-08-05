import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildBarracudaClient } from '../../lib/barracudaWaf'
import { extractHeaderRuleSpecs, headerRuleKey, listHeaderRules, type LiveHeaderRule } from './validate'

const BOOL_FIELDS = [
  ['enabled', 'enabled'],
  ['active', 'active'],
  ['block_sql_injection', 'blockSqlInjection'],
  ['block_sql_injection_strict', 'blockSqlInjectionStrict'],
  ['block_os_command_injection', 'blockOsCommandInjection'],
  ['block_os_command_injection_strict', 'blockOsCommandInjectionStrict'],
  ['block_directory_traversal', 'blockDirectoryTraversal'],
  ['block_directory_traversal_strict', 'blockDirectoryTraversalStrict'],
  ['block_cross_site_scripting', 'blockCrossSiteScripting'],
  ['block_cross_site_scripting_strict', 'blockCrossSiteScriptingStrict'],
  ['block_remote_file_inclusion', 'blockRemoteFileInclusion'],
  ['block_remote_file_inclusion_strict', 'blockRemoteFileInclusionStrict'],
  ['block_ldap_injection', 'blockLdapInjection'],
  ['block_python_php_attacks', 'blockPythonPhpAttacks'],
  ['block_http_specific_injection', 'blockHttpSpecificInjection'],
  ['block_apache_struts_attacks', 'blockApacheStrutsAttacks'],
  ['block_apache_struts_attacks_strict', 'blockApacheStrutsAttacksStrict'],
] as const

/**
 * Detect drift between the deployed Header Allow/Deny rules and the live
 * Application: a declared rule missing live is critical; a live rule not
 * declared (this config type owns the full rule list) is drift; field
 * differences — header_name plus every enabled/active/block_* toggle — are
 * warned.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildBarracudaClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    return { hasDrift: false, diffs: [] }
  }
  const { client, appName } = built

  const specs = extractHeaderRuleSpecs(ctx.deployedConfig).filter((s) => s.name)
  if (specs.length === 0) return { hasDrift: false, diffs: [] }

  try {
    const live = await listHeaderRules(client, appName)
    const byKey = new Map<string, LiveHeaderRule>(live.filter((r) => r.name).map((r) => [headerRuleKey(r.name as string), r]))
    const declaredKeys = new Set(specs.map((s) => headerRuleKey(s.name)))

    for (const spec of specs) {
      const found = byKey.get(headerRuleKey(spec.name))
      if (!found) {
        diffs.push({ field: spec.name, expected: 'exists', actual: 'missing', severity: 'critical' })
        continue
      }

      if ((found.header_name ?? '') !== spec.headerName) {
        diffs.push({ field: `${spec.name}.header_name`, expected: spec.headerName, actual: found.header_name ?? '', severity: 'warning' })
      }

      for (const [wireField, specKey] of BOOL_FIELDS) {
        const liveVal = (found as Record<string, unknown>)[wireField]
        const expected = (spec as unknown as Record<string, unknown>)[specKey]
        if ((liveVal ?? false) !== expected) {
          diffs.push({ field: `${spec.name}.${wireField}`, expected, actual: liveVal ?? false, severity: 'warning' })
        }
      }
    }

    for (const rule of live) {
      if (rule.name && !declaredKeys.has(headerRuleKey(rule.name))) {
        diffs.push({ field: rule.name, expected: 'not present (undeclared)', actual: 'present', severity: 'warning' })
      }
    }
  } catch (error) {
    diffs.push({
      field: 'barracuda-waf',
      expected: 'reachable',
      actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
      severity: 'critical',
    })
  }

  return { hasDrift: diffs.length > 0, diffs }
}
