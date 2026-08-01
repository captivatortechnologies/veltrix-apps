import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Semgrep is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Semgrep] Running install hook for app "${appId}"`)
  console.log(
    '[Semgrep] No seeding required. Next steps: register a "semgrep-deployment" component, store a ' +
      'Semgrep API token (Settings > Tokens in the AppSec Platform) as a credential, and set the ' +
      '"Deployment Slug" app setting (find it at GET /api/v1/deployments).',
  )
}
