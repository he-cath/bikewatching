
import mapboxgl from 'https://cdn.jsdelivr.net/npm/mapbox-gl@2.15.0/+esm';
import * as d3 from 'https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm';

// STEP 1: MAPBOX SETUP
// Replace this string with your public Mapbox token (pk...)
mapboxgl.accessToken = 'pk.eyJ1IjoiY2FoMDI0IiwiYSI6ImNtd2cyd21rcjA4MGEyeXBsZXV3amZsNXUifQ.tJaM9-nni-9PkaH1tv7BcA';

const map = new mapboxgl.Map({
    container: 'map',
    style: 'mapbox://styles/mapbox/streets-v12',
    center: [-71.09415, 42.36027],
    zoom: 12,
    minZoom: 5,
    maxZoom: 18
});

map.addControl(new mapboxgl.NavigationControl());

// DATA URLs
const BOSTON_LANES =
    'https://bostonopendata-boston.opendata.arcgis.com/datasets/boston::existing-bike-network-2022.geojson';

const CAMBRIDGE_LANES =
    'https://data.cambridgema.gov/resource/9aey-9g9p.geojson';

const STATIONS_URL =
    'https://dsc106.com/labs/lab07/data/bluebikes-stations.json';

const TRAFFIC_URL =
    'https://dsc106.com/labs/lab07/data/bluebikes-traffic-2024-03.csv';

// STEP 5: HELPERS
function minutesSinceMidnight(date) {
    return date.getHours() * 60 + date.getMinutes();
}

function formatTime(minutes) {
    const date = new Date(2024, 0, 1, 0, minutes);

    return date.toLocaleTimeString('en-US', {
        hour: 'numeric',
        minute: '2-digit'
    });
}

// One bucket for each minute of the day
const departuresByMinute = Array.from(
    { length: 1440 },
    () => new Map()
);

const arrivalsByMinute = Array.from(
    { length: 1440 },
    () => new Map()
);

function addToBucket(buckets, minute, stationId) {
    if (!stationId || !Number.isInteger(minute)) return;

    const bucket = buckets[minute];

    bucket.set(stationId, (bucket.get(stationId) ?? 0) + 1);
}

// Retrieve counts within 60 minutes of selected time
function countsForTime(buckets, timeFilter) {
    const totals = new Map();

    const addCounts = bucket => {
        for (const [id, count] of bucket) {
            totals.set(id, (totals.get(id) ?? 0) + count);
        }
    };

    if (timeFilter === -1) {
        buckets.forEach(addCounts);
    } else {
        for (let offset = -60; offset <= 60; offset++) {
            const minute = (timeFilter + offset + 1440) % 1440;
            addCounts(buckets[minute]);
        }
    }

    return totals;
}

// STEP 4: CALCULATE TRAFFIC FOR EACH STATION
function computeStationTraffic(stations, timeFilter = -1) {
    const departures = countsForTime(
        departuresByMinute,
        timeFilter
    );

    const arrivals = countsForTime(
        arrivalsByMinute,
        timeFilter
    );

    return stations.map(station => {
        const id = station.short_name;

        const stationArrivals = arrivals.get(id) ?? 0;
        const stationDepartures = departures.get(id) ?? 0;

        return {
            ...station,
            arrivals: stationArrivals,
            departures: stationDepartures,
            totalTraffic: stationArrivals + stationDepartures
        };
    });
}

// STEP 6: TRAFFIC FLOW COLOR SCALE
const stationFlow = d3.scaleQuantize()
    .domain([0, 1])
    .range([0, 0.5, 1]);

function getDepartureRatio(station) {
    if (station.totalTraffic === 0) return 0.5;

    return stationFlow(
        station.departures / station.totalTraffic
    );
}

// STEP 3: CONVERT COORDINATES
function getCoords(station) {
    const point = map.project([
        Number(station.lon),
        Number(station.lat)
    ]);

    return {
        cx: point.x,
        cy: point.y
    };
}

// STEPS 2–6: WAIT FOR MAP TO LOAD
map.on('load', async () => {

    // STEP 2: BOSTON BIKE LANES
    map.addSource('boston-routes', {
        type: 'geojson',
        data: BOSTON_LANES
    });

    map.addLayer({
        id: 'boston-bike-lanes',
        type: 'line',
        source: 'boston-routes',
        paint: {
            'line-color': '#32D400',
            'line-width': 3,
            'line-opacity': 0.6
        }
    });

    // STEP 2: CAMBRIDGE BIKE LANES
    map.addSource('cambridge-routes', {
        type: 'geojson',
        data: CAMBRIDGE_LANES
    });

    map.addLayer({
        id: 'cambridge-bike-lanes',
        type: 'line',
        source: 'cambridge-routes',
        paint: {
            'line-color': '#32D400',
            'line-width': 3,
            'line-opacity': 0.6
        }
    });

    try {
        // STEP 3: LOAD STATIONS
        const jsonData = await d3.json(STATIONS_URL);

        const stations = jsonData.data.stations;

        // STEP 4: LOAD AND PARSE TRIPS
        await d3.csv(TRAFFIC_URL, trip => {
            trip.started_at = new Date(trip.started_at);
            trip.ended_at = new Date(trip.ended_at);

            if (!Number.isNaN(trip.started_at.getTime())) {
                addToBucket(
                    departuresByMinute,
                    minutesSinceMidnight(trip.started_at),
                    trip.start_station_id
                );
            }

            if (!Number.isNaN(trip.ended_at.getTime())) {
                addToBucket(
                    arrivalsByMinute,
                    minutesSinceMidnight(trip.ended_at),
                    trip.end_station_id
                );
            }

            return null;
        });

        console.log('Stations loaded:', stations.length);
        console.log('Traffic data processed');

        const svg = d3.select('#map svg');

        // Create initial station traffic data
        const initialStations = computeStationTraffic(stations);

        // Circle radius scales with square root of traffic
        const radiusScale = d3.scaleSqrt()
            .domain([
                0,
                d3.max(initialStations, d => d.totalTraffic) || 1
            ])
            .range([0, 25]);

        // STEP 3–4: DRAW STATION MARKERS
        const circles = svg
            .selectAll('circle')
            .data(initialStations, d => d.short_name)
            .join('circle')
            .attr('r', d => radiusScale(d.totalTraffic))
            .style('--departure-ratio', getDepartureRatio);

        // Tooltips with exact traffic
        circles.append('title');

        function updateTooltips() {
            circles.select('title')
                .text(d =>
                    `${d.name}
${d.totalTraffic} trips
${d.departures} departures
${d.arrivals} arrivals`
                );
        }

        // STEP 3: KEEP MARKERS ALIGNED WITH THE MAP
        function updatePositions() {
            circles
                .attr('cx', d => getCoords(d).cx)
                .attr('cy', d => getCoords(d).cy);
        }

        updatePositions();
        updateTooltips();

        map.on('move', updatePositions);
        map.on('resize', updatePositions);
        map.on('moveend', updatePositions);

        // STEP 5: TIME SLIDER
        const timeSlider =
            document.getElementById('time-slider');

        const selectedTime =
            document.getElementById('selected-time');

        const anyTimeLabel =
            document.getElementById('any-time');

        // Update circles based on selected time
        function updateScatterPlot(timeFilter) {
            const filteredStations =
                computeStationTraffic(stations, timeFilter);

            const maxTraffic =
                d3.max(filteredStations, d => d.totalTraffic) || 1;

            radiusScale
                .domain([0, maxTraffic])
                .range(timeFilter === -1 ? [0, 25] : [0, 50]);

            circles
                .data(filteredStations, d => d.short_name)
                .attr('r', d => radiusScale(d.totalTraffic))
                .style('--departure-ratio', getDepartureRatio);

            updateTooltips();
        }

        function updateTimeDisplay() {
            const timeFilter = Number(timeSlider.value);

            if (timeFilter === -1) {
                selectedTime.textContent = '';
                anyTimeLabel.style.display = 'block';
            } else {
                selectedTime.textContent = formatTime(timeFilter);
                anyTimeLabel.style.display = 'none';
            }

            updateScatterPlot(timeFilter);
        }

        timeSlider.addEventListener('input', updateTimeDisplay);

        // Initial display
        updateTimeDisplay();

    } catch (error) {
        console.error('Error loading Bluebikes data:', error);
    }
});
