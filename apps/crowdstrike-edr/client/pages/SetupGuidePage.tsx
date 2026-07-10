import React from 'react'

/**
 * Step-by-step connection guide: Falcon API client, tenant component,
 * and credential conventions this app relies on.
 */
export default function SetupGuidePage() {
  return (
    <div>
      <h2>CrowdStrike Falcon — Setup Guide</h2>

      <h3>1. Create a Falcon API client</h3>
      <p>
        In the Falcon console (requires the <em>Falcon Administrator</em> role), go to{' '}
        <strong>Support and resources &gt; Resources and tools &gt; API clients and keys</strong>{' '}
        and create an API client with these scopes:
      </p>
      <ul>
        <li>
          <strong>Host groups</strong> — Read &amp; Write
        </li>
        <li>
          <strong>Prevention policies</strong> — Read &amp; Write
        </li>
        <li>
          <strong>IOC Management</strong> — Read &amp; Write
        </li>
      </ul>
      <p>Copy the client secret immediately — it is shown only once.</p>

      <h3>2. Register a Falcon tenant component</h3>
      <p>
        Add a component of type <code>falcon-tenant</code>. Set its hostname to your Falcon cloud
        region — <code>us-1</code>, <code>us-2</code>, <code>eu-1</code>, <code>us-gov-1</code>, or{' '}
        <code>us-gov-2</code> — or the API hostname (e.g.{' '}
        <code>api.us-2.crowdstrike.com</code>). Commercial clouds are auto-discovered if unsure;
        GovCloud tenants must set the region explicitly.
      </p>

      <h3>3. Store the API credential</h3>
      <p>
        Create a credential attached to the component's tool: put the API{' '}
        <strong>client ID</strong> in the <em>username</em> field and the{' '}
        <strong>client secret</strong> in the <em>API token</em> field.
      </p>

      <h3>4. Author and deploy</h3>
      <p>
        Create a configuration in the Configuration Canvas (host groups, prevention policies, or
        custom IOCs) and run it through the pipeline. Validation, health checks, drift detection,
        and rollback are handled per configuration type.
      </p>
    </div>
  )
}
