// =============================================================================
// Splunk Enterprise App — Client Entry Point
//
// Registers the app's pages and sidebar items. The platform dynamically
// loads this module when the app is enabled for a customer.
// =============================================================================

import React from 'react'

const OverviewPage = React.lazy(() => import('./pages/OverviewPage'))
const SetupGuidePage = React.lazy(() => import('./pages/SetupGuidePage'))
const InventoryPage = React.lazy(() => import('./pages/InventoryPage'))
const IndexesPage = React.lazy(() => import('./pages/IndexesPage'))
const IndexDefaultsPage = React.lazy(() => import('./pages/IndexDefaultsPage'))
const RolesPage = React.lazy(() => import('./pages/RolesPage'))
const RoleDefaultsPage = React.lazy(() => import('./pages/RoleDefaultsPage'))
const BYOLPage = React.lazy(() => import('./pages/BYOLPage'))
const VersionsPage = React.lazy(() => import('./pages/VersionsPage'))

export default {
  id: 'splunk-enterprise',
  pages: {
    OverviewPage,
    SetupGuidePage,
    InventoryPage,
    IndexesPage,
    IndexDefaultsPage,
    RolesPage,
    RoleDefaultsPage,
    BYOLPage,
    VersionsPage,
  },
  sidebarItems: [
    { path: '/apps/splunk-enterprise/overview', label: 'Overview', icon: 'home' },
    { path: '/apps/splunk-enterprise/setup', label: 'Setup Guide', icon: 'book' },
    { path: '/apps/splunk-enterprise/inventory', label: 'Servers', icon: 'server' },
    { path: '/apps/splunk-enterprise/indexes', label: 'Indexes', icon: 'database' },
    { path: '/apps/splunk-enterprise/index-defaults', label: 'Index Defaults', icon: 'sliders' },
    { path: '/apps/splunk-enterprise/roles', label: 'Roles', icon: 'shield' },
    { path: '/apps/splunk-enterprise/role-defaults', label: 'Role Defaults', icon: 'sliders' },
    { path: '/apps/splunk-enterprise/byol', label: 'BYOL Infrastructure', icon: 'server' },
    { path: '/apps/splunk-enterprise/versions', label: 'Versions', icon: 'git-branch' },
  ],
}
