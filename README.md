# Wind Report

Enter an address and receive a list of NOAA Storm Events wind storms within the
last 10 years, formatted as:

```
DATE: MM/DD/YYYY - WIND SPEED: XX MPH
```

## Setup

1. Install dependencies:

```
npm install
```

2. Start the server:

```
npm start
```

3. Open the app:

```
http://localhost:3000
```

## Notes

- Requires Node.js 18+ (for built-in `fetch`).
- Data is pulled from NOAA's Storm Events Database files published at
  `https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/`.
- Address geocoding is handled by OpenStreetMap Nominatim. Please avoid
  automated high-volume use without appropriate usage policy compliance.
- NOAA wind event magnitudes are assumed to be in MPH for wind-related events.

