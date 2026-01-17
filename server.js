import express from "express";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { pipeline } from "stream/promises";
import { parse } from "csv-parse";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

const NOAA_DIR_URL = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/";
const CACHE_DIR = path.join(__dirname, "data", "noaa");

const WIND_EVENT_TYPES = new Set([
  "High Wind",
  "Thunderstorm Wind",
  "Marine Thunderstorm Wind",
  "Marine High Wind",
  "Strong Wind"
]);

const yearFileCache = new Map();

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/windstorms", async (req, res) => {
  try {
    const address = String(req.query.address || "").trim();
    if (!address) {
      return res.status(400).json({ error: "Address is required." });
    }

    const geo = await geocodeAddress(address);
    if (!geo) {
      return res.status(404).json({ error: "Address could not be geocoded." });
    }

    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - 10);

    const startYear = cutoff.getUTCFullYear();
    const endYear = new Date().getUTCFullYear();

    const allEvents = [];
    for (let year = startYear; year <= endYear; year += 1) {
      const events = await getWindEventsForYear(year, geo, cutoff);
      allEvents.push(...events);
    }

    allEvents.sort((a, b) => b.date.getTime() - a.date.getTime());

    const results = allEvents.map((event) => ({
      date: formatDate(event.date),
      windSpeedMph: event.windSpeedMph
    }));

    return res.json({
      address: geo.displayName,
      county: geo.county,
      state: geo.state,
      results
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: "Unexpected server error." });
  }
});

app.listen(PORT, () => {
  console.log(`Wind report server running on http://localhost:${PORT}`);
});

async function geocodeAddress(address) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", "1");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("q", address);

  const response = await fetch(url, {
    headers: {
      "User-Agent": "windreport/1.0 (local demo)"
    }
  });

  if (!response.ok) {
    return null;
  }

  const data = await response.json();
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const result = data[0];
  const details = result.address || {};
  return {
    displayName: result.display_name,
    lat: Number(result.lat),
    lon: Number(result.lon),
    county: details.county || details.state_district || details.region || null,
    state: details.state || null,
    stateCode: details.state_code || null
  };
}

async function getWindEventsForYear(year, geo, cutoff) {
  const filename = await getLatestStormFilename(year);
  if (!filename) {
    return [];
  }

  await ensureFileDownloaded(filename);

  const filePath = path.join(CACHE_DIR, filename);
  const events = [];

  const parser = parse({
    columns: true,
    relax_column_count: true,
    relax_quotes: true
  });

  parser.on("readable", () => {
    let record;
    while ((record = parser.read())) {
      const eventType = (record.EVENT_TYPE || "").trim();
      if (!WIND_EVENT_TYPES.has(eventType)) {
        continue;
      }

      if ((record.CZ_TYPE || "").trim() !== "C") {
        continue;
      }

      if (geo.state && !matchesState(record.STATE, geo.state)) {
        continue;
      }

      if (geo.county && !matchesCounty(record.CZ_NAME, geo.county)) {
        continue;
      }

      const beginDate = parseNoaaDate(record.BEGIN_DATE_TIME || record.BEGIN_DATE);
      if (!beginDate || beginDate < cutoff) {
        continue;
      }

      const magnitude = Number.parseFloat(record.MAGNITUDE);
      if (!Number.isFinite(magnitude)) {
        continue;
      }

      events.push({
        date: beginDate,
        windSpeedMph: Math.round(magnitude)
      });
    }
  });

  await pipeline(fs.createReadStream(filePath), zlib.createGunzip(), parser);
  return events;
}

async function getLatestStormFilename(year) {
  if (yearFileCache.has(year)) {
    return yearFileCache.get(year);
  }

  const response = await fetch(NOAA_DIR_URL);
  if (!response.ok) {
    throw new Error("Failed to fetch NOAA directory listing.");
  }

  const html = await response.text();
  const regex = /StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz/g;
  const matches = [];

  let match;
  while ((match = regex.exec(html)) !== null) {
    if (Number(match[1]) === year) {
      matches.push({ filename: match[0], created: match[2] });
    }
  }

  if (matches.length === 0) {
    yearFileCache.set(year, null);
    return null;
  }

  matches.sort((a, b) => b.created.localeCompare(a.created));
  const latest = matches[0].filename;
  yearFileCache.set(year, latest);
  return latest;
}

async function ensureFileDownloaded(filename) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  const filePath = path.join(CACHE_DIR, filename);
  if (fs.existsSync(filePath)) {
    return;
  }

  const response = await fetch(`${NOAA_DIR_URL}${filename}`);
  if (!response.ok) {
    throw new Error(`Failed to download NOAA file ${filename}`);
  }

  await pipeline(response.body, fs.createWriteStream(filePath));
}

function parseNoaaDate(value) {
  if (!value) {
    return null;
  }

  const [datePart] = String(value).split(" ");
  const [month, day, year] = datePart.split("/").map((segment) => Number(segment));
  if (!month || !day || !year) {
    return null;
  }

  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date) {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const year = String(date.getUTCFullYear());
  return `${month}/${day}/${year}`;
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/county/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesCounty(recordCounty, targetCounty) {
  return normalizeName(recordCounty) === normalizeName(targetCounty);
}

function matchesState(recordState, targetState) {
  return normalizeName(recordState) === normalizeName(targetState);
}

