import React from 'react'
import { Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

/**
 * Step-by-step connection guide for the Prisma Cloud app, rendered with the
 * platform design-system components from @veltrixsecops/app-sdk/ui — the same
 * Tabs / Card the built-in platform screens use, themed to the app's brand
 * color. Prisma Cloud authenticates with an access key.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'accesskey',
      label: '1. Access key',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Prisma Cloud console, go to <strong>Settings &gt; Access Control &gt; Access
              Keys</strong> and create an access key (ideally for a service account with a role that
              can manage compliance standards). Copy the <strong>Access Key ID</strong> and{' '}
              <strong>Secret Key</strong>.
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
            <p>Store the access key as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the Access Key ID
              </li>
              <li>
                <strong>Password</strong> → the Secret Key
              </li>
            </ul>
            <p>
              The app logs in (<code>POST /login</code>) to obtain a short-lived JWT and sends it as
              the <code>x-redlock-auth</code> header, re-logging in automatically when it expires.
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
              Set the app's <strong>API URL</strong> setting to your tenant's API host (e.g.{' '}
              <code>https://api.prismacloud.io</code>; regions differ — <code>api2</code>,{' '}
              <code>api.eu</code>, etc.). Then on the <strong>Connections</strong> page create a{' '}
              <strong>prisma-cloud</strong> connection, attach the credential, and{' '}
              <strong>Test</strong> it.
            </p>
            <p>
              Author a configuration in the Configuration Canvas and deploy it. Custom compliance
              standards are matched by name; built-in standards are never modified.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
