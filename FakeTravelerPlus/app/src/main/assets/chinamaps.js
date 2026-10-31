// Base maps that are fast in mainland China (Gaode / AMap), and the coordinate conversion they need.
//
// The app always works in WGS-84, the system the Android location API and GPS use. Gaode tiles are
// drawn in GCJ-02, which is offset from WGS-84 by up to several hundred meters inside China. When a
// Gaode map is shown, everything drawn is converted WGS-84 -> GCJ-02 (toMap) and every point the
// user picks is converted back GCJ-02 -> WGS-84 (fromMap) before it reaches the app.
//
// Plain ES5 so it runs without transpiling on old WebViews.

var GAODE_LAYERS = {
  'GaoDe.Normal': [
    {url: 'https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', filter: true}
  ],
  'GaoDe.Satellite': [
    {url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}', filter: false},
    // Road and place name labels on top of the imagery
    {url: 'https://webst0{s}.is.autonavi.com/appmaptile?style=8&x={x}&y={y}&z={z}', filter: false}
  ]
};

var useGcj = Object.prototype.hasOwnProperty.call(GAODE_LAYERS,
  new URLSearchParams(window.location.search).get('provider') || '');

// Adds the base map named `name`: a Gaode preset, or any leaflet-providers name.
function addBaseLayer(map, name) {
  var defs = GAODE_LAYERS[name];
  if (!defs) {
    return L.tileLayer.provider(name, {
      className: 'map-tiles',
      referrerPolicy: 'strict-origin-when-cross-origin'
    }).addTo(map);
  }
  for (var i = 0; i < defs.length; i++) addGaodeLayer(map, defs[i]);
}

function addGaodeLayer(map, def) {
  var layer = L.tileLayer(def.url, {
    subdomains: '1234',
    maxNativeZoom: 18,
    maxZoom: 19,
    attribution: '&copy; 高德地图',
    // Satellite imagery must not get the dark mode color inversion
    className: def.filter ? 'map-tiles' : 'map-tiles-nofilter'
  });
  // Fall back to plain HTTP once if HTTPS tiles fail before any tile loaded
  // (cleartext is allowed for these hosts only, see network_security_config.xml).
  var loaded = false, errors = 0;
  layer.on('tileload', function () { loaded = true; });
  layer.on('tileerror', function () {
    if (loaded || ++errors < 4 || def.url.indexOf('https:') !== 0) return;
    def.url = def.url.replace('https:', 'http:');
    layer.setUrl(def.url);
  });
  layer.addTo(map);
}

// ---- WGS-84 <-> GCJ-02 ----

var GCJ_A = 6378245.0;
var GCJ_EE = 0.00669342162296594323;

function outOfChina(lat, lng) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function gcjTransformLat(x, y) {
  var r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320.0 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
  return r;
}

function gcjTransformLng(x, y) {
  var r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
  r += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
  r += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
  return r;
}

function wgsToGcj(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  var dLat = gcjTransformLat(lng - 105.0, lat - 35.0);
  var dLng = gcjTransformLng(lng - 105.0, lat - 35.0);
  var radLat = lat / 180.0 * Math.PI;
  var magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  var sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180.0) / (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lng + dLng];
}

// No closed form exists; iterate until converting back lands on the input (well below 1 cm).
function gcjToWgs(lat, lng) {
  if (outOfChina(lat, lng)) return [lat, lng];
  var wLat = lat, wLng = lng;
  for (var i = 0; i < 20; i++) {
    var g = wgsToGcj(wLat, wLng);
    var eLat = lat - g[0], eLng = lng - g[1];
    wLat += eLat;
    wLng += eLng;
    if (Math.abs(eLat) < 1e-10 && Math.abs(eLng) < 1e-10) break;
  }
  return [wLat, wLng];
}

// WGS-84 (app) -> L.LatLng to draw on the current base map
function toMap(lat, lng) {
  lat = Number(lat);
  lng = Number(lng);
  if (!useGcj) return L.latLng(lat, lng);
  var g = wgsToGcj(lat, lng);
  return L.latLng(g[0], g[1]);
}

// L.LatLng picked on the current base map -> WGS-84 L.LatLng for the app
function fromMap(latlng) {
  if (!useGcj) return latlng;
  var w = gcjToWgs(latlng.lat, latlng.lng);
  return L.latLng(w[0], w[1]);
}
