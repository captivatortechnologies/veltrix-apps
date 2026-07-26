import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

// Admin API permissions this app needs, granted on the integration.
const PERMISSIONS = ['Grant read information', 'Grant read/write resources']

/**
 * Step-by-step connection guide for the Cisco Duo app, rendered with the
 * platform design-system components from @veltrixsecops/app-sdk/ui — the same
 * Tabs / Card / Badge the built-in platform screens use, themed to the app's
 * brand color. Duo authenticates with an Admin API integration key + secret key.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'integration',
      label: '1. Admin API integration',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Duo Admin Panel, go to <strong>Applications</strong> and protect an{' '}
              <strong>Admin API</strong> application. From its details, copy the{' '}
              <strong>Integration key</strong>, <strong>Secret key</strong> and{' '}
              <strong>API hostname</strong> (<code>api-XXXXXXXX.duosecurity.com</code>).
            </p>
            <p>Grant the integration these permissions:</p>
            <div>
              {PERMISSIONS.map((p) => (
                <Badge key={p} variant="primary" size="sm">
                  {p}
                </Badge>
              ))}
            </div>
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
            <p>Store the integration as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Integration key
              </li>
              <li>
                <strong>Password</strong> → the Secret key
              </li>
            </ul>
            <p>
              The app signs every request with an HMAC-SHA1 signature derived from the secret key —
              the secret key itself is never sent.
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
              Set the app's <strong>API Host</strong> setting to the API hostname, then on the{' '}
              <strong>Connections</strong> page create a <strong>cisco-duo</strong> connection and
              attach the credential. Use <strong>Test</strong> to verify the signed request against
              Duo's <code>/check</code> endpoint.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Groups are matched by name and the Duo <code>group_id</code> is stored after
              deploy so a rename updates the same group.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
