# stcp-proxy

STCP API proxy with real-time MQTT bus positions and static GTFS route data in JSON endpoints.

**BASE URL:** https://stcp-proxy.onrender.com/

## Content

- `index.js` - main app
- `package.json` - dependency

## Endpoints

* `GET /` - all active bus positions
* `GET /?stop={id}` - real-time arrivals for a specific stop ID
* `GET /route-full/{line}?direction_id={id}` - shape points, ordered stops, headsigns, and route metadata for a specific direction
* `GET /route-directions/{line}` - headsigns for a specific line

