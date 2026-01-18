import fs from "fs";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { parse } from "csv-parse";

const NOAA_DIR_URL = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/";
const CACHE_DIR = "/tmp/noaa";

const WIND_EVENT_TYPES = new Set([
  "High Wind",
  "Thunderstorm Wind",
  "Marine Thunderstorm Wind",
  "Marine High Wind",
  "Strong Wind",
  "Tropical Storm",
  "Hurricane",
  "Hurricane (Typhoon)"
]);

let directoryCache = { html: null, timestamp: 0 };
const DIRECTORY_CACHE_TTL = 3600000;

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const address = String(req.query.address || "").trim();
    if (!address) {
      return res.status(400).json({ error: "Address is required." });
    }

    const radiusMiles = Math.max(0, Number(req.query.radius) || 0);

    console.log(`Searching for: ${address} (radius: ${radiusMiles || 'county-wide'})`);

    const geo = await geocodeAddress(address);
    if (!geo) {
      return res.status(404).json({ error: "Could not find that address. Try including city and state." });
    }

    console.log(`Geocoded to: ${geo.county}, ${geo.state} (${geo.lat}, ${geo.lon})`);

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 10);

    const startYear = cutoff.getUTCFullYear();
    const endYear = new Date().getUTCFullYear();

    const allEvents = [];
    for (let year = startYear; year <= endYear; year++) {
      try {
        const events = await getWindEventsForYear(year, geo, cutoff);
        allEvents.push(...events);
        console.log(`Year ${year}: ${events.length} events`);
      } catch (err) {
        console.error(`Error processing year ${year}:`, err.message);
      }
    }

    allEvents.sort((a, b) => b.date.getTime() - a.date.getTime());

    let filteredEvents = allEvents;
    if (radiusMiles > 0) {
      filteredEvents = allEvents
        .map((e) => {
          if (e.lat && e.lon) {
            e.distanceMiles = haversineDistance(geo.lat, geo.lon, e.lat, e.lon);
          }
          return e;
        })
        .filter((e) => {
          if (!e.lat || !e.lon) return false;
          return e.distanceMiles <= radiusMiles;
        });
    }

    const seen = new Set();
    const uniqueEvents = filteredEvents.filter((e) => {
      const key = `${formatDate(e.date)}-${e.windSpeedMph}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const results = uniqueEvents.map((event) => ({
      date: formatDate(event.date),
      windSpeedMph: event.windSpeedMph,
      eventType: event.eventType,
      distanceMiles: event.distanceMiles ? Math.round(event.distanceMiles * 10) / 10 : null
    }));

    console.log(`Total unique events: ${results.length}`);

    return res.status(200).json({
      address: geo.displayName,
      county: geo.county,
      state: geo.state,
      radiusMiles: radiusMiles || null,
      results
    });
  } catch (error) {
    console.error("API Error:", error);
    return res.status(500).json({ error: "Server error. Please try again." });
  }
}

async function geocodeAddress(address) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("countrycodes", "us");
  url.searchParams.set("q", address);

  const response = await fetch(url, {
    headers: { "User-Agent": "WindReport/2.0 (NOAA Storm Events Lookup)" }
  });

  if (!response.ok) return null;

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) return null;

  const result = data[0];
  const details = result.address || {};

  let county = details.county || details.state_district || details.region || details.city || null;
  if (county) {
    county = county
      .replace(/\s+County$/i, "")
      .replace(/\s+Parish$/i, "")
      .replace(/\s+Borough$/i, "")
      .replace(/\s+Census Area$/i, "")
      .trim();
  }

  return {
    displayName: result.display_name,
    lat: Number(result.lat),
    lon: Number(result.lon),
    county,
    state: details.state || null
  };
}

async function getWindEventsForYear(year, geo, cutoff) {
  const filename = await getLatestStormFilename(year);
  if (!filename) return [];

  await ensureFileDownloaded(filename);

  const filePath = path.join(CACHE_DIR, filename);
  const events = [];

  const normalizedTargetCounty = normalizeName(geo.county);
  const normalizedTargetState = normalizeName(geo.state);

  const parser = parse({
    columns: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true
  });

  parser.on("readable", () => {
    let record;
    while ((record = parser.read())) {
      const eventType = (record.EVENT_TYPE || "").trim();
      if (!WIND_EVENT_TYPES.has(eventType)) continue;

      const recordState = normalizeName(record.STATE);
      if (normalizedTargetState && recordState !== normalizedTargetState) continue;

      const recordCounty = normalizeName(record.CZ_NAME);

      if (normalizedTargetCounty) {
        const countyMatches =
          recordCounty === normalizedTargetCounty ||
          recordCounty.includes(normalizedTargetCounty) ||
          normalizedTargetCounty.includes(recordCounty) ||
          recordCounty.split(" ")[0] === normalizedTargetCounty.split(" ")[0];
        if (!countyMatches) continue;
      }

      const beginDate = parseNoaaDate(record.BEGIN_DATE_TIME || record.BEGIN_DATE);
      if (!beginDate || beginDate < cutoff) continue;

      let magnitude = Number.parseFloat(record.MAGNITUDE);
      const magnitudeType = (record.MAGNITUDE_TYPE || "").toUpperCase();
      if (magnitudeType === "EG" || magnitudeType === "MG") {
        magnitude = Math.round(magnitude * 1.15078);
      }
      if (!Number.isFinite(magnitude) || magnitude <= 0) continue;

      const lat = Number.parseFloat(record.BEGIN_LAT);
      const lon = Number.parseFloat(record.BEGIN_LON);

      events.push({
        date: beginDate,
        windSpeedMph: Math.round(magnitude),
        eventType,
        lat: Number.isFinite(lat) ? lat : null,
        lon: Number.isFinite(lon) ? lon : null
      });
    }
  });

  await pipeline(fs.createReadStream(filePath), zlib.createGunzip(), parser);
  return events;
}

async function getNoaaDirectoryHtml() {
  const now = Date.now();
  if (directoryCache.html && now - directoryCache.timestamp < DIRECTORY_CACHE_TTL) {
    return directoryCache.html;
  }

  const response = await fetch(NOAA_DIR_URL);
  if (!response.ok) throw new Error("Failed to fetch NOAA directory listing.");

  const html = await response.text();
  directoryCache = { html, timestamp: now };
  return html;
}

async function getLatestStormFilename(year) {
  const html = await getNoaaDirectoryHtml();
  const regex = /StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz/g;
  const matches = [];

  let match;
  while ((match = regex.exec(html)) !== null) {
    if (Number(match[1]) === year) {
      matches.push({ filename: match[0], created: match[2] });
    }
  }

  if (matches.length === 0) return null;
  matches.sort((a, b) => b.created.localeCompare(a.created));
  return matches[0].filename;
}

async function ensureFileDownloaded(filename) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const filePath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(filePath)) return;

  console.log(`Downloading ${filename}...`);
  const response = await fetch(`${NOAA_DIR_URL}${filename}`);
  if (!response.ok) throw new Error(`Failed to download ${filename}`);

  await pipeline(response.body, fs.createWriteStream(filePath));
  console.log(`Downloaded ${filename}`);
}

function parseNoaaDate(value) {
  if (!value) return null;
  const str = String(value).trim();

  const slashMatch = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    const [, month, day, year] = slashMatch;
    return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const dashMatch = str.match(/^(\d{1,2})-([A-Z]{3})-(\d{2,4})/i);
  if (dashMatch) {
    const [, day, monthStr, yearStr] = dashMatch;
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const month = months[monthStr.toUpperCase()];
    let year = Number(yearStr);
    if (year < 100) year += 2000;
    if (month !== undefined) return new Date(Date.UTC(year, month, Number(day)));
  }

  return null;
}

function formatDate(date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = String(date.getUTCFullYear());
  return `${month}/${day}/${year}`;
}

function normalizeName(value) {
  if (!value) return "";
  return String(value)
    .toLowerCase()
    .replace(/\s+county$/i, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg) {
  return deg * (Math.PI / 180);
}
