'use strict';
const assert = require('assert');
const { createMutationGateway, normalizeMutationDescriptor } = require('../src/mutation-gateway');
const authorization = {
  schemaVersion:1,
  scope:{provider:'github',authority:'github.com',owner:'Acme',repo:'Demo',scopeKey:'github:github.com:acme/demo'},
  executionPrincipal:{kind:'user',identityKey:'a'.repeat(64),login:'Alice',authMethod:'oauth'},
  governanceActor:{kind:'human',identityKey:'a'.repeat(64),login:'Alice',verified:true},
  repositoryAccess:{baseRole:'admin',providerRole:'admin',level:50,source:'github.collaborator.permission',complete:true},
  governanceRoles:{reader:true,author:true,reviewer:true,activator:true,administrator:true},installationCapabilities:null,
  evidence:{status:'resolved',fetchedAt:'2026-07-23T00:00:00.000Z',expiresAt:'2026-07-23T01:00:00.000Z',reasonCode:null}
};
const base={mutationId:'11111111-1111-4111-8111-111111111111',action:'repository.delete',provider:'github',owner:'Acme',repo:'Demo',actorIdentityKey:'a'.repeat(64),actorLogin:'Alice',method:'DELETE',route:'/api/repo/Acme/Demo',metadata:{},security:{stepUpAction:'repository.delete',assurance:'credential',authorizedAt:1},authorization};
const normalized=normalizeMutationDescriptor(base);
assert(Object.isFrozen(normalized.execution));
assert.strictEqual(normalized.execution.mode,'single');
(async()=>{
 const events=[];
 const gateway=createMutationGateway({eventSink:e=>events.push(e)});
 await gateway.run(base,async()=>{
   const permit=gateway.assertProviderMutation({provider:'github',method:'DELETE',apiPath:'/repos/Acme/Demo'});
   assert.strictEqual(permit.providerWrite.index,1);
   assert(/^[0-9a-f]{64}$/.test(permit.providerWrite.operationId));
 });
 const write=events.find(e=>e.type==='provider.write.authorized');
 assert(write && write.operationId && write.providerWriteIndex===1);
 const tiny={...base,mutationId:'22222222-2222-4222-8222-222222222222',action:'repository.delete'};
 const overflowGateway=createMutationGateway();
 await assert.rejects(()=>overflowGateway.run(tiny,async()=>{
   overflowGateway.assertProviderMutation({provider:'github',method:'DELETE',apiPath:'/repos/Acme/Demo'});
   overflowGateway.assertProviderMutation({provider:'github',method:'DELETE',apiPath:'/repos/Acme/Demo'});
 }),e=>e.code==='MUTATION_PROVIDER_WRITE_LIMIT');
 console.log('mutation gateway execution tests passed');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;});
