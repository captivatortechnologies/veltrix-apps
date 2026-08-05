import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Sign-on policies',
  'Password policies',
  'Populations',
  'Groups',
  'Applications',
  'Resources & scopes',
  'Identity providers',
  'MFA device policies',
  'Risk policies',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'worker',
      label: '1. Worker application',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the PingOne admin console, go to <strong>Applications &gt; Applications</strong>, click{' '}
              <strong>+ Add Application</strong>, and choose <strong>Worker</strong>. Grant it a role
              scoped to what this app manages (e.g. <strong>Environment Admin</strong>, or a narrower
              custom admin role):
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the worker application's <strong>Client ID</strong> and <strong>Client Secret</strong> -
              the secret is shown once.
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
            <p>Store the worker application's credentials as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> - the worker application's Client ID
              </li>
              <li>
                <strong>API token</strong> - the worker application's Client Secret
              </li>
            </ul>
            <p>
              The app exchanges these for a short-lived access token via the OAuth2{' '}
              <code>client_credentials</code> grant on every deploy.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>pingone-environment</strong> component whose hostname is your PingOne{' '}
              <strong>Environment ID</strong> (find it under Environments &gt; your environment &gt;{' '}
              <strong>Properties</strong>), attach the credential, and set the app's{' '}
              <strong>PingOne Region</strong> setting to match your environment's data-residency region
              (North America / EU / Canada / Asia-Pacific / Australia / Singapore) - it does not
              auto-detect.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Note: PingOne protects some built-in objects (the default population, the
              built-in openid and PingOne API resources, worker applications) - the app never touches
              them.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
