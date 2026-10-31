// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, ok, error, proposal, setupResources, CONTENT, CONFIG, LANDING, freshBrief} from './phase34-fixture.mjs';

const route = (item, suffix = 'workflow') => `/api/proposals/${item.id}/${suffix}`;
async function saveWorkflow(f, item, data, actor = f.admin) {
  return ok(await f.request(route(item), {method: 'PATCH', actor, body: {expectedRevision: item.revision, ...data}}));
}
async function tracking(f, state, actor = f.admin) {
  return ok(await f.request(route(state.item, 'tracking'), {method: 'POST', actor, body: {expectedRevision: state.item.revision}}));
}
async function review(f, state, action, actor = f.admin, note = '') {
  return ok(await f.request(route(state.item, 'review'), {method: 'POST', actor, body: {expectedRevision: state.item.revision, action, note}}));
}

test('planning links exact resource versions, retains snapshots and enforces revision/team/role boundaries', {timeout: 90000}, async t => {
  const f = await fixture(t), resources = await setupResources(f), item = await proposal(f);
  const initial = ok(await f.request(route(item), {actor: f.admin}));
  assert.equal(initial.item.id, item.id);
  assert.equal(initial.workflow.review.status, 'draft');
  let state = await saveWorkflow(f, item, {selection: resources.selection});
  assert.equal(state.item.revision, item.revision + 1);
  assert.equal(state.workflow.selectionSnapshot.landing.url, resources.landing.url);
  assert.equal(state.workflow.selectionSnapshot.materials[0].id, resources.material.id);
  assert.ok(!JSON.stringify(state.workflow).includes('SYNTHETIC-CREATOR-CODE'), 'creator authorization code is not sent to the prompt/review snapshot');
  error(await f.request(route(item), {method: 'PATCH', actor: f.admin, body: {expectedRevision: item.revision, selection: resources.selection}}), 409);
  const originalSnapshot = structuredClone(state.workflow.selectionSnapshot);
  const updatedLanding = ok(await f.request(`/api/landings/${resources.landing.id}`, {method: 'PATCH', actor: f.admin, body: {expectedRevision: resources.landing.revision, name: 'Changed landing label'}})).item;
  assert.equal(updatedLanding.revision, resources.landing.revision + 1);
  state = ok(await f.request(route(item), {actor: f.admin}));
  assert.deepEqual(state.workflow.selectionSnapshot, originalSnapshot, 'library edits must not silently rewrite saved choices');
  const viewer = await f.invitedMember(f.admin, 'viewer@example.com', 'viewer');
  ok(await f.request(route(item), {actor: viewer}));
  for (const suffix of ['workflow', 'generation', 'tracking', 'review']) {
    error(await f.request(route(item, suffix), {method: suffix === 'workflow' ? 'PATCH' : 'POST', actor: viewer, body: {expectedRevision: state.item.revision, ...(suffix === 'workflow' ? {selection: resources.selection} : suffix === 'review' ? {action: 'approve', note: ''} : {})}}), 403, 'viewer write denied');
  }
  const other = await f.outsider();
  error(await f.request(route(item), {actor: other}), 404, 'cross-team workflow hidden');
  const otherItem = await proposal(f, other);
  error(await f.request(route(otherItem), {method: 'PATCH', actor: other, body: {expectedRevision: otherItem.revision, selection: resources.selection}}), [400, 404], 'cross-team resource reference denied');
  const versions = ok(await f.request(`/api/proposals/${item.id}/versions`, {actor: f.admin})).items;
  assert.equal(versions.length, 2, 'resource library change does not rewrite a proposal version');
});

test('Codex generation has an explicit structured request, rejects stale/forged results and never fabricates content', {timeout: 90000}, async t => {
  const f = await fixture(t), resources = await setupResources(f), item = await proposal(f);
  let state = await saveWorkflow(f, item, {selection: resources.selection});
  const generated = ok(await f.request(route(item, 'generation'), {method: 'POST', actor: f.admin, body: {expectedRevision: state.item.revision}}));
  assert.ok(generated.generation.id);
  assert.equal(typeof generated.generation.prompt, 'string');
  assert.ok(generated.generation.prompt.includes(resources.landing.url));
  assert.ok(generated.generation.prompt.includes(resources.material.name));
  assert.ok(generated.generation.schema && typeof generated.generation.schema === 'object');
  assert.equal(generated.workflow.content, null, 'preparing a prompt must not invent AI output');
  assert.ok(!generated.generation.prompt.includes('SYNTHETIC-CREATOR-CODE'));
  error(await f.request(route(item, 'generation/result'), {method: 'POST', actor: f.admin, body: {expectedRevision: generated.item.revision, generationId: 'missing-request', result: CONTENT}}), [400, 409]);
  error(await f.request(route(item, 'generation/result'), {method: 'POST', actor: f.admin, body: {expectedRevision: generated.item.revision, generationId: generated.generation.id, result: {...CONTENT, approved: true}}}), 400);
  error(await f.request(route(item, 'generation/result'), {method: 'POST', actor: f.admin, body: {expectedRevision: generated.item.revision, generationId: generated.generation.id, result: {...CONTENT, platforms: [{...CONTENT.platforms[0], platform: 'TikTok'}]}}}), 400);
  const imported = ok(await f.request(route(item, 'generation/result'), {method: 'POST', actor: f.admin, body: {expectedRevision: generated.item.revision, generationId: generated.generation.id, result: CONTENT}}));
  assert.deepEqual(imported.workflow.content, CONTENT);
  assert.equal(imported.workflow.review.status, 'draft');
  const duplicate = error(await f.request(route(item, 'generation/result'), {method: 'POST', actor: f.admin, body: {expectedRevision: imported.item.revision, generationId: generated.generation.id, result: {...CONTENT, strategy: 'Must not replace an already imported result.'}}}), 409, 'a consumed generation request cannot be imported twice');
  assert.equal(duplicate.error.code, 'RESULT_ALREADY_IMPORTED');
  const generation2 = ok(await f.request(route(item, 'generation'), {method: 'POST', actor: f.admin, body: {expectedRevision: imported.item.revision}}));
  assert.deepEqual(generation2.workflow.content, CONTENT, 'previous content remains available for human comparison');
  assert.equal(generation2.workflow.contentBasis, null, 'preparing new generation invalidates old copy for review');
  const oldCopy = error(await f.request(route(item, 'review'), {method: 'POST', actor: f.admin, body: {expectedRevision: generation2.item.revision, action: 'submit', note: ''}}), 409, 'old copy cannot be submitted while a new generation is pending');
  assert.equal(oldCopy.error.code, 'CONTENT_STALE');
  const manualContent = {...CONTENT, strategy: CONTENT.strategy + ' Manually corrected by the reviewer.'};
  const manual = await saveWorkflow(f, generation2.item, {content: manualContent});
  assert.equal(manual.workflow.generation, null, 'manual copy save cancels the pending generation request');
  error(await f.request(route(item, 'generation/result'), {method: 'POST', actor: f.admin, body: {expectedRevision: manual.item.revision, generationId: generation2.generation.id, result: CONTENT}}), 409, 'an old result cannot revert a later manual edit');
  const generation3 = ok(await f.request(route(item, 'generation'), {method: 'POST', actor: f.admin, body: {expectedRevision: manual.item.revision}}));
  const changed = ok(await f.request(`/api/proposals/${item.id}`, {method: 'PATCH', actor: f.admin, body: {expectedRevision: generation3.item.revision, brief: freshBrief({audienceDirection: 'Different approved audience direction'})}})).item;
  error(await f.request(route(item, 'generation/result'), {method: 'POST', actor: f.admin, body: {expectedRevision: changed.revision, generationId: generation3.generation.id, result: CONTENT}}), 409, 'an old generation cannot attach to a changed brief');
  const reread = ok(await f.request(route(item), {actor: f.admin}));
  assert.deepEqual(reread.workflow.content, manualContent, 'failed import preserves the last saved manual content');
});

test('UTM rules are private saved configuration and links are stable registry records with preserved URL parts', {timeout: 90000}, async t => {
  const f = await fixture(t), resources = await setupResources(f), item = await proposal(f);
  let state = await saveWorkflow(f, item, {selection: resources.selection});
  const initial = ok(await f.request('/api/tracking-config', {actor: f.admin})).item;
  assert.equal(initial.configured, false);
  error(await f.request(route(item, 'tracking'), {method: 'POST', actor: f.admin, body: {expectedRevision: state.item.revision}}), [400, 409], 'requires explicit company tracking setup');
  const editor = await f.invitedMember(f.admin, 'editor@example.com');
  error(await f.request('/api/tracking-config', {method: 'PUT', actor: editor, body: CONFIG}), 403);
  const config = ok(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: CONFIG})).item;
  assert.equal(config.revision, 1);
  assert.equal(config.configured, true);
  error(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: CONFIG}), 409, 'configuration optimistic conflict');
  error(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: {...CONFIG, expectedRevision: 1, campaignTemplate: '{userEmail}'}}), 400, 'unsupported personal template token');
  state = await tracking(f, state);
  assert.equal(state.workflow.tracking.length, 1);
  const saved = state.workflow.tracking[0], url = new URL(saved.url);
  assert.ok(saved.id);
  assert.equal(saved.code, saved.id);
  assert.equal(url.searchParams.get('tracking_code'), saved.id);
  assert.equal(saved.platform, 'Google');
  assert.equal(url.origin, 'https://example.com');
  assert.equal(url.pathname, '/create');
  assert.equal(url.searchParams.get('keep'), 'value');
  assert.equal(url.hash, '#start');
  assert.equal(url.searchParams.get('utm_source'), 'google');
  assert.equal(url.searchParams.get('utm_medium'), 'cpc');
  assert.equal(url.searchParams.get('utm_campaign'), item.id);
  assert.equal(url.searchParams.get('utm_content'), resources.material.id);
  const again = await tracking(f, state);
  assert.deepEqual(again.workflow.tracking, state.workflow.tracking, 'same inputs reuse immutable tracking records');
  assert.equal(new URL(again.workflow.tracking[0].url).searchParams.get('tracking_code'), saved.id);
  let registry = ok(await f.request('/api/tracking', {actor: f.admin})).items;
  assert.equal(registry.length, 1);
  const config2 = ok(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: {...CONFIG, expectedRevision: 1, name: 'Same UTM fields under a new rule revision'}})).item;
  assert.equal(config2.revision, 2);
  const next = await tracking(f, again);
  assert.notEqual(next.workflow.tracking[0].id, saved.id);
  assert.deepEqual(next.workflow.tracking[0].utm, saved.utm, 'a rule revision may intentionally render identical UTM labels');
  assert.equal(new URL(next.workflow.tracking[0].url).searchParams.get('tracking_code'), next.workflow.tracking[0].id);
  assert.notEqual(next.workflow.tracking[0].code, saved.code, 'registry identity still distinguishes the rule revisions');
  registry = ok(await f.request('/api/tracking', {actor: f.admin})).items;
  assert.equal(registry.length, 2, 'old link remains in the registry for future business-system joins');
  const renamed = ok(await f.request(`/api/proposals/${item.id}`, {method: 'PATCH', actor: f.admin, body: {expectedRevision: next.item.revision, title: 'Changed brief title with the same UTM labels'}})).item;
  const changedBasis = await tracking(f, {item: renamed});
  assert.deepEqual(changedBasis.workflow.tracking[0].utm, saved.utm);
  assert.notEqual(changedBasis.workflow.tracking[0].code, saved.code);
  assert.notEqual(changedBasis.workflow.tracking[0].code, next.workflow.tracking[0].code);
  assert.equal(new URL(changedBasis.workflow.tracking[0].url).searchParams.get('tracking_code'), changedBasis.workflow.tracking[0].id);
  const other = await f.outsider();
  assert.equal(ok(await f.request('/api/tracking', {actor: other})).items.length, 0);
  await f.restart();
  assert.equal(ok(await f.request('/api/tracking', {actor: f.admin})).items.length, 3, 'tracking survives server restart');
});

test('human review requires complete saved inputs, tracks the reviewer and is invalidated by subsequent edits', {timeout: 90000}, async t => {
  const f = await fixture(t), resources = await setupResources(f), item = await proposal(f);
  let state = ok(await f.request(route(item), {actor: f.admin}));
  error(await f.request(route(item, 'review'), {method: 'POST', actor: f.admin, body: {expectedRevision: item.revision, action: 'approve', note: ''}}), [400, 409]);
  error(await f.request(route(item, 'review'), {method: 'POST', actor: f.admin, body: {expectedRevision: item.revision, action: 'submit', note: ''}}), [400, 409]);
  ok(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: CONFIG}));
  const unreadyPages = [
    {name: 'Uncategorized sitemap page', language: '', description: '', objective: 'both', code: 'LANDING_NOT_READY'},
    {name: 'Wrong-language page', language: 'zh-cn', description: 'Synthetic Chinese page', objective: 'registration', code: 'LANDING_LANGUAGE_MISMATCH'},
    {name: 'Different-goal page', language: 'English', description: 'Synthetic subscription page', objective: 'first_subscription', code: 'LANDING_GOAL_MISMATCH'},
  ];
  for (const [index, page] of unreadyPages.entries()) {
    const {code, ...metadata} = page;
    const landing = ok(await f.request('/api/landings', {method: 'POST', actor: f.admin, body: {...LANDING, ...metadata, url: `https://example.com/unready-${index}`}}), 201).item;
    const selection = {...resources.selection, landing: {id: landing.id, revision: landing.revision}};
    state = await saveWorkflow(f, state.item, {selection, content: CONTENT});
    state = await tracking(f, state);
    const rejected = error(await f.request(route(item, 'review'), {method: 'POST', actor: f.admin, body: {expectedRevision: state.item.revision, action: 'submit', note: ''}}), 400, 'landing must be reviewed and match language/goal');
    assert.equal(rejected.error.code, code);
  }
  const aliasLanding = ok(await f.request(`/api/landings/${resources.landing.id}`, {method: 'PATCH', actor: f.admin, body: {expectedRevision: resources.landing.revision, language: 'en'}})).item;
  resources.selection.landing = {id: aliasLanding.id, revision: aliasLanding.revision};
  state = await saveWorkflow(f, state.item, {selection: resources.selection, content: CONTENT});
  state = await tracking(f, state);
  state = await review(f, state, 'submit');
  assert.equal(state.workflow.review.status, 'in_review', 'English and en are accepted as the same language');
  const editor = await f.invitedMember(f.admin, 'reviewer@example.com');
  state = await review(f, state, 'request_changes', editor, 'Please make the offer clearer.');
  assert.equal(state.workflow.review.status, 'changes_requested');
  assert.equal(state.workflow.review.note, 'Please make the offer clearer.');
  state = await saveWorkflow(f, state.item, {content: {...CONTENT, strategy: CONTENT.strategy + ' Revised after review.'}}, editor);
  assert.equal(state.workflow.review.status, 'draft');
  // Content changes may clear the selected tracking references to force an
  // explicit recheck; generating again must reuse the same durable URL records.
  state = await tracking(f, state, editor);
  state = await review(f, state, 'submit', editor);
  state = await review(f, state, 'approve', f.admin, 'Reviewed the exact copy, page and tracking links.');
  assert.equal(state.workflow.review.status, 'approved');
  assert.equal(state.workflow.review.actor.id, f.admin.me.user.id);
  assert.ok(state.workflow.review.at);
  const approvedRevision = state.item.revision;
  error(await f.request(route(item), {method: 'PATCH', actor: editor, body: {expectedRevision: approvedRevision, review: {status: 'approved'}}}), 400, 'browser cannot forge review state');
  const update = ok(await f.request(`/api/proposals/${item.id}`, {method: 'PATCH', actor: editor, body: {expectedRevision: approvedRevision, title: 'Renamed after approval'}}));
  state = ok(await f.request(route(item), {actor: f.admin}));
  assert.equal(state.item.revision, update.item.revision);
  assert.equal(state.workflow.review.status, 'draft');
  const versions = ok(await f.request(`/api/proposals/${item.id}/versions`, {actor: f.admin})).items;
  const approved = versions.find(version => version.revision === approvedRevision);
  assert.ok(approved);
  assert.equal(approved.workflow.review.status, 'approved', 'old approved snapshot remains inspectable');
});

test('workflow writes roll back together with version/audit and archived drafts cannot be submitted', {timeout: 90000}, async t => {
  const f = await fixture(t), resources = await setupResources(f), item = await proposal(f);
  const before = ok(await f.request(route(item), {actor: f.admin}));
  const beforeVersions = ok(await f.request(`/api/proposals/${item.id}/versions`, {actor: f.admin}));
  f.app.db.exec("CREATE TRIGGER phase34_abort_audit BEFORE INSERT ON app_audit BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END;");
  error(await f.request(route(item), {method: 'PATCH', actor: f.admin, body: {expectedRevision: item.revision, selection: resources.selection}}), 500);
  f.app.db.exec('DROP TRIGGER phase34_abort_audit');
  assert.deepEqual(ok(await f.request(route(item), {actor: f.admin})), before);
  assert.deepEqual(ok(await f.request(`/api/proposals/${item.id}/versions`, {actor: f.admin})), beforeVersions);
  const archived = ok(await f.request(`/api/proposals/${item.id}`, {method: 'PATCH', actor: f.admin, body: {expectedRevision: item.revision, status: 'archived'}})).item;
  error(await f.request(route(item), {method: 'PATCH', actor: f.admin, body: {expectedRevision: archived.revision, selection: resources.selection}}), [400, 409], 'archived proposal is read-only');
  error(await f.request(route(item, 'review'), {method: 'POST', actor: f.admin, body: {expectedRevision: archived.revision, action: 'submit', note: ''}}), [400, 409]);
});

test('approval becomes ineffective when UTM rules or selected resources change, while approved historical snapshots remain intact', {timeout: 90000}, async t => {
  const f = await fixture(t), resources = await setupResources(f), item = await proposal(f);
  let state = await saveWorkflow(f, item, {selection: resources.selection, content: CONTENT});
  ok(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: CONFIG}));
  state = await tracking(f, state);
  state = await review(f, state, 'submit');
  state = await review(f, state, 'approve');
  const approvedRevision = state.item.revision;
  const originalTrackingIds = state.workflow.tracking.map(record => record.id);
  ok(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: {...CONFIG, expectedRevision: 1, name: 'Changed private tracking rule', contentTemplate: '{materialId}-{platform}'}}));
  const configInvalidated = ok(await f.request(route(item), {actor: f.admin}));
  assert.equal(configInvalidated.workflow.review.status, 'draft');
  assert.equal(configInvalidated.workflow.review.invalidated, true);
  assert.ok(configInvalidated.workflow.warnings.length > 0);
  assert.equal(configInvalidated.item.revision, approvedRevision, 'effective invalidation on read does not invent a proposal edit');
  assert.equal(configInvalidated.item.workflow.review.status, 'draft');
  assert.equal(ok(await f.request(`/api/proposals/${item.id}`, {actor: f.admin})).item.workflow.review.status, 'draft', 'single-proposal read uses the effective approval state');
  assert.equal(ok(await f.request('/api/proposals', {actor: f.admin})).items.find(saved => saved.id === item.id).workflow.review.status, 'draft', 'proposal list cannot show a stale approval');
  const history = ok(await f.request(`/api/proposals/${item.id}/versions`, {actor: f.admin})).items;
  assert.equal(history.find(version => version.revision === approvedRevision).workflow.review.status, 'approved');
  state = await tracking(f, configInvalidated);
  assert.notDeepEqual(state.workflow.tracking.map(record => record.id), originalTrackingIds);
  state = await review(f, state, 'submit');
  state = await review(f, state, 'approve');
  const secondApprovedRevision = state.item.revision;
  ok(await f.request(`/api/materials/${resources.material.id}`, {method: 'PATCH', actor: f.admin, body: {expectedRevision: resources.material.revision, status: 'archived'}}));
  const resourceInvalidated = ok(await f.request(route(item), {actor: f.admin}));
  assert.equal(resourceInvalidated.workflow.review.status, 'draft');
  assert.equal(resourceInvalidated.workflow.review.invalidated, true);
  assert.ok(resourceInvalidated.workflow.warnings.length > 0);
  assert.equal(resourceInvalidated.workflow.selectionSnapshot.materials[0].status, 'active', 'old resource snapshot is preserved for inspection');
  error(await f.request(route(item, 'review'), {method: 'POST', actor: f.admin, body: {expectedRevision: secondApprovedRevision, action: 'submit', note: ''}}), 409, 'archived/currently changed resource cannot regain approval');
  error(await f.request(route(item, 'tracking'), {method: 'POST', actor: f.admin, body: {expectedRevision: secondApprovedRevision}}), 409);
  const after = ok(await f.request(`/api/proposals/${item.id}/versions`, {actor: f.admin})).items;
  assert.equal(after.find(version => version.revision === secondApprovedRevision).workflow.review.status, 'approved');
});


test('Google search copy can be saved during editing but review enforces asset counts and character width', {timeout: 90000}, async t => {
  const f = await fixture(t), resources = await setupResources(f), item = await proposal(f);
  let state = await saveWorkflow(f, item, {selection: resources.selection, content: CONTENT});
  ok(await f.request('/api/tracking-config', {method: 'PUT', actor: f.admin, body: CONFIG}));
  state = await tracking(f, state);
  const original = CONTENT.platforms[0];
  const invalidCopies = [
    {...original, headlines: ['One title', 'Two titles']},
    {...original, headlines: Array.from({length: 16}, (_, i) => `Title ${i}`)},
    {...original, descriptions: ['Only one description.']},
    {...original, descriptions: Array.from({length: 5}, (_, i) => `Description ${i}`)},
    {...original, headlines: ['A'.repeat(31), ...original.headlines.slice(1)]},
    {...original, descriptions: ['D'.repeat(91), original.descriptions[1]]},
    {...original, headlines: ['广'.repeat(16), ...original.headlines.slice(1)]},
    {...original, descriptions: ['文'.repeat(46), original.descriptions[1]]},
  ];
  for (const copy of invalidCopies) {
    const content = {...CONTENT, platforms: [copy]};
    state = await saveWorkflow(f, state.item, {content});
    assert.deepEqual(state.workflow.content, content, 'unfinished copy can be saved without losing edits');
    const rejected = error(await f.request(route(item, 'review'), {method: 'POST', actor: f.admin, body: {expectedRevision: state.item.revision, action: 'submit', note: ''}}), 400, 'non-ready Google asset counts or width');
    assert.equal(rejected.error.code, 'COPY_NOT_READY');
  }
  const boundaryCopy = {...original, headlines: ['A'.repeat(30), '广'.repeat(15), 'Third valid title'], descriptions: ['D'.repeat(90), '文'.repeat(45)]};
  state = await saveWorkflow(f, state.item, {content: {...CONTENT, platforms: [boundaryCopy]}});
  state = await review(f, state, 'submit');
  assert.equal(state.workflow.review.status, 'in_review', 'exact ASCII and double-width boundaries pass');
});
