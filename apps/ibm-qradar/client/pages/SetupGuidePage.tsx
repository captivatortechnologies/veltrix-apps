import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const ELEMENT_TYPES = ['ALN', 'ALNIC', 'IP', 'NUM', 'PORT', 'DATE']

/**
 * Step-by-step connection guide for the IBM QRadar app, rendered with the
 * platform design-system components from @veltrixsecops/app-sdk/ui — the same
 * Tabs / Card / Badge the built-in platform screens use, themed to the app's
 * brand color. QRadar authenticates with an authorized-service token.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'token',
      label: '1. Authorized service',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In QRadar, go to <strong>Admin &gt; Authorized Services</strong> and create a service
              with a role that has <strong>reference-data (admin)</strong> permission. Copy its{' '}
              <strong>token</strong>.
            </p>
            <p>This app manages reference sets of these element types:</p>
            <div>
              {ELEMENT_TYPES.map((t) => (
                <Badge key={t} variant="primary" size="sm">
                  {t}
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
            <p>Store the token as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Password</strong> → the authorized-service token
              </li>
            </ul>
            <p>
              The app sends it in the <code>SEC</code> header on every request, along with a{' '}
              <code>Version</code> header pinning the API version.
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
            <p>Set the app's settings:</p>
            <ul>
              <li>
                <strong>Console Host</strong> → your QRadar console (e.g.{' '}
                <code>qradar.example.com</code>). It must present a certificate the platform trusts.
              </li>
              <li>
                <strong>API Version</strong> → the QRadar API version to pin (default{' '}
                <code>20.0</code>; lower it for older appliances).
              </li>
            </ul>
            <p>
              Then on the <strong>Connections</strong> page create an <strong>ibm-qradar</strong>{' '}
              connection, attach the credential, and <strong>Test</strong> it. Author a configuration
              in the Configuration Canvas and deploy it — reference sets are matched by name and their
              values reconciled to exactly the declared list; the element type is immutable.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
