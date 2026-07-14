import type { AppHookContext } from '@veltrixsecops/app-sdk'
import * as store from '../lib/db'

/**
 * Install hook for Splunk Enterprise app.
 * Seeds the Splunk version catalog used by the BYOL/upgrade features.
 *
 * Catalog data (versions, GA dates, support windows) is sourced from the
 * official Splunk release notes and support policy — see the app README
 * for citations. Last refreshed: July 2026.
 *
 * Notes on the release lines:
 *   - 10.4.x — current release line (GA 2026-05-18, supported to 2028-05-18)
 *   - 10.2.x — previous line (GA 2026-01-15, supported to 2028-01-15)
 *   - 10.0.x — first Splunk 10 line (GA 2025-07-28, supported to 2027-07-28)
 *   - 9.4.x  — last 9.x line still in support (EOS 2026-12-16)
 *   - 9.3.x  — end of support 2026-07-24; seeded inactive for upgrade tracking
 */
export default async function onInstall({ db, appId }: AppHookContext): Promise<void> {
  console.log(`[Splunk Enterprise] Running install hook for app "${appId}"`)

  // Seed default Splunk versions if none exist
  const existingVersions = await store.countVersions(db)
  if (existingVersions === 0) {
    const versions = [
      {
        version: '10.4.1',
        releaseDate: new Date('2026-06-30'),
        isActive: true,
        isLatest: true,
        releaseNotes: 'Latest release (10.4 line, GA 2026-05-18). Supported until 2028-05-18.',
        features: [
          'Config Validation (pre-production configuration checks)',
          'TLS 1.3 and post-quantum cryptography support',
          'HTTP/2 support for Splunk Web',
          'KV Store on MongoDB 8.0',
          'Non-root / non-administrator execution enforcement',
          'Dashboard Studio custom visualizations framework',
        ],
      },
      {
        version: '10.2.4',
        releaseDate: new Date('2026-05-29'),
        isActive: true,
        isLatest: false,
        releaseNotes: '10.2 line (GA 2026-01-15). Supported until 2028-01-15.',
        features: [
          'SPL2 next-generation search language',
          'Field filters enabled by default (sensitive-data redaction)',
          'TLS 1.3 for public-facing connections',
          'Unified agent management (forwarders + OTel collectors)',
          'Edge Processor pipeline health metrics',
        ],
      },
      {
        version: '10.0.7',
        releaseDate: new Date('2026-05-29'),
        isActive: true,
        isLatest: false,
        releaseNotes: 'First Splunk 10 line (GA 2025-07-28). Supported until 2027-07-28.',
        features: [
          'Edge Processor for at-source data filtering',
          'FIPS 140-3 support and mTLS between Splunk instances',
          'OpenSSL 3.0 and Python 3.9 runtime',
          'Fine-grained knowledge object permissions (replaces admin_all_objects patterns)',
          'Dynamic scheduled search concurrency limits',
        ],
      },
      {
        version: '9.4.12',
        releaseDate: new Date('2026-05-29'),
        isActive: true,
        isLatest: false,
        releaseNotes: 'Last supported 9.x line (GA 2024-12-16). End of support 2026-12-16 — plan upgrades to 10.x.',
        features: [
          'Deployment Server centralized agent management',
          'KV Store 7.0 with automatic migration',
          'Federated search for metric indexes',
          'Persistent S2S output queues for zero-data-loss failover',
          'Workload management with cgroups v2',
        ],
      },
      {
        version: '9.3.13',
        releaseDate: new Date('2026-05-29'),
        isActive: false,
        isLatest: false,
        releaseNotes: '9.3 line (GA 2024-07-24) reached end of support on 2026-07-24. Upgrade required.',
        features: ['Ingest actions improvements', 'Dashboard Studio enhancements'],
      },
    ]

    for (const v of versions) {
      await store.insertVersionIfAbsent(db, v)
    }

    console.log(`[Splunk Enterprise] Seeded ${versions.length} Splunk versions`)
  }
}
