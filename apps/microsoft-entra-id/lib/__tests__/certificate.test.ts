import test from 'node:test'
import assert from 'node:assert/strict'
import { constants, generateKeyPairSync, sign, verify, X509Certificate } from 'node:crypto'
import { certificateAssertion, GraphClient } from '../graph'
import { TOKEN, collection, recordFetch } from './fakeGraph'

// Ephemeral self-signed test certificate: no stored private key or external openssl dependency.
function testCertificate() {
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048})
 const der=(tag:number,...parts:Buffer[])=>{
  const body=Buffer.concat(parts);let size=body.length
  const octets:number[]=[];while(size){octets.unshift(size&255);size>>=8}
  return Buffer.concat([Buffer.from([tag,...(body.length<128?[body.length]:[0x80|octets.length,...octets])]),body])
 }
 const seq=(...parts:Buffer[])=>der(0x30,...parts)
 const oid=(hex:string)=>der(6,Buffer.from(hex,'hex'))
 const algorithm=seq(oid('2a864886f70d01010b'),der(5))
 const name=seq(der(0x31,seq(oid('550403'),der(0x0c,Buffer.from('entra-test')))))
 const validity=seq(der(0x17,Buffer.from('260101000000Z')),der(0x17,Buffer.from('300101000000Z')))
 const tbs=seq(der(0xa0,der(2,Buffer.from([2]))),der(2,Buffer.from([1])),algorithm,name,validity,name,
  publicKey.export({format:'der',type:'spki'}) as Buffer)
 const certificate=seq(tbs,algorithm,der(3,Buffer.from([0]),sign('sha256',tbs,privateKey)))
 const pem='-----BEGIN CERTIFICATE-----\n'+certificate.toString('base64').match(/.{1,64}/g)!.join('\n')+'\n-----END CERTIFICATE-----\n'
 return {pem:pem+privateKey.export({format:'pem',type:'pkcs8'}),publicKey,certificate:pem}
}

test('certificate assertion has a verifiable PS256 signature, certificate thumbprint and tenant-specific audience',()=>{
 const fixture=testCertificate(),audience='https://login.microsoftonline.us/tenant/oauth2/v2.0/token'
 const assertion=certificateAssertion(fixture.pem,'application',audience)
 const [header,payload,signature]=assertion.split('.')
 const h=JSON.parse(Buffer.from(header,'base64url').toString())
 const p=JSON.parse(Buffer.from(payload,'base64url').toString())
 assert.equal(h.alg,'PS256');assert.equal(p.aud,audience);assert.equal(p.iss,'application');assert.equal(p.sub,'application')
 assert.ok(p.exp-p.nbf<=330);assert.ok(p.jti)
 assert.equal(h['x5t#S256'],Buffer.from(new X509Certificate(fixture.certificate).fingerprint256.replace(/:/g,''),'hex').toString('base64url'))
 assert.equal(verify('sha256',Buffer.from(header+'.'+payload),{key:fixture.publicKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:32},Buffer.from(signature,'base64url')),true)
})

test('certificate exchange sends an assertion instead of a client secret',async()=>{
 const fixture=testCertificate();const {calls,restore}=recordFetch([TOKEN,collection([])])
 try {
  const result=await new GraphClient({cred:{tenantId:'tenant',clientId:'app',clientSecret:'must-not-send',certificate:fixture.pem},timeoutMs:1000}).get('/groups')
  assert.equal(result.ok,true)
  const form=new URLSearchParams(String(calls[0].body))
  assert.equal(form.has('client_secret'),false);assert.ok(form.get('client_assertion'));assert.equal(form.get('client_assertion_type'),'urn:ietf:params:oauth:client-assertion-type:jwt-bearer')
 }finally{restore()}
})
