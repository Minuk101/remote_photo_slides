import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const TILE_SIZE = 0.1;
const QUERY_MARGIN = 0.03;
const QUERY_SCHEMA_VERSION = 1;
const FAILED_RETRY_MS = 60 * 60 * 1000;
const USER_AGENT = 'RemotePhotoSlides/1.0 (https://github.com/Minuk101/remote_photo_slides)';
const OVERPASS_ENDPOINTS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass-api.de/api/interpreter'
];

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * radians;
  const deltaLon = (lon2 - lon1) * radians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function tileKey(latitude, longitude) {
  return `${Math.floor(latitude / TILE_SIZE)}:${Math.floor(longitude / TILE_SIZE)}`;
}

function tileBounds(key) {
  const [latIndex, lonIndex] = key.split(':').map(Number);
  return {
    south: latIndex * TILE_SIZE - QUERY_MARGIN,
    west: lonIndex * TILE_SIZE - QUERY_MARGIN,
    north: (latIndex + 1) * TILE_SIZE + QUERY_MARGIN,
    east: (lonIndex + 1) * TILE_SIZE + QUERY_MARGIN
  };
}

async function fetchWithTimeout(url, options, timeoutMs = 30_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function buildOverpassQuery(bounds) {
  const box = `${bounds.south},${bounds.west},${bounds.north},${bounds.east}`;
  return `[out:json][timeout:20];(
    nwr(${box})["name"]["tourism"~"^(aquarium|theme_park|zoo|attraction|museum|gallery|viewpoint|resort)$"];
    nwr(${box})["name"]["leisure"~"^(theme_park|water_park|park|nature_reserve|stadium|marina|garden)$"];
    nwr(${box})["name"]["historic"];
    nwr(${box})["name"]["natural"~"^(peak|beach|bay|cape|volcano|waterfall|cave_entrance)$"];
    nwr(${box})["name"]["aeroway"="aerodrome"];
  );out center tags;`;
}

function candidateCoordinates(element) {
  const latitude = element.lat ?? element.center?.lat;
  const longitude = element.lon ?? element.center?.lon;
  return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
}

function compactCandidate(element) {
  const coordinates = candidateCoordinates(element);
  if (!coordinates || !element.tags) return null;
  const tags = element.tags;
  return {
    id: `${element.type}/${element.id}`,
    ...coordinates,
    name: tags['name:ko'] || tags.name || tags['name:en'] || tags['name:ja'] || '',
    tourism: tags.tourism || '',
    leisure: tags.leisure || '',
    historic: tags.historic || '',
    natural: tags.natural || '',
    aeroway: tags.aeroway || '',
    wikidata: tags.wikidata || '',
    wikipedia: tags.wikipedia || '',
    website: tags.website || tags['contact:website'] || '',
    sitelinks: 0
  };
}

async function queryOverpass(key) {
  const query = buildOverpassQuery(tileBounds(key));
  let lastError = null;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': USER_AGENT
        },
        body: new URLSearchParams({ data: query })
      });
      const contentType = response.headers.get('content-type') || '';
      if (!response.ok || !contentType.includes('json')) {
        throw new Error(`Overpass ${response.status}`);
      }
      const result = await response.json();
      const unique = new Map();
      for (const element of result.elements || []) {
        const candidate = compactCandidate(element);
        if (candidate?.name) unique.set(candidate.id, candidate);
      }
      return [...unique.values()];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('OpenStreetMap 장소 서버에 연결할 수 없습니다.');
}

async function enrichWikidata(candidates) {
  const ids = [...new Set(candidates.map(candidate => candidate.wikidata).filter(id => /^Q\d+$/.test(id)))];
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    try {
      const parameters = new URLSearchParams({
        action: 'wbgetentities',
        ids: batch.join('|'),
        props: 'labels|sitelinks',
        languages: 'ko|en|ja',
        format: 'json',
        formatversion: '2'
      });
      const response = await fetchWithTimeout(`https://www.wikidata.org/w/api.php?${parameters}`, {
        headers: { 'User-Agent': USER_AGENT }
      }, 15_000);
      if (!response.ok) continue;
      const result = await response.json();
      for (const entity of Object.values(result.entities || {})) {
        const matching = candidates.filter(candidate => candidate.wikidata === entity.id);
        const label = entity.labels?.ko?.value;
        for (const candidate of matching) {
          if (label) candidate.name = label;
          candidate.sitelinks = Object.keys(entity.sitelinks || {}).length;
        }
      }
    } catch {
      // OSM names are enough when Wikimedia is temporarily unavailable.
    }
  }
}

function category(candidate) {
  const tourismScores = {
    aquarium: [145, 3], theme_park: [145, 3], zoo: [135, 3], attraction: [105, 1.5],
    museum: [100, 0.8], gallery: [85, 0.6], viewpoint: [80, 1], resort: [90, 3],
    information: [15, 0.3], hotel: [10, 0.3], guest_house: [5, 0.3]
  };
  const leisureScores = {
    water_park: [135, 3], garden: [110, 2], nature_reserve: [105, 2],
    stadium: [95, 2], marina: [80, 1.5], park: [65, 1]
  };
  if (tourismScores[candidate.tourism]) return tourismScores[candidate.tourism];
  if (leisureScores[candidate.leisure]) return leisureScores[candidate.leisure];
  if (candidate.aeroway === 'aerodrome') return [115, 3];
  if (candidate.historic) return [90, 0.8];
  if (candidate.natural) return [70, 1];
  return [0, 0.3];
}

function bestCandidate(candidates, latitude, longitude) {
  let best = null;
  let bestScore = 80;
  for (const candidate of candidates) {
    const [baseScore, allowedDistance] = category(candidate);
    const distanceKm = haversineKm(latitude, longitude, candidate.latitude, candidate.longitude);
    if (distanceKm > allowedDistance) continue;
    const hasAuthority = Boolean(candidate.wikipedia || candidate.wikidata || candidate.website);
    if (!hasAuthority && distanceKm > 0.3) continue;
    const authority = (candidate.wikipedia ? 28 : 0)
      + (candidate.wikidata ? 18 : 0)
      + Math.min(42, Math.log2(candidate.sitelinks + 1) * 7)
      + (candidate.website ? 45 : 0);
    const proximity = distanceKm <= 0.15 ? 60 : distanceKm <= 0.5 ? 30 : 0;
    const score = baseScore + authority + proximity - (distanceKm / allowedDistance) * 35;
    if (score > bestScore) {
      best = { ...candidate, distanceKm, score };
      bestScore = score;
    }
  }
  return best;
}

export class OsmLandmarkService {
  constructor(dataDirectory) {
    this.cacheFile = path.join(dataDirectory, 'osm-landmarks.json');
    this.tiles = new Map();
  }

  async loadCache() {
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      for (const [key, value] of Object.entries(parsed)) this.tiles.set(key, value);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('OSM 장소 캐시를 읽지 못했습니다:', error.message);
    }
  }

  pendingKeys(locations) {
    const counts = new Map();
    for (const value of locations) {
      if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) continue;
      const key = tileKey(value.latitude, value.longitude);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.keys()].filter(key => {
      const cached = this.tiles.get(key);
      return !cached
        || cached.schema !== QUERY_SCHEMA_VERSION
        || (cached.failedAt && Date.now() - cached.failedAt >= FAILED_RETRY_MS);
    }).sort((a, b) => counts.get(b) - counts.get(a));
  }

  hasPending(locations) {
    return this.pendingKeys(locations).length > 0;
  }

  async ensureTiles(locations, onProgress) {
    const pending = this.pendingKeys(locations);
    let completed = 0;
    for (const key of pending) {
      onProgress?.(completed, pending.length);
      try {
        const candidates = await queryOverpass(key);
        await enrichWikidata(candidates);
        this.tiles.set(key, { schema: QUERY_SCHEMA_VERSION, fetchedAt: Date.now(), candidates });
      } catch (error) {
        console.warn(`OSM 장소 구역 ${key} 조회 실패:`, error.message);
        this.tiles.set(key, { schema: QUERY_SCHEMA_VERSION, failedAt: Date.now(), candidates: [] });
      }
      completed++;
      await this.saveCache();
      if (completed < pending.length) await delay(1200);
    }
    onProgress?.(completed, pending.length);
  }

  find(latitude, longitude) {
    const tile = this.tiles.get(tileKey(latitude, longitude));
    if (!tile?.fetchedAt) return null;
    return bestCandidate(tile.candidates || [], latitude, longitude);
  }

  async saveCache() {
    const temporary = `${this.cacheFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.tiles))}\n`, 'utf8');
    await rename(temporary, this.cacheFile);
  }
}
