# stcp-proxy

Real-time STCP bus positions via MQTT, displayed as a JSON HTTP API.

**Base URL:** https://stcp-proxy-production.up.railway.app

## Endpoints

- `GET /` — all active bus positions
- `GET /?stop={id}` — real-time arrivals for a specific stop ID

## Response fields

- `id` — fleet ID
- `directionId` — direction (0 or 1)
- `routeId` — route number
- `lat` / `lng` — position
- `speed` — current speed in km/h
- `bearing` — heading in degrees
- `timestamp` — last update (Unix)
- `tripId` — trip identifier
