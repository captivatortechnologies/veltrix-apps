// Called when the app is being uninstalled.
// Clean up any resources, but DO NOT drop tables by default.
// The platform will ask the user if they want to remove data.

interface UninstallContext {
  db: any // PrismaClient
  appId: string
}

export default async function onUninstall(ctx: UninstallContext): Promise<void> {
  console.log(`[${ctx.appId}] App uninstalled`)
}
