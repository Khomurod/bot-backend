'use strict';

/*
 * Presenter remote — the MQTT 3.1.1 client.
 *
 * Extracted from server/public/remote.html when the page passed the
 * repository's 500-line limit. The FUNCTION BODY IS UNCHANGED, and the
 * `mqtt-lite:start/end` markers moved with it: tests/remoteMqttLite.test.js
 * slices between them and runs the real thing against a stub socket, asserting
 * the packet bytes against the spec by hand.
 *
 * Loaded as a plain script BEFORE remote-app.js, which calls `mqttLite` as a
 * global. No module system on purpose — a phone remote should not need a
 * bundler to open.
 */

var RC_KEEPALIVE = 30;          // seconds, MQTT-level

  /* mqtt-lite:start — tests/remoteMqttLite.test.js slices between these two
     markers and runs the real thing against a stub socket. Byte-level protocol
     code that nothing executes before a live talk is code that does not work. */

  /* ---------- mqttLite: MQTT 3.1.1 over WebSocket, no dependencies ----------
   *
   * Only what this remote needs: CONNECT, SUBSCRIBE, PUBLISH at QoS 0, and
   * PINGREQ. A library would be a few tens of kilobytes over a phone
   * connection for the four packet types below.
   *
   * Incoming frames are BUFFERED rather than parsed one-frame-one-packet: a
   * WebSocket carries a byte stream, so a frame can hold half a packet or two
   * of them, and "it worked in testing" is how that bug ships.
   */
  function mqttLite(url, opts) {
    var textEnc = new TextEncoder();
    var textDec = new TextDecoder();
    var ws = new WebSocket(url, 'mqtt');
    ws.binaryType = 'arraybuffer';

    var api = { publish: publish, subscribe: subscribe, close: close, alive: false };
    var buf = new Uint8Array(0);
    var pingTimer = null;
    var nextPid = 1;
    var done = false;

    function remainingLength(n) {
      var out = [];
      do {
        var b = n % 128;
        n = Math.floor(n / 128);
        if (n > 0) b |= 128;
        out.push(b);
      } while (n > 0);
      return out;
    }

    function utf8(s) {
      var b = textEnc.encode(s);
      return [(b.length >> 8) & 255, b.length & 255].concat(Array.prototype.slice.call(b));
    }

    function send(bytes) {
      if (ws.readyState !== 1) return false;
      try { ws.send(new Uint8Array(bytes)); return true; } catch (e) { return false; }
    }

    function packet(first, body) {
      return [first].concat(remainingLength(body.length), body);
    }

    function publish(topic, text) {
      return send(packet(0x30, utf8(topic).concat(Array.prototype.slice.call(textEnc.encode(text)))));
    }

    function subscribe(topic) {
      var pid = nextPid++ & 0xffff;
      return send(packet(0x82, [(pid >> 8) & 255, pid & 255].concat(utf8(topic), [0])));
    }

    function close(graceful) {
      if (done) return;
      done = true;
      if (pingTimer) clearInterval(pingTimer);
      try { if (graceful && ws.readyState === 1) send([0xE0, 0x00]); } catch (e) { /* closing anyway */ }
      try { ws.close(); } catch (e) { /* already gone */ }
    }

    /** One decoded packet, or null while the buffer is still short. */
    function takePacket() {
      if (buf.length < 2) return null;
      var mult = 1, len = 0, i = 1, byte;
      do {
        if (i >= buf.length) return null;
        byte = buf[i++];
        len += (byte & 127) * mult;
        mult *= 128;
        if (mult > 128 * 128 * 128 * 2) return null; // malformed length
      } while (byte & 128);
      var total = i + len;
      if (buf.length < total) return null;
      var pkt = { type: buf[0] >> 4, flags: buf[0] & 15, body: buf.subarray(i, total) };
      buf = buf.slice(total);
      return pkt;
    }

    function handle(pkt) {
      if (pkt.type === 2) {                       // CONNACK
        if (pkt.body.length < 2 || pkt.body[1] !== 0) {
          if (opts.onError) opts.onError('broker refused the connection');
          close(false);
          return;
        }
        api.alive = true;
        // Half the keepalive: one lost PINGRESP must not cost the session.
        pingTimer = setInterval(function () { send([0xC0, 0x00]); }, (RC_KEEPALIVE / 2) * 1000);
        if (opts.onConnect) opts.onConnect(api);
        return;
      }
      if (pkt.type === 3) {                       // PUBLISH
        var qos = (pkt.flags >> 1) & 3;
        var tLen = (pkt.body[0] << 8) | pkt.body[1];
        var topic = textDec.decode(pkt.body.subarray(2, 2 + tLen));
        var off = 2 + tLen + (qos > 0 ? 2 : 0);   // QoS 0 carries no packet id
        if (opts.onMessage) opts.onMessage(topic, textDec.decode(pkt.body.subarray(off)));
      }
      /* SUBACK (9) and PINGRESP (13) need no action: QoS 0 has nothing to
         confirm, and the ping only had to leave. */
    }

    ws.onmessage = function (ev) {
      if (typeof ev.data === 'string') return;
      var chunk = new Uint8Array(ev.data);
      var merged = new Uint8Array(buf.length + chunk.length);
      merged.set(buf, 0);
      merged.set(chunk, buf.length);
      buf = merged;
      for (var pkt = takePacket(); pkt; pkt = takePacket()) handle(pkt);
    };

    ws.onopen = function () {
      var clientId = 'wzl-' + Math.random().toString(36).slice(2, 10);
      // 0x02 = clean session. No will, no auth: the topic is public either way.
      send(packet(0x10, utf8('MQTT').concat(
        [4, 0x02, (RC_KEEPALIVE >> 8) & 255, RC_KEEPALIVE & 255],
        utf8(clientId)
      )));
    };

    ws.onerror = function () { if (opts.onError) opts.onError('broker unreachable'); };
    ws.onclose = function () {
      api.alive = false;
      if (pingTimer) clearInterval(pingTimer);
      if (opts.onClose) opts.onClose();
    };

    return api;
  }

  /* mqtt-lite:end */
