import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getPlugin } from './deploy'
import { extractPluginSpecs, parseStringArray, pluginKey } from './validate'

/**
 * Detect drift between the deployed plugin catalog configuration and the live
 * cluster. Re-reads each entry from GET /sys/plugins/catalog/{type}/{name} and
 * diffs ONLY the authored, readable fields:
 *
 *   - sha256   → warning (the staged binary was re-registered with a new digest)
 *   - command  → warning
 *   - args     → warning (compared as an ordered list)
 *   - version  → warning
 *
 * EXCLUDED from drift:
 *   - env      → Vault never returns it on GET (it may hold secrets), so it is
 *                non-driftable — there is nothing to compare against.
 *   - builtin  → a live-only property, not an authored field.
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractPluginSpecs(ctx.deployedConfig).filter((s) => s.type && s.name)

  for (const spec of specs) {
    const key = pluginKey(spec.type, spec.name)
    try {
      const live = await getPlugin(client, spec.type, spec.name)

      if (!live) {
        diffs.push({ field: key, expected: 'registered', actual: 'missing', severity: 'critical' })
        continue
      }

      // sha256 — the registered digest of the staged binary.
      const liveSha = typeof live.sha256 === 'string' ? live.sha256.toLowerCase() : ''
      if (spec.sha256 && spec.sha256 !== liveSha) {
        diffs.push({ field: `${key}.sha256`, expected: spec.sha256, actual: liveSha || 'not set', severity: 'warning' })
      }

      // command — the executable path relative to plugin_directory.
      const liveCommand = typeof live.command === 'string' ? live.command : ''
      if (spec.command && spec.command !== liveCommand) {
        diffs.push({ field: `${key}.command`, expected: spec.command, actual: liveCommand || 'not set', severity: 'warning' })
      }

      // args — compared as an ordered list (argument order is significant).
      const expectedArgs = spec.argsJson ? parseStringArray(spec.argsJson) ?? [] : []
      const liveArgs = Array.isArray(live.args) ? live.args : []
      if (JSON.stringify(expectedArgs) !== JSON.stringify(liveArgs)) {
        diffs.push({
          field: `${key}.args`,
          expected: JSON.stringify(expectedArgs),
          actual: JSON.stringify(liveArgs),
          severity: 'warning',
        })
      }

      // version — only compared when the canvas manages it.
      if (spec.version !== undefined) {
        const liveVersion = typeof live.version === 'string' ? live.version : ''
        if (spec.version !== liveVersion) {
          diffs.push({
            field: `${key}.version`,
            expected: spec.version,
            actual: liveVersion || 'not set',
            severity: 'warning',
          })
        }
      }
    } catch (error) {
      diffs.push({
        field: key,
        expected: 'reachable',
        actual: `unreachable: ${error instanceof Error ? error.message : 'unknown'}`,
        severity: 'critical',
      })
    }
  }

  return { hasDrift: diffs.length > 0, diffs }
}
