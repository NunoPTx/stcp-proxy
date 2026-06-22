const http = require('http');
const mqtt = require('mqtt');

let busCache = null;
const vehicles = new Map();

// ── exact protobuf parser from the working Cloudflare worker ──
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
    readTag() { const tag = this.readVarint(); return { fieldNum: Number(tag >> 3n), wireType: Number(tag & 0x7n) }; }
    skip(wireType) {
        switch (wireType) {
            case 0: this.readVarint(); break;
            case 1: this.pos += 8; break;
            case 2: { const len = Number(this.readVarint()); this.pos += len; break; }
            case 5: this.pos += 4; break;
            default: throw new Error('Unknown wire type ' + wireType);
        }
    }
    readBytes() { const len = Number(this.readVarint()); const out = Buffer.from(this.buf).slice(this.pos, this.pos + len); this.pos += len; return out; }
    readString() { return this.readBytes().toString('utf8'); }
    readFloat() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
    readDouble() { const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
    eof() { return this.pos >= this.buf.length; }
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
        if (fieldNum === 1 && wireType === 2) out.id = reader.readString();
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
        if (fieldNum === 1 && wireType === 2) out.trip = parseTrip(reader.readBytes());
        else if (fieldNum === 2 && wireType === 2) out.position = parsePosition(reader.readBytes());
        else if (fieldNum === 5 && wireType === 0) out.timestamp = Number(reader.readVarint());
        else if (fieldNum === 8 && wireType === 2) out.vehicle = parseVehicleDescriptor(reader.readBytes());
        else reader.skip(wireType);
    }
    return out;
}
function parseTrip(buf) {
    const reader = new PBReader(buf);
    const out = { tripId: null, routeId: null, directionId: null };
    while (!reader.eof()) {
        const { fieldNum, wireType } = reader.readTag();
        if (fieldNum === 1 && wireType === 2) out.tripId = reader.readString();
        else if (fieldNum === 5 && wireType === 2) out.routeId = reader.readString();
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
        if (fieldNum === 1 && wireType === 5) out.latitude = reader.readFloat();
        else if (fieldNum === 2 && wireType === 5) out.longitude = reader.readFloat();
        else if (fieldNum === 3 && wireType === 5) out.bearing = reader.readFloat();
        else if (fieldNum === 5 && wireType === 5) out.speed = reader.readFloat();
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

// ── MQTT ─────────────────────────────────────────────────────
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
    client.subscribe('/gtfsrt/vp/2///BUS/#');
});

client.on('message', (topic, payload) => {
    try {
        const entity = parseVehiclePosition(payload);
        const v = entity?.vehicle;
        if (v?.position?.latitude != null && v?.position?.longitude != null) {
            const id = v.vehicle?.id || entity.id;
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
        }
        busCache = JSON.stringify(Array.from(vehicles.values()));
    } catch (e) {
        console.error('parse error:', e.message);
    }
});

client.on('error', (e) => console.error('MQTT error:', e.message));

// ── HTTP ──────────────────────────────────────────────────────
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

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
        res.writeHead(503);
        res.end('{"error":"no data yet"}');
    }
}).listen(process.env.PORT || 8080, () => {
    console.log('Listening on', process.env.PORT || 8080);
});
