import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Domains', 'Mail routing', 'Safe senders', 'Blocked senders']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'admin',
      label: '1. Admin account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              You need a Proofpoint Essentials <strong>Organization Admin</strong> or{' '}
              <strong>Channel Admin</strong> account that is <strong>not</strong> marked read-only.
              Its email and password authenticate every API call (sent as the{' '}
              <code>X-User</code> / <code>X-Password</code> headers) and drive:
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
            <p>Store the admin credentials as a Veltrix connection (Username &amp; password auth):</p>
            <ul>
              <li>
                <strong>Admin email</strong> (Username) → the admin's full email address
              </li>
              <li>
                <strong>Password</strong> → the admin account password
              </li>
              <li>
                <strong>Endpoint</strong> → your Essentials stack host, e.g.{' '}
                <code>us1.proofpointessentials.com</code>
              </li>
            </ul>
          </CardBody>
        </Card>
      ),
    },
    {
      key: 'component',
      label: '3. Component & org',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              Register a <strong>proofpoint</strong> component whose hostname is your Essentials stack
              host (<code>us1.proofpointessentials.com</code>, or <code>us2…us5</code> /{' '}
              <code>eu1</code>) and attach the credential.
            </p>
            <p>
              Set the <strong>Organization (primary domain)</strong> app setting to the primary domain
              of the organization this configuration manages (e.g. <code>acme.com</code>). All domain
              and sender-list changes are applied to <code>/orgs/&lt;that-domain&gt;</code>.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
