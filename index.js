const http = require('http');
const mqtt = require('mqtt');

const vehicles = new Map();
const missedUpdates = new Map();
const MAX_MISSED = 2;
let busCache = null;

function rebuildCache() {
    busCache = JSON.stringify(Array.from(vehicles.values()));
}

class PBReader {
    constructor(buf) { this.buf = buf; this.pos = 0; }
    readVarint() {
        let result = 0n, shift = 0n;
        while (true) {
            const b = this.buf[this.pos++];
            result |= BigInt(b & 0x7f) << shift;
            if ((b & 0x80) === 0) break;
            shift += 7n;
        }
        return result;
    }
    readTag()    { const tag = this.readVarint(); return { fieldNum: Number(tag >> 3n), wireType: Number(tag & 0x7n) }; }
    skip(wireType) {
        switch (wireType) {
            case 0: this.readVarint(); break;
            case 1: this.pos += 8; break;
            case 2: { const len = Number(this.readVarint()); this.pos += len; break; }
            case 5: this.pos += 4; break;
            default: throw new Error('Unknown wire type ' + wireType);
        }
    }
    readBytes()  { const len = Number(this.readVarint()); const out = Buffer.from(this.buf).slice(this.pos, this.pos + len); this.pos += len; return out; }
    readString() { return this.readBytes().toString('utf8'); }
    readFloat()  { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
    readDouble() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
    eof()        { return this.pos >= this.buf.length; }
}

function parseVehiclePosition(buf) {
    const reader = new PBReader(buf);
    let result = null;
    while (!reader.eof()) {
        const { fieldNum, wireType } = reader.readTag();
        if (fieldNum === 2 && wireType === 2) result = parseEntity(reader.readBytes());
        else reader.skip(wireType);
    }
    return result;
}
function parseEntity(buf) {
    const reader = new PBReader(buf);
    const out = { id: null, vehicle: null };
    while (!reader.eof()) {
        const { fieldNum, wireType } = reader.readTag();
        if      (fieldNum === 1 && wireType === 2) out.id = reader.readString();
        else if (fieldNum === 4 && wireType === 2) out.vehicle = parseVehicle(reader.readBytes());
        else reader.skip(wireType);
    }
    return out;
}
function parseVehicle(buf) {
    const reader = new PBReader(buf);
    const out = { trip: null, position: null, timestamp: null, vehicle: null };
    while (!reader.eof()) {
        const { fieldNum, wireType } = reader.readTag();
        if      (fieldNum === 1 && wireType === 2) out.trip      = parseTrip(reader.readBytes());
        else if (fieldNum === 2 && wireType === 2) out.position  = parsePosition(reader.readBytes());
        else if (fieldNum === 5 && wireType === 0) out.timestamp = Number(reader.readVarint());
        else if (fieldNum === 8 && wireType === 2) out.vehicle   = parseVehicleDescriptor(reader.readBytes());
        else reader.skip(wireType);
    }
    return out;
}
function parseTrip(buf) {
    const reader = new PBReader(buf);
    const out = { tripId: null, routeId: null, directionId: null };
    while (!reader.eof()) {
        const { fieldNum, wireType } = reader.readTag();
        if      (fieldNum === 1 && wireType === 2) out.tripId      = reader.readString();
        else if (fieldNum === 5 && wireType === 2) out.routeId     = reader.readString();
        else if (fieldNum === 6 && wireType === 0) out.directionId = Number(reader.readVarint());
        else reader.skip(wireType);
    }
    return out;
}
function parsePosition(buf) {
    const reader = new PBReader(buf);
    const out = { latitude: null, longitude: null, bearing: null, speed: null };
    while (!reader.eof()) {
        const { fieldNum, wireType } = reader.readTag();
        if      (fieldNum === 1 && wireType === 5) out.latitude  = reader.readFloat();
        else if (fieldNum === 2 && wireType === 5) out.longitude = reader.readFloat();
        else if (fieldNum === 3 && wireType === 5) out.bearing   = reader.readFloat();
        else if (fieldNum === 5 && wireType === 5) out.speed     = reader.readFloat();
        else reader.skip(wireType);
    }
    return out;
}
function parseVehicleDescriptor(buf) {
    const reader = new PBReader(buf);
    const out = { id: null };
    while (!reader.eof()) {
        const { fieldNum, wireType } = reader.readTag();
        if (fieldNum === 1 && wireType === 2) out.id = reader.readString();
        else reader.skip(wireType);
    }
    return out;
}

function isPrintable(buf) {
    if (!buf.length) return false;
    const s = buf.toString('utf8');
    return !s.includes('\uFFFD') && /^[\x20-\x7e\u00a0-\uffff]+$/.test(s);
}

function dumpProto(buf, depth = 0) {
    const r = new PBReader(buf);
    const out = [];
    try {
        while (!r.eof()) {
            const { fieldNum, wireType } = r.readTag();
            if (fieldNum < 1) return null;
            let value;
            switch (wireType) {
                case 0: value = r.readVarint().toString(); break;
                case 1: value = { f64: r.readDouble() }; break;
                case 5: {
                    const p = r.pos;
                    value = { f32: r.buf.readFloatLE(p), u32: r.buf.readUInt32LE(p) };
                    r.pos += 4;
                    break;
                }
                case 2: {
                    const bytes = r.readBytes();
                    if (isPrintable(bytes)) value = bytes.toString('utf8');
                    else {
                        const nested = depth < 8 ? dumpProto(bytes, depth + 1) : null;
                        value = nested && nested.length ? nested : { hex: bytes.toString('hex') };
                    }
                    break;
                }
                default: return null;
            }
            if (r.pos > buf.length) return null;
            out.push({ field: fieldNum, wire: wireType, value });
        }
    } catch { return null; }
    return out;
}

function topicMatches(filter, topic) {
    const f = filter.split('/'), t = topic.split('/');
    for (let i = 0; i < f.length; i++) {
        if (f[i] === '#') return true;
        if (i >= t.length) return false;
        if (f[i] !== '+' && f[i] !== t[i]) return false;
    }
    return f.length === t.length;
}

function topicInfo(topic) {
    const p = topic.split('/');
    return { feed: p[2] ?? '?', operator: p[3] ?? '?', mode: p[6] ?? '?' };
}

const TESTS = {
    test1: { filter: '/gtfsrt/vp/#',            desc: 'vp: ALL operators + modes' },
    test2: { filter: '/gtfsrt/tu/#',            desc: 'tu: ALL operators + modes' },
    test3: { filter: '/gtfsrt/tu/2///BUS/#',    desc: 'tu: operator 2, BUS (guessed pattern)' },
    test4: { filter: '/gtfsrt/vp/1///SUBWAY/#', desc: 'vp: operator 1, SUBWAY (metro)' },
    test5: { filter: '/gtfsrt/tu/1///SUBWAY/#', desc: 'tu: operator 1, SUBWAY (guessed pattern)' },
    test6: { filter: '/gtfsrt/vp/2///+/#',      desc: 'vp: operator 2, any mode' },
    test7: { filter: '/gtfsrt/vp/+///BUS/#',    desc: 'vp: any operator, BUS' },
    test8: { filter: '/gtfsrt/#',               desc: 'EVERYTHING under /gtfsrt (heavy, shows other feeds too)' },
};

const SAMPLE_LIMIT = 20;
for (const [name, t] of Object.entries(TESTS)) {
    t.name = name;
    t.active = false;
    t.reset = function () {
        this.count = 0; this.bytes = 0;
        this.firstAt = null; this.lastAt = null;
        this.breakdown = new Map();
        this.samples = [];
    };
    t.reset();
}

function recordTestMessage(topic, payload) {
    const now = Date.now();
    const info = topicInfo(topic);
    const key = `${info.feed}|op=${info.operator}|mode=${info.mode}`;
    for (const t of Object.values(TESTS)) {
        if (!t.active || !topicMatches(t.filter, topic)) continue;
        t.count++;
        t.bytes += payload.length;
        t.firstAt ??= now;
        t.lastAt = now;
        t.breakdown.set(key, (t.breakdown.get(key) ?? 0) + 1);
        t.samples.push({ topic, at: now, payload });
        if (t.samples.length > SAMPLE_LIMIT) t.samples.shift();
    }
}

function activateTest(t) {
    if (t.active) return;
    t.active = true;
    client.subscribe(t.filter, (err) => {
        if (err) { console.error(`[${t.name}] subscribe failed:`, err.message); t.active = false; }
        else console.log(`[${t.name}] subscribed ${t.filter}`);
    });
}

function deactivateTest(t) {
    if (!t.active) return;
    t.active = false;
    const stillUsed = Object.values(TESTS).some(o => o !== t && o.active && o.filter === t.filter) || t.filter === BUS_FILTER;
    if (!stillUsed) client.unsubscribe(t.filter);
    console.log(`[${t.name}] stopped`);
}

function testReport(t, limit) {
    const samples = t.samples.slice(-limit).map(s => {
        const info = topicInfo(s.topic);
        let decoded = null;
        if (info.feed === 'vp') {
            try { decoded = parseVehiclePosition(s.payload); } catch {}
        }
        return {
            topic: s.topic,
            at: new Date(s.at).toISOString(),
            bytes: s.payload.length,
            decodedAsVehiclePosition: decoded,
            generic: dumpProto(s.payload),
            base64: s.payload.toString('base64')
        };
    });
    return {
        test: t.name,
        filter: t.filter,
        desc: t.desc,
        active: t.active,
        messages: t.count,
        bytes: t.bytes,
        firstAt: t.firstAt && new Date(t.firstAt).toISOString(),
        lastAt: t.lastAt && new Date(t.lastAt).toISOString(),
        breakdown: Object.fromEntries([...t.breakdown.entries()].sort((a, b) => b[1] - a[1])),
        samples
    };
}

const BUS_FILTER = '/gtfsrt/vp/2///BUS/#';

const client = mqtt.connect('wss://mmt.portodigital.pt/websocket/', {
    protocol: 'wss',
    wsOptions: { headers: { Origin: 'https://explore.porto.pt' } },
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 2000
});

client.on('connect', () => {
    console.log('Connected');
    client.subscribe(BUS_FILTER);
    for (const t of Object.values(TESTS)) if (t.active) client.subscribe(t.filter);
});

let seenThisCycle = new Set();
let cycleTimer = null;

function handleBusMessage(payload) {
    try {
        const entity = parseVehiclePosition(payload);
        const v = entity?.vehicle;
        if (v?.position?.latitude != null && v?.position?.longitude != null) {
            const id = v.vehicle?.id || entity.id;
            seenThisCycle.add(id);
            vehicles.set(id, {
                id,
                directionId:    v.trip?.directionId ?? null,
                routeId:        v.trip?.routeId     ?? null,
                routeShortName: v.trip?.routeId     ?? null,
                lat:            v.position.latitude,
                lng:            v.position.longitude,
                speed:          v.position.speed    ?? 0,
                bearing:        v.position.bearing  ?? 0,
                timestamp:      v.timestamp         ?? null,
                tripId:         v.trip?.tripId      ?? null
            });
            missedUpdates.set(id, 0);
        }
    } catch (e) {
        console.error('Error parsing GTFS-RT payload:', e.message);
    }

    clearTimeout(cycleTimer);
    cycleTimer = setTimeout(() => {
        for (const id of vehicles.keys()) {
            if (!seenThisCycle.has(id)) {
                const missed = (missedUpdates.get(id) ?? 0) + 1;
                if (missed >= MAX_MISSED) {
                    vehicles.delete(id);
                    missedUpdates.delete(id);
                } else {
                    missedUpdates.set(id, missed);
                }
            }
        }
        seenThisCycle = new Set();
        rebuildCache();
        console.log(`Cycle done. Active vehicles: ${vehicles.size}`);
    }, 3000);
}

client.on('message', (topic, payload) => {
    recordTestMessage(topic, payload);

    if (topicMatches(BUS_FILTER, topic)) handleBusMessage(payload);
});

client.on('error', (e) => console.error('MQTT error:', e.message));

const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

function sendJson(res, status, obj) {
    res.writeHead(status, CORS);
    res.end(JSON.stringify(obj, null, 2));
}

async function proxyJson(res, targetUrl) {
    try {
        const r = await fetch(targetUrl);
        const data = await r.text();
        res.writeHead(r.status, CORS);
        res.end(data);
    } catch (e) {
        res.writeHead(502, CORS);
        res.end(JSON.stringify({ error: e.message }));
    }
}

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        res.end();
        return;
    }

    if (url.pathname === '/tests') {
        return sendJson(res, 200, Object.values(TESTS).map(t => ({
            test: t.name, filter: t.filter, desc: t.desc, active: t.active, messages: t.count
        })));
    }
    if (url.pathname === '/tests/stop') {
        Object.values(TESTS).forEach(deactivateTest);
        return sendJson(res, 200, { stopped: 'all' });
    }
    let tm = url.pathname.match(/^\/(test\d+)(?:\/(stop|reset))?$/);
    if (tm) {
        const t = TESTS[tm[1]];
        if (!t) return sendJson(res, 404, { error: `unknown test, see /tests` });
        if (tm[2] === 'stop')  { deactivateTest(t); return sendJson(res, 200, { test: t.name, active: false }); }
        if (tm[2] === 'reset') { t.reset();          return sendJson(res, 200, { test: t.name, reset: true }); }

        const wasActive = t.active;
        activateTest(t);
        const limit = Math.min(parseInt(url.searchParams.get('n') ?? '3', 10) || 3, SAMPLE_LIMIT);
        const report = testReport(t, limit);
        if (!wasActive) report.note = 'just subscribed, reload in a few seconds';
        return sendJson(res, 200, report);
    }

    let m = url.pathname.match(/^\/route-full\/([^/]+)$/);
    if (m) {
        const line = m[1];
        const directionId = url.searchParams.get('direction_id') ?? '0';
        await proxyJson(res, `https://wab.stcp.pt/tracking/api/route-stops?route=${line}&direction=${directionId}`);
        return;
    }

    m = url.pathname.match(/^\/route-directions\/([^/]+)$/);
    if (m) {
        const line = m[1];
        await proxyJson(res, `https://wab.stcp.pt/tracking/api/route-stops?route=${line}`);
        return;
    }

    const stopId = url.searchParams.get('stop');

    if (stopId) {
        try {
            const r = await fetch(`https://stcp.pt/api/stops/${stopId}/realtime`);
            const data = await r.text();
            Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
            res.end(data);
        } catch (e) {
            res.writeHead(502, CORS);
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    Object.entries(CORS).forEach(([k, v]) => res.setHeader(k, v));
    if (busCache) {
        res.end(busCache);
    } else {
        res.writeHead(503);
        res.end('{"error":"no data yet"}');
    }
}).listen(process.env.PORT || 8080, () => {
    console.log('Listening on', process.env.PORT || 8080);
});
