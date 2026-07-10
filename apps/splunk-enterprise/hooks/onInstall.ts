import { PrismaClient } from '@prisma/client'

interface HookContext {
  db: PrismaClient
  appId: string
}

/**
 * Install hook for Splunk Enterprise app.
 * Seeds default Splunk versions and creates default settings.
 */
export default async function onInstall({ db, appId }: HookContext): Promise<void> {
  console.log(`[Splunk Enterprise] Running install hook for app "${appId}"`)

  // Seed default Splunk versions if none exist
  const existingVersions = await db.splunkVersion.count()
  if (existingVersions === 0) {
    const versions = [
      { version: '9.4.0', releaseDate: new Date('2025-01-15'), isActive: true, isLatest: true, releaseNotes: 'Latest stable release', features: ['Federated search improvements', 'Enhanced dashboards'] },
      { version: '9.3.2', releaseDate: new Date('2024-11-01'), isActive: true, isLatest: false, releaseNotes: 'Maintenance release', features: ['Bug fixes', 'Security patches'] },
      { version: '9.3.1', releaseDate: new Date('2024-09-15'), isActive: true, isLatest: false, releaseNotes: 'Point release', features: ['Performance improvements'] },
      { version: '9.2.0', releaseDate: new Date('2024-06-01'), isActive: true, isLatest: false, releaseNotes: 'Feature release', features: ['SmartStore enhancements', 'Workload management'] },
      { version: '9.1.0', releaseDate: new Date('2024-01-15'), isActive: false, isLatest: false, releaseNotes: 'End of support approaching', features: ['Initial workload management'] },
    ]

    for (const v of versions) {
      await db.splunkVersion.upsert({
        where: { version: v.version },
        create: v,
        update: {},
      })
    }

    console.log(`[Splunk Enterprise] Seeded ${versions.length} Splunk versions`)
  }
}
