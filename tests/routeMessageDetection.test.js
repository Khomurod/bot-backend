const test = require('node:test');
const assert = require('node:assert/strict');
const {
  detectRouteAssignment,
  classifyMapsLink,
  hasRouteKeyword,
  looksLikeFuelOrNonRoute,
  shouldReplyOnUnparseable,
  authorizeRouteAssigner,
} = require('../services/routeMessageDetection');

test('classifyMapsLink distinguishes directions / short / place', () => {
  assert.equal(classifyMapsLink('https://www.google.com/maps/dir/A/B/@1,2,7z'), 'directions');
  assert.equal(classifyMapsLink('https://www.google.com/maps/dir/?api=1&origin=A&destination=B'), 'directions');
  assert.equal(classifyMapsLink('https://maps.app.goo.gl/AbCdEf123'), 'short');
  assert.equal(classifyMapsLink('https://www.google.com/maps/place/SomeStore'), 'place');
  assert.equal(classifyMapsLink('https://maps.google.com/?q=41.7,-86.3'), 'place');
});

test('a full directions link is a route candidate (no keyword needed)', () => {
  const d = detectRouteAssignment('https://www.google.com/maps/dir/Chicago/Dallas/@1,2,6z/data=x');
  assert.equal(d.isCandidate, true);
  assert.equal(d.linkKind, 'directions');
});

test('a real /maps/dir/ directions link is a candidate', () => {
  const d = detectRouteAssignment(
    'https://www.google.com/maps/dir/Atlanta,GA/Miami,FL/@28.5,-81.3,7z/data=!4m2'
  );
  assert.equal(d.isCandidate, true);
  assert.equal(d.linkKind, 'directions');
});

test('a shortened maps.app.goo.gl link ALONE (no keyword) is NOT a candidate', () => {
  const d = detectRouteAssignment('here you go https://maps.app.goo.gl/ELB6VP2bJcQSZXj37');
  assert.equal(d.isCandidate, false);
});

test('a shortened link WITH "use this route" is a candidate', () => {
  const d = detectRouteAssignment('please use this route https://maps.app.goo.gl/ELB6VP2bJcQSZXj37');
  assert.equal(d.isCandidate, true);
  assert.equal(d.linkKind, 'short');
  assert.equal(d.hasKeyword, true);
});

test('a plain place / pin link WITHOUT a route keyword is ignored', () => {
  const d = detectRouteAssignment('here is the spot https://www.google.com/maps/place/SomeStore');
  assert.equal(d.isCandidate, false);
});

test('"route control please use this route" + link is a candidate', () => {
  const d = detectRouteAssignment(
    'route control please use this route https://maps.app.goo.gl/ELB6VP2bJcQSZXj37'
  );
  assert.equal(d.isCandidate, true);
  assert.equal(d.hasKeyword, true);
});

test('a location pin WITH a route keyword becomes a candidate', () => {
  const d = detectRouteAssignment('take this route https://www.google.com/maps/place/SomeStore');
  assert.equal(d.isCandidate, true);
  assert.equal(d.hasKeyword, true);
});

test('a non-Google link is never a candidate', () => {
  assert.equal(detectRouteAssignment('https://example.com/maps/dir/A/B').isCandidate, false);
  assert.equal(detectRouteAssignment('no link at all, just route talk').isCandidate, false);
});

test('the word "route" ALONE (no strong phrase, no link) is not a candidate', () => {
  assert.equal(detectRouteAssignment('are you on your route or not?').isCandidate, false);
});

// ── Fuel / non-route guard ──

test('a Fuel Monitoring message with a maps.app.goo.gl pin is NOT a route candidate', () => {
  const d = detectRouteAssignment(
    'Fuel Monitoring Department\nplease fuel up here whether on your route or not '
    + 'https://maps.app.goo.gl/nfC9vyrCuCddTqJT6'
  );
  assert.equal(d.isCandidate, false);
  assert.equal(d.reason, 'fuel_or_non_route');
});

test('a screenshot-style fuel message (header + $250 charge + short link) is NOT a candidate', () => {
  const d = detectRouteAssignment(
    'Fuel Monitoring Department\nUse this fuel stop. Do not use different location '
    + 'or a $250 charge applies. https://maps.app.goo.gl/nfC9vyrCuCddTqJT6'
  );
  assert.equal(d.isCandidate, false);
  assert.equal(d.reason, 'fuel_or_non_route');
});

test('looksLikeFuelOrNonRoute catches fuel + travel-stop wording, ignores plain route talk', () => {
  assert.equal(looksLikeFuelOrNonRoute('Fuel Monitoring Department'), true);
  assert.equal(looksLikeFuelOrNonRoute('please fuel up at the Flying J'), true);
  assert.equal(looksLikeFuelOrNonRoute('loves travel stop exit 12'), true);
  assert.equal(looksLikeFuelOrNonRoute('$250 charge if you skip it'), true);
  assert.equal(looksLikeFuelOrNonRoute('please use this route'), false);
});

test('hasRouteKeyword matches strong phrases only (not the bare word "route")', () => {
  assert.equal(hasRouteKeyword('please use this route'), true);
  assert.equal(hasRouteKeyword('DRIVER ROUTE below'), true);
  assert.equal(hasRouteKeyword('route control'), true);
  assert.equal(hasRouteKeyword('are you on your route or not?'), false);
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
