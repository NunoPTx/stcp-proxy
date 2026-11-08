const http = require('http');
const CORS = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

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

    if (url.pathname === '/stops') {
        await proxyJson(res, `https://stcp.pt/api/stops?limit=5000`);
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

    if (url.pathname === '/') {
        try {
            const r = await fetch('https://stcp.pt/api/network/vehicles');
            const payload = await r.json();
            if (!r.ok) {
                res.writeHead(r.status, CORS);
                res.end(JSON.stringify({ error: 'STCP vehicle request failed', status: r.status }));
                return;
            }
            const sourceVehicles = Array.isArray(payload)
                ? payload
                : Array.isArray(payload.vehicles)
                    ? payload.vehicles
                    : Array.isArray(payload.data)
                        ? payload.data
                        : [];
            const mappedVehicles = sourceVehicles.map(vehicle => ({
                id: String(vehicle.vehicle_id ?? vehicle.id ?? ''),
                directionId: vehicle.direction_id ?? vehicle.directionId ?? null,
                routeId: String(vehicle.route_id ?? vehicle.routeId ?? ''),
                routeShortName: String(vehicle.route_short_name ?? vehicle.routeShortName ?? vehicle.route_id ?? vehicle.routeId ?? ''),
                lat: vehicle.latitude ?? vehicle.lat ?? null,
                lng: vehicle.longitude ?? vehicle.lng ?? null,
                speed: vehicle.speed ?? 0,
                bearing: vehicle.bearing ?? 0,
                timestamp: vehicle.timestamp ?? null,
                tripId: vehicle.trip_id ?? vehicle.tripId ?? vehicle.vehicle_id ?? null
            }));            res.writeHead(200, CORS);
            res.end(JSON.stringify(mappedVehicles));
        } catch (e) {
            res.writeHead(502, CORS);
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }
    res.writeHead(404, CORS);
    res.end(JSON.stringify({ error: 'not found' }));
    }).listen(process.env.PORT || 8080, () => {
    console.log('Listening on', process.env.PORT || 8080);
});
