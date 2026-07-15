import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Okta is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Okta] Running install hook for app "${appId}"`)
  console.log(
    '[Okta] No seeding required. Next steps: register an "okta-org" component whose hostname is the ' +
      'Okta org domain (e.g. dev-12345.okta.com), and store an Okta API token (SSWS) in a credential\'s ' +
      '"API token" field (Okta Admin > Security > API > Tokens).',
  )
}
