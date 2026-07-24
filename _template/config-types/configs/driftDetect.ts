// =============================================================================
// DRIFT DETECT HANDLER
//
// Called on a schedule to compare live configuration vs what was deployed.
// This is the enforcement mechanism for Security-as-Code:
// if someone SSHs in and edits a config file manually, we detect it.
//
// Compare ctx.deployedConfig (what the pipeline deployed) with what's
// actually running on ctx.component.
//
// Return { hasDrift: false } if everything matches.
// Return { hasDrift: true, diffs: [...] } with specific differences.
//
// CONTENT DRIFT (proven by the Splunk app): to catch a manual edit of a file
// the deploy shipped, compare the SHA-256 of each shipped file against the live
// one — over managed ZTNA use `ctx.remote.hashTree()` / `ctx.remote.readFile()`;
// over an API fetch the effective content. For structured files (`.conf`, JSON),
// compare KEY BY KEY on the keys you shipped and IGNORE extra keys the tool adds
// on its own (e.g. an install checksum) — a whole-file hash false-alarms on that
// bookkeeping. Report a changed shipped value as a precise per-key diff.
// =============================================================================

import type { DriftContext, DriftResult } from '@veltrixsecops/app-sdk'

export default async function driftDetect(ctx: DriftContext): Promise<DriftResult> {
  const { component, credential, connectivity, deployedConfig } = ctx
  const diffs: DriftResult['diffs'] = []

  // Example: Fetch current config from the tool and compare
  // if (connectivity?.httpsUrl && credential) {
  //   const response = await fetch(`${connectivity.httpsUrl}/api/config`, {
  //     headers: {
  //       'Authorization': `Basic ${Buffer.from(`${credential.username}:${credential.password}`).toString('base64')}`,
  //     },
  //   })
  //
  //   if (response.ok) {
  //     const liveConfig = await response.json()
  //     const expectedConfig = deployedConfig.snapshot
  //
  //     // Compare field by field
  //     for (const [key, expectedValue] of Object.entries(expectedConfig)) {
  //       const actualValue = liveConfig[key]
  //       if (JSON.stringify(actualValue) !== JSON.stringify(expectedValue)) {
  //         diffs.push({
  //           field: key,
  //           expected: expectedValue,
  //           actual: actualValue,
  //           severity: key.includes('password') ? 'critical' : 'warning',
  //         })
  //       }
  //     }
  //   }
  // }

  return {
    hasDrift: diffs.length > 0,
    diffs,
  }
}
