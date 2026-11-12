import { build } from 'esbuild'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const root=fileURLToPath(new URL('../apps/microsoft-entra-id/',import.meta.url))
const result=await build({entryPoints:[root+'lib/capabilities.ts'],bundle:true,write:false,format:'esm',platform:'node'})
const {CAPABILITIES}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
const cell=value=>String(value).replace(/\|/g,'/').replace(/\n/g,' ')
const table=['| Configuration type | Read | Write | Optional references and assignments | Rollback / support |','| --- | --- | --- | --- | --- |',...CAPABILITIES.map(c=>{
 const optional=[...c.pickerPermissions,...Object.entries(c.optionalWritePermissions??{}).map(([operation,permissions])=>operation+': '+permissions.join(', '))].join('; ')||'None'
 return '| '+[c.id,c.readPermissions.join(', ')||'Unsupported',c.writePermissions.join(', ')||'Unsupported',optional,c.appOnly?c.rollbackLimits.join(' ')||'Managed fields only; see deployment review':c.unsupportedReason].map(cell).join(' | ')+' |'
})].join('\n')
const path=root+'README.md',before=readFileSync(path,'utf8').replace(/\r\n/g,'\n')
const start='<!-- capabilities:start -->',end='<!-- capabilities:end -->'
const from=before.indexOf(start),to=before.indexOf(end)
if(from<0||to<0)throw new Error('README capability markers missing')
const after=before.slice(0,from)+start+'\n'+table+'\n'+before.slice(to)
if(process.argv.includes('--write'))writeFileSync(path,after)
else if(before!==after)throw new Error('README capability table is stale; run node ../../scripts/check-entra-capabilities.mjs --write')
console.log('Capability documentation matches all '+CAPABILITIES.length+' registry entries')
