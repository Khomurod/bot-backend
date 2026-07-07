const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectRouteAssignment,
  classifyMapsLink,
  hasRouteKeyword,
  shouldReplyOnUnparseable,
  authorizeRouteAssigner,
} = require('../services/routeMessageDetection');

test('classifyMapsLink distinguishes directions / short / place', () => {
  assert.equal(classifyMapsLink('https://www.google.com/maps/dir/A/B/@1,2,7z'), 'directions');
  assert.equal(classifyMapsLink('https://www.google.com/maps/dir/?api=1&origin=A&destination=B'), 'directions');
  assert.equal(classifyMapsLink('https://maps.app.goo.gl/AbCdEf123'), 'short');
  assert.equal(classifyMapsLink('https://www.google.com/maps/place/Pilot+Travel+Center'), 'place');
  assert.equal(classifyMapsLink('https://maps.google.com/?q=41.7,-86.3'), 'place');
});

test('a full directions link is a route candidate (no keyword needed)', () => {
  const d = detectRouteAssignment('https://www.google.com/maps/dir/Chicago/Dallas/@1,2,6z/data=x');
  assert.equal(d.isCandidate, true);
  assert.equal(d.linkKind, 'directions');
});

test('a shortened maps.app.goo.gl link is a candidate (expanded later)', () => {
  const d = detectRouteAssignment('please follow https://maps.app.goo.gl/ELB6VP2bJcQSZXj37');
  assert.equal(d.isCandidate, true);
  assert.equal(d.linkKind, 'short');
});

test('a plain location pin WITHOUT a route keyword is ignored', () => {
  const d = detectRouteAssignment('here is the truck stop https://www.google.com/maps/place/Loves');
  assert.equal(d.isCandidate, false);
});

test('a location pin WITH a route keyword becomes a candidate', () => {
  const d = detectRouteAssignment('take this route https://www.google.com/maps/place/Loves');
  assert.equal(d.isCandidate, true);
  assert.equal(d.hasKeyword, true);
});

test('a non-Google link is never a candidate', () => {
  assert.equal(detectRouteAssignment('https://example.com/maps/dir/A/B').isCandidate, false);
  assert.equal(detectRouteAssignment('no link at all, just route talk').isCandidate, false);
});

test('hasRouteKeyword matches phrases and the word "route"', () => {
  assert.equal(hasRouteKeyword('please use this route'), true);
  assert.equal(hasRouteKeyword('DRIVER ROUTE below'), true);
  assert.equal(hasRouteKeyword('reroute the router'), false);
  assert.equal(hasRouteKeyword('fuel stop here'), false);
});

test('shouldReplyOnUnparseable: explain on keyword/directions, stay silent on a bare short pin', () => {
  assert.equal(shouldReplyOnUnparseable({ linkKind: 'directions', hasKeyword: false }), true);
  assert.equal(shouldReplyOnUnparseable({ linkKind: 'place', hasKeyword: true }), true);
  assert.equal(shouldReplyOnUnparseable({ linkKind: 'short', hasKeyword: false }), false);
});

test('authorizeRouteAssigner: global admin always allowed', () => {
  const r = authorizeRouteAssigner({ isGlobalAdmin: true, memberTeamIds: [], groupTeamIds: [] });
  assert.equal(r.authorized, true);
  assert.equal(r.reason, 'global_admin');
});

test('authorizeRouteAssigner: member of a team responsible for the group is allowed', () => {
  const r = authorizeRouteAssigner({ isGlobalAdmin: false, memberTeamIds: [5, 9], groupTeamIds: [9] });
  assert.equal(r.authorized, true);
  assert.equal(r.viaTeamId, 9);
});

test('authorizeRouteAssigner: member of a NON-responsible team is denied', () => {
  const r = authorizeRouteAssigner({ isGlobalAdmin: false, memberTeamIds: [5], groupTeamIds: [9] });
  assert.equal(r.authorized, false);
  assert.equal(r.reason, 'not_responsible_team');
});

test('authorizeRouteAssigner: non-member and unassigned-group cases are denied', () => {
  assert.equal(authorizeRouteAssigner({ memberTeamIds: [], groupTeamIds: [9] }).reason, 'not_dispatch_member');
  assert.equal(authorizeRouteAssigner({ memberTeamIds: [5], groupTeamIds: [] }).reason, 'group_has_no_team');
});
