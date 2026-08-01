import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: PagerDuty is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[PagerDuty] Running install hook for app "${appId}"`)
  console.log(
    '[PagerDuty] No seeding required. Next steps: create a REST API key in the PagerDuty web app ' +
      '(Integrations > API Access Keys) and store it in a credential\'s "API key" field; register a ' +
      '"pagerduty-account" component for your PagerDuty account and attach the credential. The app ' +
      'reaches the fixed https://api.pagerduty.com base with "Authorization: Token token=<key>".',
  )
}
