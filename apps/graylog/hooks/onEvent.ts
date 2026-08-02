import type { AppEventContext } from '@veltrixsecops/app-sdk'

/** Platform event hook — subscribes to component/credential lifecycle (see manifest.events). */
export default async function onEvent({ topic }: AppEventContext): Promise<void> {
  console.log(`[Graylog] event: ${topic}`)
}
