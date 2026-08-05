import type { DriftContext, DriftDiff, DriftResult } from '@veltrixsecops/app-sdk'
import { buildVaultClient } from '../../lib/vault'
import { getTransitKey } from './deploy'
import { extractTransitKeySpecs, keyKey, parseDurationSeconds } from './validate'

/**
 * Detect drift between the deployed transit key configuration and the live
 * cluster. Re-reads each key from GET {mount}/keys/{name} — never its `keys`
 * version map, which carries only creation timestamps, and never any key
 * material (Vault does not return it).
 *
 *   - type                     → critical AND UNFIXABLE: immutable once
 *                                created: a mismatch means the key was
 *                                recreated out-of-band with different material.
 *   - deletion_allowed / the
 *     two version bounds /
 *     auto_rotate_period       → warning (converges on the next deploy)
 *   - exportable /
 *     allow_plaintext_backup   → CRITICAL AND UNFIXABLE only when the canvas
 *                                wants `false` but the live key is already
 *                                `true` — Vault does not allow reverting these
 *                                write-once flags. A live `false` that the
 *                                canvas wants `true` is an ordinary warning
 *                                (it converges on redeploy).
 */
export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const diffs: DriftDiff[] = []

  const built = buildVaultClient(ctx.component.hostname, ctx.credential, ctx.settings)
  if ('error' in built) {
    // Without credentials there is nothing to compare against.
    return { hasDrift: false, diffs: [] }
  }
  const { client } = built

  const specs = extractTransitKeySpecs(ctx.deployedConfig).filter((s) => s.mount && s.name && s.type)

  for (const spec of specs) {
    const key = keyKey(spec.mount, spec.name)
    try {
      const live = await getTransitKey(client, spec.mount, spec.name)

      if (!live) {
        diffs.push({ field: key, expected: 'present', actual: 'missing', severity: 'critical' })
        continue
      }

      const liveType = (live.type ?? '').toLowerCase()
      if (liveType !== spec.type) {
        diffs.push({
          field: `${key}.type`,
          expected: `${spec.type} (immutable — a mismatch means the key was recreated with different material)`,
          actual: liveType || 'unknown',
          severity: 'critical',
        })
      }

      // exportable / allow_plaintext_backup — write-once; only a false-live vs
      // true-desired mismatch is fixable (a warning). true-live vs false-desired
      // cannot be fixed by a redeploy and is flagged critical.
      compareWriteOnceFlag(diffs, `${key}.exportable`, spec.exportable, live.exportable === true)
      compareWriteOnceFlag(diffs, `${key}.allowPlaintextBackup`, spec.allowPlaintextBackup, live.allow_plaintext_backup === true)

      if (spec.deletionAllowed !== (live.deletion_allowed === true)) {
        diffs.push({
          field: `${key}.deletionAllowed`,
          expected: String(spec.deletionAllowed),
          actual: String(live.deletion_allowed === true),
          severity: 'warning',
        })
      }
      compareVersion(diffs, `${key}.minDecryptionVersion`, spec.minDecryptionVersion, live.min_decryption_version)
      compareVersion(diffs, `${key}.minEncryptionVersion`, spec.minEncryptionVersion, live.min_encryption_version)

      if (spec.autoRotatePeriod !== undefined) {
        const expected = parseDurationSeconds(spec.autoRotatePeriod)
        const actual = typeof live.auto_rotate_period === 'number' ? live.auto_rotate_period : undefined
        if (expected !== undefined && expected !== actual) {
          diffs.push({
            field: `${key}.autoRotatePeriod`,
            expected: `${spec.autoRotatePeriod} (${expected}s)`,
            actual: actual !== undefined ? `${actual}s` : 'not set',
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

/** Compare a write-once boolean: false-desired-vs-true-live is unfixable (critical). */
function compareWriteOnceFlag(diffs: DriftDiff[], field: string, expected: boolean, actual: boolean): void {
  if (expected === actual) return
  if (expected === false && actual === true) {
    diffs.push({
      field,
      expected: 'false (UNFIXABLE — this flag is write-once in Vault and cannot be reverted once true)',
      actual: 'true',
      severity: 'critical',
    })
  } else {
    diffs.push({ field, expected: String(expected), actual: String(actual), severity: 'warning' })
  }
}

/** Compare an optional numeric version bound, only when the canvas manages it. */
function compareVersion(diffs: DriftDiff[], field: string, expected: number | undefined, actual: number | undefined): void {
  if (expected === undefined) return
  if (expected !== actual) {
    diffs.push({ field, expected: String(expected), actual: actual !== undefined ? String(actual) : 'not set', severity: 'warning' })
  }
}
