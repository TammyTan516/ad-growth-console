// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture, ok, error, proposal, LANDING} from './phase34-fixture.mjs';

// The app HTTP/auth/SQLite/upload paths are real; only the OSS SDK transport is
// injected. These tests never contact a cloud account or load actual secrets.
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT1sAAAAASUVORK5CYII=','base64');
const ENV={MEDIA_STORAGE:'oss',OSS_BUCKET:'synthetic-private-media',OSS_REGION:'oss-cn-hangzhou',OSS_ACCESS_KEY_ID:'synthetic-key-id',OSS_ACCESS_KEY_SECRET:'synthetic-secret-value',OSS_PREFIX:'synthetic-prefix'};
const MATERIAL={name:'Synthetic private OSS image',source:'upload',sourceUrl:'',mediaType:'image',notes:'Synthetic storage integration',adCode:''};
async function bytes(stream){const chunks=[];for await(const chunk of stream)chunks.push(chunk);return Buffer.concat(chunks);}
function fakeOSS(){
  const objects=new Map(),calls=[];
  return {objects,calls,
    async putStream(key,stream,options){const body=await bytes(stream);calls.push({kind:'put',key,options});objects.set(key,{body,hash:options.headers['x-oss-meta-sha256']});return {res:{status:200}};},
    async head(key){calls.push({kind:'head',key});const object=objects.get(key);if(!object)throw Error('synthetic missing object');return {res:{status:200,headers:{'content-length':String(object.body.length),'x-oss-meta-sha256':object.hash}}};},
    async getStream(key,options={}){
      calls.push({kind:'get',key,options});const object=objects.get(key),range=options.headers?.Range;
      let data=object.body,status=200,headers={'content-length':String(data.length)};
      if(range){const match=/^bytes=(\d+)-(\d+)$/.exec(range),start=Number(match[1]),end=Number(match[2]);data=data.subarray(start,end+1);status=206;headers={'content-length':String(data.length),'content-range':`bytes ${start}-${end}/${object.body.length}`};}
      return {stream:Readable.from(data),res:{status,headers}};
    }
  };
}
async function createMaterial(f){return ok(await f.request('/api/materials',{method:'POST',actor:f.admin,body:MATERIAL}),201).item;}
async function upload(f,item){return f.request(`/api/materials/${item.id}/file?expectedRevision=${item.revision}`,{method:'PUT',actor:f.admin,rawBody:PNG,headers:{'Content-Type':'application/octet-stream','X-File-Name':'synthetic.png'}});}
function noPrivateStorage(value){const serialized=JSON.stringify(value);for(const secret of [ENV.OSS_BUCKET,ENV.OSS_ACCESS_KEY_ID,ENV.OSS_ACCESS_KEY_SECRET,ENV.OSS_PREFIX,'aliyuncs.com'])assert.ok(!serialized.includes(secret),'private OSS configuration/reference must not appear in public application metadata');}
async function files(directory){try{return (await Promise.all((await readdir(directory,{withFileTypes:true})).map(entry=>entry.isDirectory()?files(join(directory,entry.name)):join(directory,entry.name)))).flat();}catch(e){if(e.code==='ENOENT')return [];throw e;}}

test('private OSS media flows through authenticated team HTTP, preserves references, and proxies exact ranges without signed URL redirects',{timeout:90000},async t=>{
  const client=fakeOSS(),f=await fixture(t,{storageEnv:ENV,ossClient:client}),created=await createMaterial(f);
  assert.deepEqual(ok(await f.request('/api/storage',{actor:f.admin})),{provider:'oss',configured:true,ready:false});
  const stored=ok(await upload(f,created)).item;
  assert.equal(stored.ready,true);assert.equal(stored.hasFile,true);assert.equal(stored.revision,2);noPrivateStorage(stored);
  const privateData=JSON.parse(f.app.db.prepare('SELECT data_json FROM app_resource WHERE id=?').get(stored.id).data_json);
  assert.equal(privateData._file.storage.provider,'oss');assert.equal(privateData._file.storage.bucket,ENV.OSS_BUCKET);
  assert.equal(privateData._file.storage.key,`${ENV.OSS_PREFIX}/materials/${f.admin.me.team.id}/${stored.file.sha256}`);
  assert.equal(client.calls[0].options.headers['x-oss-object-acl'],'private');
  const catalog=ok(await f.request('/api/resources',{actor:f.admin}));noPrivateStorage(catalog);
  const landing=ok(await f.request('/api/landings',{method:'POST',actor:f.admin,body:LANDING}),201).item,item=await proposal(f);
  const workflow=ok(await f.request(`/api/proposals/${item.id}/workflow`,{method:'PATCH',actor:f.admin,body:{expectedRevision:item.revision,selection:{materials:[{id:stored.id,revision:stored.revision}],audiences:[],landing:{id:landing.id,revision:landing.revision}}}}));
  noPrivateStorage(workflow);
  const route=`/api/materials/${stored.id}/file?revision=${stored.revision}`;
  error(await f.request(route),401);
  const viewer=await f.invitedMember(f.admin,'oss-viewer@example.com','viewer'),read=await f.request(route,{actor:viewer});
  ok(read);assert.deepEqual(read.bytes,PNG);assert.equal(read.headers.get('location'),null);assert.equal(read.headers.get('cache-control'),'no-store');assert.equal(read.headers.get('accept-ranges'),'bytes');
  const partial=await f.request(route,{actor:viewer,headers:{Range:'bytes=2-7'}});ok(partial,206);assert.deepEqual(partial.bytes,PNG.subarray(2,8));assert.equal(partial.headers.get('content-range'),`bytes 2-7/${PNG.length}`);assert.equal(partial.headers.get('location'),null);
  const malformed=await f.request(route,{actor:viewer,headers:{Range:'bytes=999999-'}});error(malformed,416);assert.equal(malformed.headers.get('content-range'),`bytes */${PNG.length}`);
  const head=await f.request(route,{method:'HEAD',actor:viewer});assert.equal(head.status,200);assert.equal(head.bytes.length,0);assert.equal(Number(head.headers.get('content-length')),PNG.length);
  const other=await f.outsider();error(await f.request(route,{actor:other}),404);
  await f.restart();assert.deepEqual((await f.request(route,{actor:f.admin})).bytes,PNG,'cloud references survive an application restart');
});

test('OSS upload failure and explicit missing configuration never produce a ready material or silently store a local copy',{timeout:90000},async t=>{
  const client=fakeOSS();client.putStream=async()=>{throw Error('synthetic-secret-value: raw provider transport detail');};
  const f=await fixture(t,{storageEnv:ENV,ossClient:client}),created=await createMaterial(f);
  const beforeAudit=ok(await f.request('/api/audit',{actor:f.admin})).items;
  const failed=await upload(f,created);error(failed,502);assert.equal(failed.data.error.code,'STORAGE_WRITE_FAILED');noPrivateStorage(failed.data);assert.ok(!JSON.stringify(failed.data).includes('raw provider'));
  const after=ok(await f.request(`/api/materials/${created.id}`,{actor:f.admin})).item;assert.equal(after.revision,created.revision);assert.equal(after.ready,false);assert.equal(after.file,null);
  assert.equal(ok(await f.request(`/api/materials/${created.id}/versions`,{actor:f.admin})).items.length,1);assert.deepEqual(ok(await f.request('/api/audit',{actor:f.admin})).items,beforeAudit);
  assert.deepEqual(await files(join(f.dataDir,'uploads')),[],'failed cloud upload leaves no fallback media or temporary file');
  const missing=await fixture(t,{storageEnv:{MEDIA_STORAGE:'oss'},ossClient:fakeOSS()}),unavailable=await createMaterial(missing);
  assert.deepEqual(ok(await missing.request('/api/storage',{actor:missing.admin})),{provider:'oss',configured:false,ready:false});
  const rejected=await upload(missing,unavailable);error(rejected,503);assert.equal(rejected.data.error.code,'OSS_NOT_CONFIGURED');
  const unchanged=ok(await missing.request(`/api/materials/${unavailable.id}`,{actor:missing.admin})).item;assert.equal(unchanged.ready,false);assert.equal(unchanged.revision,1);assert.deepEqual(await files(join(missing.dataDir,'uploads')),[]);
});

test('private cloud download rechecks team membership after the asynchronous stream opens and closes a revoked read',{timeout:90000},async t=>{
  const client=fakeOSS(),f=await fixture(t,{storageEnv:ENV,ossClient:client}),stored=ok(await upload(f,await createMaterial(f))).item;
  const viewer=await f.invitedMember(f.admin,'slow-oss-viewer@example.com','viewer');
  let release,entered,openedStream;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const original=client.getStream;
  client.getStream=async(...args)=>{entered();await gate;const value=await original(...args);openedStream=value.stream;return value;};
  const download=f.request(`/api/materials/${stored.id}/file?revision=${stored.revision}`,{actor:viewer});
  await started;
  ok(await f.request(`/api/members/${viewer.me.user.id}`,{method:'PATCH',actor:f.admin,body:{status:'disabled'}}));
  release();const rejected=await download;error(rejected,403);assert.equal(rejected.data.error.code,'MEMBER_DISABLED');assert.notDeepEqual(rejected.bytes,PNG);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(openedStream.destroyed,true,'unpublished upstream stream is destroyed after access revocation');
});
