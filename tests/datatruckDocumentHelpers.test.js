const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isTrackedDocumentType,
  trackedDocumentTypes,
  normalizeUnitNumber,
  extractOrderUnit,
  extractOrderDriverNames,
  extractDocumentUploaderName,
  buildDocumentSignature,
  extractTrackedDocuments,
  buildGroupMatchIndex,
  matchDocumentToGroup,
  buildDocumentCaption,
  buildDocumentFilename,
  resolveDocumentUrl,
  guessFileExtension,
} = require('../services/datatruckDocumentHelpers');

test('only bill_of_lading and proof_of_delivery are tracked', () => {
  assert.deepEqual(trackedDocumentTypes().sort(), ['bill_of_lading', 'proof_of_delivery']);
  assert.equal(isTrackedDocumentType('bill_of_lading'), true);
  assert.equal(isTrackedDocumentType('PROOF_OF_DELIVERY'), true);
  assert.equal(isTrackedDocumentType('rate_confirmation'), false);
  assert.equal(isTrackedDocumentType('commercial_invoice'), false);
  assert.equal(isTrackedDocumentType(''), false);
});

test('normalizeUnitNumber strips leading zeros and non-digits', () => {
  assert.equal(normalizeUnitNumber('008'), '8');
  assert.equal(normalizeUnitNumber('2614'), '2614');
  assert.equal(normalizeUnitNumber('UNIT 045'), '45');
  assert.equal(normalizeUnitNumber('0'), '0');
  assert.equal(normalizeUnitNumber(''), null);
  assert.equal(normalizeUnitNumber(null), null);
});

test('extractOrderUnit / extractOrderDriverNames read documented and legacy order shapes', () => {
  const order = {
    truck__unit_number: null,
    driver__full_name: 'Terrell Dalton',
    assigned_driver_n_truck: { driver_full_name: 'Primary Driver' },
    trip: {
      truck__unit_number: '2614',
      driver__full_name: 'Terrell Dalton',
      team_driver__full_name: 'Sam Doe',
    },
  };
  assert.equal(extractOrderUnit(order), '2614');
  assert.deepEqual(extractOrderDriverNames(order), ['Primary Driver', 'Terrell Dalton', 'Sam Doe']);
});

test('extractDocumentUploaderName supports string and object API shapes', () => {
  assert.equal(extractDocumentUploaderName({ uploaded_by: 'Terrell Dalton' }), 'Terrell Dalton');
  assert.equal(extractDocumentUploaderName({ uploaded_by: { full_name: 'Sam Doe' } }), 'Sam Doe');
  assert.equal(extractDocumentUploaderName({ uploaded_by: { first_name: 'Jane', last_name: 'Driver' } }), 'Jane Driver');
  assert.equal(extractDocumentUploaderName({ uploaded_by: null }), null);
});

test('extractTrackedDocuments filters to BOL/POD with stable signatures', () => {
  const order = {
    id: 12345,
    load_id: 'L-987',
    trip: { truck__unit_number: '008', driver__full_name: 'Abdinasir Ibrahim' },
    documents: [
      { file_type: 'rate_confirmation', file_link: 'https://x/rc.pdf', uploaded_at: '2026-06-01T10:00:00Z' },
      { file_type: 'bill_of_lading', file_link: 'https://x/bol.pdf', uploaded_by: 'Jane', uploaded_at: '2026-06-02T12:00:00Z' },
      { file_type: 'proof_of_delivery', file_link: 'https://x/pod.pdf', uploaded_at: '2026-06-03T08:30:00Z' },
      { file_type: 'bill_of_lading', file_link: '', uploaded_at: '2026-06-02T12:00:00Z' }, // no link → skipped
    ],
  };
  const docs = extractTrackedDocuments(order);
  assert.equal(docs.length, 2);
  assert.deepEqual(docs.map((d) => d.fileType), ['bill_of_lading', 'proof_of_delivery']);
  assert.equal(docs[0].loadReference, 'L-987');
  assert.equal(docs[0].unitNumber, '008');
  assert.deepEqual(docs[0].driverNames, ['Abdinasir Ibrahim']);
  assert.equal(docs[0].uploadedBy, 'Jane');
  // Signatures are deterministic across calls.
  const again = extractTrackedDocuments(order);
  assert.deepEqual(docs.map((d) => d.signature), again.map((d) => d.signature));
  assert.equal(docs[0].signature, buildDocumentSignature({
    orderId: '12345', fileType: 'bill_of_lading', uploadedAt: '2026-06-02T12:00:00Z', seq: 0,
  }));
});

test('documents with identical type+timestamp get distinct signatures via seq', () => {
  const order = {
    id: 7,
    documents: [
      { file_type: 'bill_of_lading', file_link: 'https://x/a.pdf', uploaded_at: '2026-06-03T08:30:00Z' },
      { file_type: 'bill_of_lading', file_link: 'https://x/b.pdf', uploaded_at: '2026-06-03T08:30:00Z' },
    ],
  };
  const docs = extractTrackedDocuments(order);
  assert.equal(docs.length, 2);
  assert.notEqual(docs[0].signature, docs[1].signature);
});

test('returns [] when no documents present', () => {
  assert.deepEqual(extractTrackedDocuments({ id: 1 }), []);
  assert.deepEqual(extractTrackedDocuments({ id: 1, documents: [] }), []);
});

const directory = [
  {
    group_type: 'driver',
    group_id: 10,
    group_name: 'WENZE UNIT # 008 ABDINASIR / IBRAHIM (COMPANY DRIVERS)',
    telegram_group_id: '-100008',
    group_active: true,
    inactive: false,
    operational_visible: true,
    unit_number: '008',
    normalized_driver_key: 'abdinasir|ibrahim',
  },
  {
    group_type: 'driver',
    group_id: 20,
    group_name: 'WENZE UNIT # 2614 TERRELL DALTON',
    telegram_group_id: '-1002614',
    group_active: true,
    inactive: false,
    operational_visible: true,
    unit_number: '2614',
    normalized_driver_key: 'terrell dalton',
  },
  {
    group_type: 'driver',
    group_id: 30,
    group_name: 'WENZE UNIT # 999 OLD DRIVER (INACTIVE)',
    telegram_group_id: '-1000999',
    group_active: false,
    inactive: true,
    operational_visible: false,
    unit_number: '999',
    normalized_driver_key: 'old driver',
  },
];

test('buildGroupMatchIndex indexes only active reachable driver groups', () => {
  const index = buildGroupMatchIndex(directory);
  assert.equal(Object.prototype.hasOwnProperty.call(index, 'byUnit'), false);
  assert.equal(index.byNameKey.has('terrell dalton'), true);
  assert.equal(index.byNameKey.has('abdinasir'), true);
  assert.equal(index.byNameKey.has('old driver'), false);
});

test('matchDocumentToGroup uses uploader then assigned driver name, never unit number', () => {
  const index = buildGroupMatchIndex(directory);

  const unitOnly = matchDocumentToGroup({ unitNumber: '008', driverNames: ['Someone Else'] }, index);
  assert.equal(unitOnly, null);

  const byName = matchDocumentToGroup({ unitNumber: null, driverNames: ['Terrell Dalton'] }, index);
  assert.equal(byName.matchedBy, 'name');
  assert.equal(byName.group.group_id, 20);

  const teamMember = matchDocumentToGroup({ unitNumber: '', driverNames: ['Ibrahim'] }, index);
  assert.equal(teamMember.group.group_id, 10);

  const uploaderWins = matchDocumentToGroup({
    unitNumber: '008',
    uploadedBy: 'Terrell Dalton',
    driverNames: ['Abdinasir'],
  }, index);
  assert.equal(uploaderWins.group.group_id, 20);
  assert.equal(uploaderWins.matchedBy, 'name');

  assert.equal(matchDocumentToGroup({ unitNumber: '777', driverNames: ['Nobody Here'] }, index), null);
  // Inactive group is never matched even by exact name.
  assert.equal(matchDocumentToGroup({ unitNumber: '999', driverNames: ['Old Driver'] }, index), null);
});

test('resolveDocumentUrl prepends the media base to relative keys', () => {
  const base = 'https://tms-datatruck.s3-accelerate.amazonaws.com/static/';
  assert.equal(
    resolveDocumentUrl('2026/6/27/abc/merged.pdf', base),
    'https://tms-datatruck.s3-accelerate.amazonaws.com/static/2026/6/27/abc/merged.pdf'
  );
  // Tolerates a leading slash on the key and a missing trailing slash on base.
  assert.equal(
    resolveDocumentUrl('/2026/6/27/abc/merged.pdf', 'https://x/static'),
    'https://x/static/2026/6/27/abc/merged.pdf'
  );
  // Already-absolute links pass through unchanged.
  assert.equal(resolveDocumentUrl('https://x/doc.pdf', base), 'https://x/doc.pdf');
  assert.equal(resolveDocumentUrl('', base), null);
  assert.equal(resolveDocumentUrl(null, base), null);
});

test('BOL and POD captions and filenames are well-formed and HTML-escaped', () => {
  const caption = buildDocumentCaption({
    fileType: 'bill_of_lading',
    loadReference: 'L-9 & 8',
    driverNames: ['Abdinasir', 'Ibrahim'],
    uploadedBy: 'Jane <ops>',
    uploadedAt: '2026-06-03T08:30:00Z',
  });
  assert.match(caption, /Bill of Lading \(BOL\)/);
  assert.match(caption, /Load #L-9 &amp; 8/);
  assert.match(caption, /Abdinasir \/ Ibrahim/);
  assert.match(caption, /Jane &lt;ops&gt;/);
  assert.ok(!caption.includes('<ops>'));

  const podCaption = buildDocumentCaption({ fileType: 'proof_of_delivery' });
  assert.match(podCaption, /Proof of Delivery \(POD\)/);

  assert.equal(
    buildDocumentFilename({ fileType: 'bill_of_lading', loadReference: 'L-987', fileLink: 'https://x/file.pdf?sig=abc' }),
    'BOL_L-987.pdf'
  );
  assert.equal(
    buildDocumentFilename({ fileType: 'proof_of_delivery', loadReference: 'L-987', fileLink: 'https://x/file.pdf' }),
    'POD_L-987.pdf'
  );
  assert.equal(guessFileExtension('https://x/scan.PNG?token=1'), '.png');
  assert.equal(guessFileExtension('https://x/nofileext'), '.pdf');
});
