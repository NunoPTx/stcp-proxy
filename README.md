# stcp-proxy

Real-time STCP bus positions via MQTT, displayed as a JSON HTTP API.

**Base URL:** https://stcp-proxy-production.up.railway.app

## Endpoints

- `GET /` — all active bus positions
- `GET /?stop={id}` — real-time arrivals for a specific stop ID
