# stcp-proxy

Real-time STCP bus positions via MQTT, displayed as a JSON HTTP API.

**URL:** https://stcp-proxy-production.up.railway.app

## Content

- `index.js` — main app
- `package.json` — dependency

## Endpoints

- `GET /` — all active bus positions
- `GET /?stop={id}` — real-time arrivals for a specific stop ID

## What it shows

- `id` — fleet ID
- `directionId` — direction (0 or 1)
- `routeId` — route number
- `lat` / `lng` — position
- `speed` — current speed in km/h
- `bearing` — heading in degrees
- `timestamp` — last update (Unix)
- `tripId` — trip identifier
