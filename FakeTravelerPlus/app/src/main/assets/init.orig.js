var urlParams = new URLSearchParams(window.location.search);
var lat = urlParams.get('lat') ?? 12;
var lng = urlParams.get('lng') ?? 15;
var zoom = urlParams.get('zoom') ?? 12;
var provider = urlParams.get('provider') ?? 'OpenStreetMap';

var map = L.map('map').setView(toMap(lat, lng), zoom);
var popup = L.popup();
var alreadyRunning = false;

var searchInput = document.getElementById("address_input");
    searchInput.addEventListener("keypress", function(event) {
      if (event.key === "Enter") {
        event.preventDefault();
        searchForAddress();
      }
    });

addBaseLayer(map, provider);

var icon = L.icon({
    iconUrl: 'marker-icon-2x.png',
    shadowUrl: 'marker-shadow.png',

    iconSize:     [27, 44], // size of the icon
    shadowSize:   [50, 64], // size of the shadow
    iconAnchor:   [14, 48], // point of the icon which will correspond to marker's location
    shadowAnchor: [17, 68 ],  // the same for the shadow
    popupAnchor:  [0, 0] // point from which the popup should open relative to the iconAnchor
});

async function searchForAddress() {
    var coords = await searchAddress(searchInput.value);
    if (coords === undefined || coords.length < 2) return;
    var lat = coords[0];
    var lng = coords[1];

    var mapEvent = {
        latlng: toMap(lat, lng)
    };
    setOnMap(lat, lng);
    onMapClick(mapEvent);
}

function onMapClick(e) {
  if (mode === 'route') {
    var w = fromMap(e.latlng.wrap());
    Android.addWaypoint(w.lat, w.lng);
    return;
  }
    if (typeof mapMarker != 'undefined')
        map.removeLayer(mapMarker);
    mapMarker = L.marker(e.latlng, {icon: icon}).addTo(map);
    var wrap = fromMap(e.latlng.wrap()).toString();
    Android.setPosition(wrap);
}

function onZoomEnd(e) {
    Android.setZoom(map.getZoom());
}

function setOnMap(aLat, aLng) {
  if (mode === 'route') {
    map.panTo(toMap(aLat, aLng));
    return;
  }
    if (typeof mapMarker != 'undefined')
        map.removeLayer(mapMarker);
    zoom = map.getZoom();
    map.setView(toMap(aLat, aLng), zoom);
    mapMarker = L.marker(toMap(aLat, aLng), {icon: icon}).addTo(map);
    alreadyRunning = true;
    //alert(alreadyRunning);
}

map.on('contextmenu', onMapClick);
map.on('zoomend', onZoomEnd);

mapMarker = L.marker(toMap(lat, lng), {icon: icon}).addTo(map);

// ---- Route mode and live position (plain ES5, no transpiling needed) ----

var mode = 'point';
var routeLayer = L.layerGroup().addTo(map);
var mockDot = null;

// 'point': long press moves the marker. 'route': long press adds a waypoint.
function setMode(newMode) {
  mode = newMode;
  if (mode === 'route') {
    if (typeof mapMarker != 'undefined') map.removeLayer(mapMarker);
  } else {
    routeLayer.clearLayers();
  }
}

// points: [[lat, lng], ...]
function setRoute(wgsPoints, fit) {
  routeLayer.clearLayers();
  var points = [];
  for (var j = 0; j < wgsPoints.length; j++) points.push(toMap(wgsPoints[j][0], wgsPoints[j][1]));
  if (points.length > 1) {
    L.polyline(points, {color: '#1e88e5', weight: 4, opacity: 0.8}).addTo(routeLayer);
  }
  for (var i = 0; i < points.length; i++) {
    var last = i === points.length - 1;
    L.circleMarker(points[i], {
      radius: 9,
      color: '#ffffff',
      weight: 2,
      fillColor: i === 0 ? '#43a047' : last ? '#e53935' : '#1e88e5',
      fillOpacity: 1
    }).bindTooltip(String(i + 1), {permanent: true, direction: 'center', className: 'wp-label'})
      .addTo(routeLayer);
  }
  if (fit && points.length > 1) {
    map.fitBounds(L.latLngBounds(points), {padding: [40, 40]});
  } else if (fit && points.length === 1) {
    map.panTo(points[0]);
  }
}

// Current mocked position while a mock runs; does not move the map.
function showMockPosition(aLat, aLng) {
  var p = toMap(aLat, aLng);
  if (mockDot === null) {
    mockDot = L.circleMarker(p, {
      radius: 8,
      color: '#ffffff',
      weight: 3,
      fillColor: '#ff6d00',
      fillOpacity: 1
    }).addTo(map);
  } else {
    mockDot.setLatLng(p);
  }
  mockDot.bringToFront();
}

function hideMockPosition() {
  if (mockDot !== null) map.removeLayer(mockDot);
  mockDot = null;
}
