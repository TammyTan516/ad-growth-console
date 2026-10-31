// SPDX-License-Identifier: MIT
// Exercise the actual UI controller with a synthetic DOM shell and HTTP replies.
// No workspace, real connector or browser authentication is used by these tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../workspace/app.js', import.meta.url), 'utf8');
const device = {id:'synthetic-device',name:'Synthetic computer',status:'pending',online:true};
const active = {...device,status:'active',confirmedAt:'2026-10-27T08:00:00.000Z'};
const reply = (data, status=200) => ({ok:status<400,status,json:async()=>data});
function harness(replies=[]) {
  const calls=[], root={innerHTML:'',addEventListener(){},querySelector(){return null;}};
  const context={URL,URLSearchParams,Date,Intl,setInterval(){},location:{hash:'',origin:'https://example.com'},
    document:{getElementById(){return root;},body:{setAttribute(){}},hidden:false},window:{addEventListener(){}},
    fetch:async(path,options)=>{calls.push({path,method:options.method});const value=replies.shift();if(value instanceof Error)throw value;if(!value)throw Error('Unexpected request');return value;}};
  const instrumented=source.replace('void start();','globalThis.ui={state,handleCodexClick,connectorCards,banner,saveConnectorConfirmation};');
  assert.notEqual(instrumented,source);
  vm.runInNewContext(instrumented,context);
  const ui=context.ui;Object.assign(ui.state,{loading:false,view:'codex',connectorsLoaded:true,connectors:[{...device}],me:{user:{id:'synthetic-owner',name:'Synthetic owner'},team:{id:'synthetic-team',name:'Synthetic team'},permissions:{canEdit:true}}});
  const open=()=>ui.handleCodexClick({dataset:{confirmConnector:device.id},hasAttribute:()=>false});
  return {ui,calls,root,open,replies};
}
test('first click opens unsaved confirmation inside the matching device card and sends no request',()=>{
  const h=harness();h.open();
  assert.equal(h.calls.length,0);
  const cards=h.ui.connectorCards();
  assert.ok(cards.includes('尚未保存，请在下方确认。'));
  assert.ok(cards.includes('确认连接并保存'));
  assert.ok(cards.indexOf('data-codex-confirmation')<cards.indexOf('</article>'));
  assert.ok(!h.ui.banner().includes('data-codex-confirmation'),'device confirmation is not hidden at page top');
});
test('success requires server readback and renders the persisted confirmation time',async()=>{
  const h=harness([reply({item:active}),reply({items:[active]})]);h.open();
  await h.ui.saveConnectorConfirmation(h.ui.state.codexConfirmation);
  assert.deepEqual(h.calls.map(c=>c.method),['POST','GET']);
  assert.equal(h.ui.state.codexConfirmation,null);
  assert.ok(h.ui.connectorCards().includes('已确认并保存：'));
  assert.ok(h.ui.state.message.includes('保存结果已核对'));
});
test('a lost POST response is reconciled by reading status without submitting again',async()=>{
  const h=harness([Error('Synthetic lost response'),reply({items:[active]})]);h.open();
  await h.ui.saveConnectorConfirmation(h.ui.state.codexConfirmation);
  assert.equal(h.calls.filter(c=>c.method==='POST').length,1);
  assert.equal(h.ui.state.codexConfirmation,null);
});
test('readback failure retains the confirmation and next click only checks saved state',async()=>{
  const h=harness([reply({item:active}),Error('Synthetic read failure'),reply({items:[active]})]);h.open();
  const pending=h.ui.state.codexConfirmation;
  await h.ui.saveConnectorConfirmation(pending);
  assert.equal(h.ui.state.codexConfirmation,pending);assert.equal(pending.uncertain,true);
  assert.ok(h.ui.connectorCards().includes('检查保存状态'));
  await h.ui.saveConnectorConfirmation(pending);
  assert.deepEqual(h.calls.map(c=>c.method),['POST','GET','GET']);
  assert.equal(h.ui.state.codexConfirmation,null);
});
test('a failed save keeps deliberate confirmation and active without confirmation time cannot look saved',async()=>{
  for(const observed of [device,{...active,confirmedAt:null}]) {
    const h=harness([reply({error:{code:'SYNTHETIC_FAILED',message:'Synthetic save failed'}},500),reply({items:[observed]})]);h.open();
    const pending=h.ui.state.codexConfirmation;
    await assert.rejects(h.ui.saveConnectorConfirmation(pending));
    assert.equal(h.ui.state.codexConfirmation,pending);
    assert.equal(pending.uncertain,false);
    assert.ok(h.ui.connectorCards().includes('确认连接并保存'));
  }
});
