import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const RunsPage = React.lazy(() => import('./pages/RunsPage'))
const ConnectionsPage = React.lazy(() => import('./pages/ConnectionsPage'))

export default {
  id: 'cloud-governance',
  pages: { OverviewPage, RunsPage, ConnectionsPage },
  sidebarItems: [
    { path: '/apps/cloud-governance/overview', label: 'Overview', icon: 'shield' },
    { path: '/apps/cloud-governance/runs', label: 'Runs', icon: 'activity' },
    { path: '/apps/cloud-governance/connections', label: 'Accounts', icon: 'link' },
  ],
}
