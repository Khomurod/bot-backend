const test = require('node:test');
const assert = require('node:assert/strict');
const { isCandidateLoadMessage } = require('../services/loadIngestionService');

test('isCandidateLoadMessage: PDF document', () => {
  assert.equal(
    isCandidateLoadMessage({
      document: { file_id: 'x', mime_type: 'application/pdf', file_name: 'rc.pdf' },
    }),
    true
  );
});

test('isCandidateLoadMessage: image photo array', () => {
  assert.equal(
    isCandidateLoadMessage({
      photo: [{ file_id: 's' }, { file_id: 'm' }, { file_id: 'l' }],
    }),
    true
  );
});

test('isCandidateLoadMessage: load-like caption without attachment', () => {
  assert.equal(
    isCandidateLoadMessage({
      caption: 'Load # 12345 Live/Live NJ>OH',
    }),
    true
  );
});

test('isCandidateLoadMessage: Load number without hash (caption only)', () => {
  assert.equal(
    isCandidateLoadMessage({
      caption: 'Load 418911\nLive-Drop\nMN>NJ',
    }),
    true
  );
});

test('isCandidateLoadMessage: ignores plain chatter', () => {
  assert.equal(
    isCandidateLoadMessage({
      text: 'See you tomorrow thanks',
    }),
    false
  );
});

test('isCandidateLoadMessage: null message', () => {
  assert.equal(isCandidateLoadMessage(null), false);
});
