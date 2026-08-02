import React from 'react'
import { Badge, Card, CardBody, Tabs } from '@veltrixsecops/app-sdk/ui'

const MANAGES = ['Scripts', 'Categories', 'Smart Computer Groups', 'Policies']

/**
 * Step-by-step connection guide, rendered with the platform design-system
 * components from @veltrixsecops/app-sdk/ui — the same Tabs / Card / Badge the
 * built-in platform screens use, themed to the app's brand color.
 */
export default function SetupGuidePage() {
  const tabs = [
    {
      key: 'api-account',
      label: '1. API-only account',
      content: (
        <Card variant="bordered" padding="md">
          <CardBody>
            <p>
              In Jamf Pro, go to <strong>Settings &gt; System &gt; User Accounts &amp; Groups</strong> and
              create a new account with <strong>Access Level: Full Access</strong> (or scoped to a Site) and{' '}
              <strong>Privilege Set: Custom</strong>. Grant the privileges this app manages:
            </p>
            <div>
              {MANAGES.map((scope) => (
                <Badge key={scope} variant="primary" size="sm">
                  {scope}
                </Badge>
              ))}
            </div>
            <p>
              Specifically, grant <strong>Read</strong>, <strong>Create</strong>, <strong>Update</strong> and{' '}
              <strong>Delete</strong> under <strong>Jamf Pro Server Objects &gt; Scripts</strong>,{' '}
              <strong>Categories</strong>, <strong>Smart Computer Groups</strong> and <strong>Policies</strong>{' '}
              (add <strong>Read</strong> on <strong>Packages</strong> too, if any policy deploys one — package
              binaries themselves are not managed by this app). Set the account type to{' '}
              <strong>API Only</strong> — it authenticates via username/password, exchanged for a short-lived
              Bearer token, and never signs in to the Jamf Pro console.
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
            <p>Store the API-only account as a Veltrix credential:</p>
            <ul>
              <li>
                <strong>Username</strong> → the API-only account's username
              </li>
              <li>
                <strong>Password</strong> → the API-only account's password
              </li>
            </ul>
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
              Register a <strong>jamf-pro-server</strong> component whose hostname is your Jamf Pro server —
              e.g. <code>yourcompany.jamfcloud.com</code> for Jamf Cloud, or your on-prem FQDN — and attach the
              credential. All requests go to <code>https://&lt;host&gt;/api</code>.
            </p>
            <p>
              For an on-prem install on a non-default HTTPS port (e.g. Tomcat on <code>:8443</code>), set the
              component's port accordingly — it is included in every request URL.
            </p>
          </CardBody>
        </Card>
      ),
    },
  ]

  return <Tabs tabs={tabs} />
}
