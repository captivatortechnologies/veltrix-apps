import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Sites', 'Asset groups', 'Tags', 'Scan templates', 'Credentials', 'Schedules', 'Exceptions']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'account',
      label: '1. Console account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the InsightVM Security Console, create a <strong>service account</strong> (Administration
              &gt; Users) with a role scoped to what this app manages. Prefer a <strong>non-2FA</strong>{' '}
              account for automation — the console API uses HTTP Basic auth:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
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
            <p>Store the console account as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the console username
              </li>
              <li>
                <strong>Password</strong> → the console password
              </li>
            </ul>
            <p>
              The app sends these as <code>Authorization: Basic …</code> to{' '}
              <code>https://&lt;console&gt;:3780/api/3</code>.
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
              Register an <strong>insightvm-console</strong> component whose hostname is your Security
              Console host (e.g. <code>console.example.com:3780</code>) and attach the credential. Port{' '}
              <code>3780</code> is assumed when omitted.
            </p>
            <p>
              The console API is served over HTTPS with a self-signed certificate by default — the
              platform host must trust the console's certificate. For a 2FA account, set the{' '}
              <strong>2FA Token</strong> app setting per run.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
