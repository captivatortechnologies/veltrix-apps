import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = [
  'Auth Methods',
  'Roles',
  'Targets',
  'Dynamic Secret configs',
  'Rotated Secret configs',
  'Event Forwarders',
  'Gateway K8s Auth Config',
  'Gateway Allowed Access',
]

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui - the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'auth-method',
      label: '1. API Key auth method',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In the Akeyless Console, go to <strong>Auth Methods -&gt; New -&gt; API Key</strong> and
              create a dedicated auth method for this app. Associate it with a role (or Akeyless's
              built-in Admin role) that can read and write:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Copy the auth method's <strong>Access ID</strong> and <strong>Access Key</strong> - the
              key is shown once, at creation time.
            </p>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'store',
      label: '2. Store the credential',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>Store the API Key auth method as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> - the auth method's Access ID
              </li>
              <li>
                <strong>API token</strong> - the auth method's Access Key
              </li>
            </ul>
            <p>
              The app exchanges these for a short-lived token via <code>POST /auth</code> and sends that
              token as a <code>token</code> field inside every subsequent request's JSON body (Akeyless
              does not use an Authorization header).
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
              Register an <strong>akeyless-account</strong> component whose hostname is{' '}
              <code>api.akeyless.io</code> (the public SaaS control plane), or a private Akeyless
              Gateway's URL if this account is managed through a self-hosted Gateway, then attach the
              credential.
            </p>
            <p>
              Then author a configuration in the Configuration Canvas and deploy it through the
              pipeline. Note: this app never reads, writes or diffs static, dynamic or rotated secret{' '}
              <em>values</em> - only the declarative objects that define auth, access and how secrets
              are produced or rotated. See the Overview page and this app's README for the full
              Coverage breakdown.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
