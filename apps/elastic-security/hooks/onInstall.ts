import type { AppHookContext } from '@veltrixsecops/app-sdk'

/** Install hook: Elastic Security is a pure passthrough — no seeding, no tables. */
export default async function onInstall({ appId }: AppHookContext): Promise<void> {
  console.log(`[Elastic Security] Running install hook for app "${appId}"`)
  console.log(
    '[Elastic Security] No seeding required. Next steps: register an "elastic-deployment" component ' +
      'whose hostname is the Kibana base URL (e.g. https://<deployment>.kb.<region>.cloud.es.io:9243), ' +
      'set the "Elasticsearch URL" app setting for ILM/role-mapping management, and store an Elastic ' +
      'API key (base64 id:api_key) in a credential\'s "API token" field.',
  )
}
