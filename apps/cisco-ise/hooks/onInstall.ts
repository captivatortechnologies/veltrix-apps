import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook — no seed data required for v0.1.0. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Cisco ISE] install hook for app "${appId}"`)
  console.log(
    '[Cisco ISE] No seeding required. Next steps: enable ERS on the PAN/admin node ' +
      '(Administration > System > Settings > API Settings > ERS Settings), create an ' +
      'ISE administrator in the ERS-Admin (or ERS-Operator for read-only) group, store its ' +
      'username/password as a credential, and register that node as a connection.',
  )
}
