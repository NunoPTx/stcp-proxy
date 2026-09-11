# stcp-proxy

Real-time STCP bus positions via MQTT, displayed as a JSON HTTP API.

**URL:** https://stcp-proxy-production.up.railway.app

## Content

- `index.js` - main app
- `package.json` - dependency

## Endpoints

* `GET /` - all active bus positions
* `GET /?stop={id}` - real-time arrivals for a specific stop ID
* `GET /route-full/{line}?direction_id={id}` - shape points, ordered stops, headsigns, and route metadata for a specific direction
* `GET /route-directions/{line}` - lightweight headsigns for a specific line

