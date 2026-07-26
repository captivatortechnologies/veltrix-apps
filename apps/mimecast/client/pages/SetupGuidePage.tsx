import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

/**
 * Step-by-step connection guide for the Mimecast app, rendered with the platform
 * design-system components from @veltrixsecops/app-sdk/ui — the same Tabs / Card
 * the built-in platform screens use, themed to the app's brand color. Mimecast
 * authenticates with an API 2.0 application (OAuth2 client credentials).
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'app',
      label: '1. API application',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Mimecast Admin Console, register an <strong>API 2.0 application</strong> and
              assign it a role that grants <strong>Services | URL Protection | Edit</strong>. Generate
              its credentials and copy the <strong>Client ID</strong> and <strong>Client Secret</strong>.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'credential',
      label: '2. Credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the application as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Client ID
              </li>
              <li>
                <strong>Password</strong> → the Client Secret
              </li>
            </ul>
            <p>
              The app exchanges these for a short-lived Bearer token via OAuth2 client credentials
              (<code>POST /oauth/token</code>), refreshing it automatically as it expires.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'connect',
      label: '3. Connect',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              On the <strong>Connections</strong> page create a <strong>mimecast</strong> connection
              and attach the credential. Use <strong>Test</strong> to verify the token and role. The
              default base URL is <code>https://api.services.mimecast.com</code> — override it in the
              app's settings only if your tenant uses a different gateway host.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it. Managed URLs are
              matched by their URL identity and applied as delete + recreate, since Mimecast has no
              update API for them.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
