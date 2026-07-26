import React from 'react'
import { ConnectionsManager } from '@veltrixsecops/app-sdk/connections'

/**
 * Prisma Cloud — Connections. Thin wrapper over the shared SDK
 * <ConnectionsManager>. Prisma Cloud authenticates with an access key: the
 * Access Key ID goes in the username field and the Secret Key in the secret
 * field. Saving a connection also registers the prisma-cloud deploy target. The
 * tenant API URL is set in the app's API URL setting.
 */
export default function ConnectionsPage() {
  return (
    <ConnectionsManager
      appName="Prisma Cloud"
      appId="prisma-cloud"
      usernameLabel="Access Key ID"
      usernameOptionalForToken={false}
      tokenLabel="Secret Key"
      tokenUsernamePlaceholder="Prisma Cloud Access Key ID"
      endpointPlaceholder="https://api.prismacloud.io"
      endpointHelper="Informational only — set the tenant API URL in the app's API URL setting."
      componentType="prisma-cloud"
    />
  )
}
