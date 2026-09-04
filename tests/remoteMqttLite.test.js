/**
 * The remote page's hand-rolled MQTT client, at the byte level.
 *
 * `mqttLite()` inside server/public/remote.html speaks MQTT 3.1.1 over a
 * WebSocket with no library, because a phone remote should not pull tens of
 * kilobytes over hotel wifi for four packet types. That trade is only worth
 * making if the packets are RIGHT: a wrong remaining-length byte or a packet id
 * where QoS 0 forbids one is not a visible bug, it is a broker silently
 * dropping the connection while a presenter taps Next in front of a room.
 *
 * So this test slices the real function out of the page (between the
 * `mqtt-lite` markers) and runs it against a stub socket, asserting the bytes
 * against the spec by hand rather than against the implementation's own
 * encoder. It needs no browser, no broker, no env and no database.
 *
 * The protocol shape asserted here is fixed by the presentation file — if a
 * test below fails after an edit to the page, the page is wrong, not the test.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE = path.join(__dirname, '..', 'server', 'public', 'remote.html');

/** The real mqttLite source, lifted from the page. */
function loadMqttLite({ keepalive = 30, socketClass }) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const start = html.indexOf('/* mqtt-lite:start');
  const end = html.indexOf('/* mqtt-lite:end */');
  assert.ok(start > 0 && end > start, 'the mqtt-lite markers must still be in the page');
  const source = html.slice(start, end);
  assert.match(source, /function mqttLite\(/, 'the sliced region must contain mqttLite');

  // eslint-disable-next-line no-new-func -- deliberately running the shipped source
  const factory = new Function('WebSocket', 'RC_KEEPALIVE', `${source}\n;return mqttLite;`);
  return factory(socketClass, keepalive);
}

/** A WebSocket that records the bytes written to it and can be driven by hand. */
function stubSocket(record) {
  return class StubSocket {
    constructor(url, protocol) {
      record.url = url;
      record.protocol = protocol;
      record.socket = this;
      this.readyState = 0;
      this.sent = [];
      this.closed = false;
    }

    send(bytes) {
      if (this.readyState !== 1) throw new Error('socket is not open');
      this.sent.push(new Uint8Array(bytes));
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      if (this.onclose) this.onclose();
    }

    // ── test drivers ──
    open() {
      this.readyState = 1;
      if (this.onopen) this.onopen();
    }

    deliver(bytes) {
      const view = new Uint8Array(bytes);
      if (this.onmessage) this.onmessage({ data: view.buffer });
    }
  };
}

// ── an independent codec, so the test does not grade the page against itself ──

function remainingLength(n) {
  const out = [];
  let value = n;
  do {
    let byte = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 128;
    out.push(byte);
  } while (value > 0);
  return out;
}

function parsePacket(bytes) {
  let i = 1;
  let mult = 1;
  let len = 0;
  let byte;
  do {
    byte = bytes[i++];
    len += (byte & 127) * mult;
    mult *= 128;
  } while (byte & 128);
  return {
    type: bytes[0] >> 4,
    flags: bytes[0] & 15,
    body: bytes.subarray(i, i + len),
    length: len,
  };
}

/** A length-prefixed UTF-8 string at `off`, and where it ends. */
function readString(body, off) {
  const n = (body[off] << 8) | body[off + 1];
  return {
    text: Buffer.from(body.subarray(off + 2, off + 2 + n)).toString('utf8'),
    next: off + 2 + n,
  };
}

function encodePublish(topic, text) {
  const t = Buffer.from(topic, 'utf8');
  const p = Buffer.from(text, 'utf8');
  const body = [(t.length >> 8) & 255, t.length & 255, ...t, ...p];
  return [0x30, ...remainingLength(body.length), ...body];
}

/** Connect a client and hand back everything the test needs to drive it. */
function connected(opts = {}) {
  const record = {};
  const events = { connected: 0, closed: 0, errors: [], messages: [] };
  const mqttLite = loadMqttLite({ keepalive: opts.keepalive, socketClass: stubSocket(record) });

  const client = mqttLite('wss://broker.example:8084/mqtt', {
    onConnect: () => { events.connected += 1; },
    onMessage: (topic, text) => { events.messages.push({ topic, text }); },
    onError: (msg) => { events.errors.push(msg); },
    onClose: () => { events.closed += 1; },
  });

  record.socket.open();
  if (opts.connack !== false) {
    record.socket.deliver([0x20, 0x02, 0x00, opts.returnCode || 0x00]);
  }
  return { client, record, events, socket: record.socket };
}

// ── CONNECT ─────────────────────────────────────────────────────────────────

test('the socket is opened with the mqtt subprotocol', () => {
  const { client, record } = connected();
  try {
    assert.equal(record.url, 'wss://broker.example:8084/mqtt');
    assert.equal(record.protocol, 'mqtt', 'brokers reject a WebSocket without it');
  } finally {
    client.close(false);
  }
});

test('CONNECT is a spec-shaped MQTT 3.1.1 packet', () => {
  const { client, socket } = connected({ connack: false });
  try {
    assert.equal(socket.sent.length, 1, 'CONNECT is sent as soon as the socket opens');
    const pkt = parsePacket(socket.sent[0]);
    assert.equal(pkt.type, 1, 'packet type 1 = CONNECT');
    assert.equal(pkt.flags, 0, 'CONNECT has no flags');
    assert.equal(pkt.length, pkt.body.length, 'remaining length must match the body');

    const name = readString(pkt.body, 0);
    assert.equal(name.text, 'MQTT', 'protocol name');
    assert.equal(pkt.body[name.next], 4, 'protocol level 4 = MQTT 3.1.1');
    assert.equal(pkt.body[name.next + 1], 0x02, 'clean session, no will, no auth');
    const keepalive = (pkt.body[name.next + 2] << 8) | pkt.body[name.next + 3];
    assert.equal(keepalive, 30, 'keepalive 30s, as the presentation uses');

    const clientId = readString(pkt.body, name.next + 4);
    assert.match(clientId.text, /^wzl-[a-z0-9]+$/, 'a unique client id');
    assert.equal(clientId.next, pkt.body.length, 'nothing trails the payload');
  } finally {
    client.close(false);
  }
});

test('a client id is different every time, so two phones can both connect', () => {
  const first = connected({ connack: false });
  const second = connected({ connack: false });
  try {
    const idOf = (socket) => {
      const pkt = parsePacket(socket.sent[0]);
      const name = readString(pkt.body, 0);
      return readString(pkt.body, name.next + 4).text;
    };
    assert.notEqual(idOf(first.socket), idOf(second.socket));
  } finally {
    first.client.close(false);
    second.client.close(false);
  }
});

test('CONNACK 0 means connected', () => {
  const { client, events } = connected();
  try {
    assert.equal(events.connected, 1);
    assert.equal(client.alive, true);
    assert.deepEqual(events.errors, []);
  } finally {
    client.close(false);
  }
});

test('a refused CONNACK is reported and the socket is dropped', () => {
  // Return code 5 = not authorized. Treating this as connected would leave the
  // page waiting forever on a broker that will never answer.
  const { client, events, socket } = connected({ returnCode: 0x05 });
  assert.equal(events.connected, 0, 'onConnect must not fire');
  assert.equal(client.alive, false);
  assert.equal(events.errors.length, 1);
  assert.equal(socket.closed, true, 'and the failover can start');
});

// ── SUBSCRIBE / PUBLISH ─────────────────────────────────────────────────────

test('SUBSCRIBE carries a packet id, the topic and QoS 0', () => {
  const { client, socket } = connected();
  try {
    socket.sent.length = 0;
    assert.equal(client.subscribe('wzl/rc/1234/state'), true);

    const pkt = parsePacket(socket.sent[0]);
    assert.equal(pkt.type, 8, 'packet type 8 = SUBSCRIBE');
    assert.equal(pkt.flags, 2, 'SUBSCRIBE must set flags 0x02 or brokers reject it');
    const pid = (pkt.body[0] << 8) | pkt.body[1];
    assert.ok(pid > 0, 'a non-zero packet id is required');
    const topic = readString(pkt.body, 2);
    assert.equal(topic.text, 'wzl/rc/1234/state');
    assert.equal(pkt.body[topic.next], 0, 'requested QoS 0');
    assert.equal(topic.next + 1, pkt.body.length);
  } finally {
    client.close(false);
  }
});

test('PUBLISH at QoS 0 has no packet id — the classic wire-format mistake', () => {
  const { client, socket } = connected();
  try {
    socket.sent.length = 0;
    const payload = JSON.stringify({ type: 'cmd', action: 'next', at: 1770000000000 });
    assert.equal(client.publish('wzl/rc/1234/cmd', payload), true);

    const pkt = parsePacket(socket.sent[0]);
    assert.equal(pkt.type, 3, 'packet type 3 = PUBLISH');
    assert.equal(pkt.flags, 0, 'QoS 0, not retained, not duplicate');
    const topic = readString(pkt.body, 0);
    assert.equal(topic.text, 'wzl/rc/1234/cmd');
    // The payload starts immediately after the topic: no two id bytes between.
    assert.equal(Buffer.from(pkt.body.subarray(topic.next)).toString('utf8'), payload);
  } finally {
    client.close(false);
  }
});

test('a payload over 127 bytes gets a multi-byte remaining length', () => {
  const { client, socket } = connected();
  try {
    socket.sent.length = 0;
    const long = 'x'.repeat(400);
    client.publish('wzl/rc/1234/cmd', long);

    const bytes = socket.sent[0];
    assert.ok(bytes[1] & 128, 'the first length byte must set the continuation bit');
    const pkt = parsePacket(bytes);
    const topic = readString(pkt.body, 0);
    assert.equal(Buffer.from(pkt.body.subarray(topic.next)).toString('utf8'), long);
    assert.equal(pkt.length, pkt.body.length, 'declared length matches the body');
  } finally {
    client.close(false);
  }
});

test('publishing on a closed socket fails quietly instead of throwing', () => {
  // The pad calls this on every tap; a throw would break the button handler.
  const { client, socket } = connected();
  socket.readyState = 3;
  assert.equal(client.publish('wzl/rc/1234/cmd', '{}'), false);
  client.close(false);
});

// ── incoming PUBLISH, and the byte stream it arrives on ─────────────────────

test('an incoming PUBLISH is delivered as topic + text', () => {
  const { client, socket, events } = connected();
  try {
    const state = JSON.stringify({
      type: 'state', index: 3, total: 8, title: 'Cover', fullscreen: false, presenting: true,
    });
    socket.deliver(encodePublish('wzl/rc/1234/state', state));
    assert.deepEqual(events.messages, [{ topic: 'wzl/rc/1234/state', text: state }]);
  } finally {
    client.close(false);
  }
});

test('two packets in one frame both arrive', () => {
  // A WebSocket carries a byte stream, not one packet per frame.
  const { client, socket, events } = connected();
  try {
    socket.deliver([
      ...encodePublish('wzl/rc/1234/state', '{"type":"state","index":0}'),
      ...encodePublish('wzl/rc/1234/state', '{"type":"state","index":1}'),
    ]);
    assert.equal(events.messages.length, 2);
    assert.match(events.messages[0].text, /"index":0/);
    assert.match(events.messages[1].text, /"index":1/);
  } finally {
    client.close(false);
  }
});

test('a packet split across frames is buffered until it is whole', () => {
  const { client, socket, events } = connected();
  try {
    const packet = encodePublish('wzl/rc/1234/state', '{"type":"state","index":7,"total":8}');
    socket.deliver(packet.slice(0, 9));
    assert.equal(events.messages.length, 0, 'half a packet must not be parsed');
    socket.deliver(packet.slice(9));
    assert.equal(events.messages.length, 1, 'and must arrive once it completes');
    assert.match(events.messages[0].text, /"index":7/);
  } finally {
    client.close(false);
  }
});

test('a long payload split mid-length-prefix still parses', () => {
  const { client, socket, events } = connected();
  try {
    const packet = encodePublish('wzl/rc/1234/state', JSON.stringify({ type: 'state', pad: 'y'.repeat(300) }));
    socket.deliver(packet.slice(0, 2));   // stops inside the remaining-length bytes
    socket.deliver(packet.slice(2, 50));
    assert.equal(events.messages.length, 0);
    socket.deliver(packet.slice(50));
    assert.equal(events.messages.length, 1);
    assert.match(events.messages[0].text, /"type":"state"/);
  } finally {
    client.close(false);
  }
});

test('SUBACK and PINGRESP are ignored without breaking the stream', () => {
  const { client, socket, events } = connected();
  try {
    socket.deliver([0x90, 0x03, 0x00, 0x01, 0x00]);           // SUBACK
    socket.deliver([0xD0, 0x00]);                              // PINGRESP
    socket.deliver(encodePublish('wzl/rc/1234/state', '{"type":"bye"}'));
    assert.equal(events.messages.length, 1, 'the PUBLISH after them still arrives');
    assert.equal(events.messages[0].text, '{"type":"bye"}');
  } finally {
    client.close(false);
  }
});

test('a text frame is ignored — this protocol is binary', () => {
  const { client, socket, events } = connected();
  try {
    socket.onmessage({ data: 'not a packet' });
    assert.equal(events.messages.length, 0);
  } finally {
    client.close(false);
  }
});

// ── keepalive and shutdown ──────────────────────────────────────────────────

test('PINGREQ goes out on the keepalive timer', async () => {
  // Half the keepalive, so one lost PINGRESP does not cost the session.
  const { client, socket } = connected({ keepalive: 0.05 });
  try {
    socket.sent.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 90));
    const pings = socket.sent.filter((b) => b[0] === 0xC0 && b[1] === 0x00);
    assert.ok(pings.length >= 1, `expected a PINGREQ, sent ${socket.sent.length} packet(s)`);
  } finally {
    client.close(false);
  }
});

test('close(true) says goodbye; close(false) just goes', () => {
  const graceful = connected();
  graceful.socket.sent.length = 0;
  graceful.client.close(true);
  assert.deepEqual(Array.from(graceful.socket.sent[0] || []), [0xE0, 0x00], 'DISCONNECT');
  assert.equal(graceful.socket.closed, true);

  const abrupt = connected();
  abrupt.socket.sent.length = 0;
  abrupt.client.close(false);
  assert.equal(abrupt.socket.sent.length, 0, 'a dead broker gets no DISCONNECT');
  assert.equal(abrupt.socket.closed, true);
});

test('closing twice is harmless, and the ping timer stops', async () => {
  const { client, socket, events } = connected({ keepalive: 0.05 });
  client.close(true);
  client.close(true);
  socket.sent.length = 0;
  await new Promise((resolve) => setTimeout(resolve, 90));
  assert.equal(socket.sent.length, 0, 'no packet may be sent after close');
  assert.equal(events.closed, 1, 'onClose fires exactly once');
  assert.equal(client.alive, false);
});

test('a socket that closes on its own reports it once', () => {
  const { client, socket, events } = connected();
  socket.close();
  assert.equal(events.closed, 1);
  assert.equal(client.alive, false, 'so the page stops publishing into a dead link');
});
