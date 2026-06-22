const http = require('http');
const mqtt = require('mqtt');

let busCache = null;
const vehicles = new Map();

const client = mqtt.connect('wss://mmt.portodigital.pt/websocket/', {
    protocol: 'wss',
    wsOptions: { headers: { Origin: 'https://explore.porto.pt' } },
    protocolId: 'MQTT',
    protocolVersion: 4,
    clean: true,
    reconnectPeriod: 2000
});

client.on('connect', () => {
    console.log('Connected to MQTT broker');
    client.subscribe('/gtfsrt/vp/2///BUS/#');
});

client.on('message', (topic, payload) => {
    try {
        const buf = new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
        const entity = parseFeedMessage(buf);
        const v = entity?.vehicle;
        if (v?.position?.latitude != null) {
            const id = v.vid ?? entity.id;
            vehicles.set(id, {
                id,
                routeId:     v.trip?.routeId     ?? null,
                directionId: v.trip?.directionId ?? null,
                tripId:      v.trip?.tripId      ?? null,
                lat:         v.position.latitude,
                lng:         v.position.longitude,
                bearing:     v.position.bearing  ?? 0,
                speed:       v.position.speed    ?? 0,
                timestamp:   v.timestamp         ?? null
            });
        }
        busCache = JSON.stringify(Array.from(vehicles.values()));
    } catch (e) {
        console.error('parse error:', e.message);
    }
});

client.on('disconnect', () => console.log('Disconnected, reconnecting...'));
client.on('error', (e) => console.error('MQTT error:', e.message));

// ── Protobuf parser ──────────────────────────────────────────
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
    readTag()    { const t = this.readVarint(); return { fieldNum: Number(t >> 3n), wireType: Number(t & 0x7n) }; }
    readBytes()  { const len = Number(this.readVarint()); const out = this.buf.slice(this.pos, this.pos + len); this.pos += len; return out; }
    readString() { return new TextDecoder().decode(this.readBytes()); }
    readFloat()  { const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 4).getFloat32(0, true); this.pos += 4; return v; }
    readDouble() { const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.pos, 8).getFloat64(0, true); this.pos += 8; return v; }
    readVarintNum() { return Number(this.readVarint()); }
    skip(wireType) {
        switch (wireType) {
            case 0: this.readVarint(); break;
            case 1: this.pos += 8; break;
            case 2: this.pos += Number(this.readVarint()); break;
            case 5: this.pos += 4; break;
            default: throw new Error('Unknown wire type ' + wireType);
        }
    }
    eof() { return this.pos >= this.buf.length; }
}

function parseFeedMessage(buf) {
    const r = new PBReader(buf);
    while (!r.eof()) {
        const { fieldNum, wireType } = r.readTag();
        if (fieldNum === 2 && wireType === 2) return parseEntity(r.readBytes());
        r.skip(wireType);
    }
    return null;
}

function parseEntity(buf) {
    const r = new PBReader(buf);
    let id = null, vehicle = null;
    while (!r.eof()) {
        const { fieldNum, wireType } = r.readTag();
        if      (fieldNum === 1 && wireType === 2) id = r.readString();
        else if (fieldNum === 4 && wireType === 2) vehicle = parseVehicle(r.readBytes());
        else r.skip(wireType);
    }
    return { id, vehicle };
}

function parseVehicle(buf) {
    const r = new PBReader(buf);
    let trip = null, position = null, timestamp = null, vid = null;
    while (!r.eof()) {
        const { fieldNum, wireType } = r.readTag();
        if      (fieldNum === 1 && wireType === 2) trip      = parseTrip(r.readBytes());
        else if (fieldNum === 2 && wireType === 2) position  = parsePosition(r.readBytes());
        else if (fieldNum === 5 && wireType === 0) timestamp = r.readVarintNum();
        else if (fieldNum === 8 && wireType === 2) vid       = parseVehicleDescriptor(r.readBytes());
        else r.skip(wireType);
    }
    return { trip, position, timestamp, vid };
}

function parseTrip(buf) {
    const r = new PBReader(buf);
    let tripId = null, routeId = null, directionId = null;
    while (!r.eof()) {
        const { fieldNum, wireType } = r.readTag();
        if      (fieldNum === 1 && wireType === 2) tripId      = r.readString();
        else if (fieldNum === 5 && wireType === 2) routeId     = r.readString();
        else if (fieldNum === 6 && wireType === 0) directionId = r.readVarintNum();
        else r.skip(wireType);
    }
    return { tripId, routeId, directionId };
}

function parsePosition(buf) {
    const r = new PBReader(buf);
    let latitude = null, longitude = null, bearing = 0, speed = 0;
    while (!r.eof()) {
        const { fieldNum, wireType } = r.readTag();
        if      (fieldNum === 1 && wireType === 5) latitude  = r.readFloat();
        else if (fieldNum === 2 && wireType === 5) longitude = r.readFloat();
        else if (fieldNum === 3 && wireType === 5) bearing   = r.readFloat();
        else if (fieldNum === 5 && wireType === 5) speed     = r.readFloat();
        else r.skip(wireType);
    }
    return { latitude, longitude, bearing, speed };
}

function parseVehicleDescriptor(buf) {
    const r = new PBReader(buf);
    let id = null;
    while (!r.eof()) {
        const { fieldNum, wireType } = r.readTag();
        if (fieldNum === 1 && wireType === 2) id = r.readString();
        else r.skip(wireType);
    }
    return id;
}

// ── HTTP server ──────────────────────────────────────────────
const CORS = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
};

http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
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
        res.writeHead(503, CORS);
        res.end('{"error":"no data yet"}');
    }
}).listen(process.env.PORT || 3000, () => {
    console.log('HTTP server listening on port', process.env.PORT || 3000);
});
