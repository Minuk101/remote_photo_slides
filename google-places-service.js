import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const CACHE_SCHEMA_VERSION = 1;
const CLUSTER_SIZE_DEGREES = 0.0025;
const CACHE_TTL_MS = 29 * 24 * 60 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 60 * 1000;
const MONTHLY_REQUEST_LIMIT = 4_000;
const MAX_RESULTS = 20;
const EXACT_VENUE_SCHEMA_VERSION = 1;

const LANDMARK_TYPES = [
  'amusement_park', 'aquarium', 'art_gallery', 'botanical_garden', 'castle',
  'cultural_landmark', 'garden', 'historical_landmark', 'historical_place',
  'marina', 'monument', 'museum', 'national_park', 'observation_deck', 'park',
  'scenic_spot', 'state_park', 'tourist_attraction', 'visitor_center',
  'water_park', 'wildlife_park', 'wildlife_refuge', 'zoo'
];

const EXACT_VENUE_TYPES = ['farm', 'hotel', 'resort_hotel'];

const EXACT_VENUE_MAX_DISTANCE_KM = {
  farm: 0.35,
  hotel: 0.5,
  resort_hotel: 0.7
};

const TYPE_RULES = {
  amusement_park: [180, 4], aquarium: [180, 2], botanical_garden: [145, 2],
  castle: [150, 1.5], cultural_landmark: [145, 0.6], garden: [125, 0.35],
  historical_landmark: [145, 0.6], historical_place: [135, 0.6],
  marina: [105, 1], monument: [135, 0.4], museum: [140, 0.5],
  national_park: [145, 5], observation_deck: [140, 1], park: [100, 1],
  scenic_spot: [135, 1.5], state_park: [130, 3], tourist_attraction: [125, 0.6],
  visitor_center: [75, 0.3], water_park: [165, 3], wildlife_park: [155, 3],
  wildlife_refuge: [135, 3], zoo: [170, 3], art_gallery: [105, 0.5]
};

function monthKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function clusterKey(latitude, longitude) {
  return `${Math.floor((latitude + 90) / CLUSTER_SIZE_DEGREES)}:${Math.floor((longitude + 180) / CLUSTER_SIZE_DEGREES)}`;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * radians;
  const deltaLon = (lon2 - lon1) * radians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizedName(value = '') {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

function nameMatchesHints(name, hints = []) {
  const normalized = normalizedName(name);
  return hints.some(hint => {
    const expected = normalizedName(hint);
    return expected.length >= 2 && (
      normalized.includes(expected)
      || expected.includes(normalized)
      || (expected.length >= 4 && normalized.endsWith(expected.slice(-3)))
    );
  });
}

function bestCandidate(candidates, latitude, longitude, hints = []) {
  let best = null;
  let bestScore = 95;
  candidates.forEach((candidate, popularityIndex) => {
    const [typeScore, allowedDistanceKm] = TYPE_RULES[candidate.primaryType] || [90, 0.6];
    const distanceKm = haversineKm(latitude, longitude, candidate.latitude, candidate.longitude);
    if (distanceKm > allowedDistanceKm) return;
    const popularity = Math.max(0, 70 - popularityIndex * 4);
    const proximity = Math.max(0, 55 * (1 - distanceKm / allowedDistanceKm));
    const folderMatch = nameMatchesHints(candidate.name, hints) ? 220 : 0;
    const score = typeScore + popularity + proximity + folderMatch;
    if (score > bestScore) {
      best = { ...candidate, distanceKm, score };
      bestScore = score;
    }
  });
  return best;
}

function exactVenueCandidate(candidates, latitude, longitude, hints = []) {
  if (!hints.length) return null;
  let best = null;
  let nearestDistanceKm = Infinity;
  for (const candidate of candidates) {
    if (hints.length && !nameMatchesHints(candidate.name, hints)) continue;
    const matchedType = EXACT_VENUE_MAX_DISTANCE_KM[candidate.primaryType]
      ? candidate.primaryType
      : '';
    if (!matchedType) continue;
    const distanceKm = haversineKm(latitude, longitude, candidate.latitude, candidate.longitude);
    if (distanceKm > EXACT_VENUE_MAX_DISTANCE_KM[matchedType] || distanceKm >= nearestDistanceKm) continue;
    best = { ...candidate, distanceKm, matchedType };
    nearestDistanceKm = distanceKm;
  }
  return best;
}

function compactPlace(place) {
  const latitude = Number(place.location?.latitude);
  const longitude = Number(place.location?.longitude);
  if (!place.id || !place.displayName?.text || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    placeId: place.id,
    name: place.displayName.text,
    latitude,
    longitude,
    primaryType: place.primaryType || '',
    types: place.types || []
  };
}

export class GooglePlacesService {
  constructor(dataDirectory) {
    this.configFile = path.join(dataDirectory, 'google-places-config.json');
    this.cacheFile = path.join(dataDirectory, 'google-places-cache.json');
    this.configuredApiKey = '';
    this.clusters = new Map();
    this.usage = {};
  }

  get apiKey() {
    return process.env.GOOGLE_PLACES_API_KEY || this.configuredApiKey;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async load() {
    await mkdir(path.dirname(this.cacheFile), { recursive: true });
    try {
      const config = JSON.parse(await readFile(this.configFile, 'utf8'));
      this.configuredApiKey = typeof config.apiKey === 'string' ? config.apiKey.trim() : '';
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Google Places 설정을 읽지 못했습니다:', error.message);
    }
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      if (parsed.schema === CACHE_SCHEMA_VERSION) {
        for (const [key, value] of Object.entries(parsed.clusters || {})) this.clusters.set(key, value);
        this.usage = parsed.usage || {};
      }
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('Google Places 캐시를 읽지 못했습니다:', error.message);
    }
  }

  status() {
    const month = monthKey();
    return {
      configured: this.enabled,
      configuredByEnvironment: Boolean(process.env.GOOGLE_PLACES_API_KEY),
      usedThisMonth: Number(this.usage[month] || 0),
      monthlyLimit: MONTHLY_REQUEST_LIMIT
    };
  }

  async setApiKey(apiKey) {
    if (process.env.GOOGLE_PLACES_API_KEY) {
      throw new Error('API 키가 PC 환경 변수로 설정되어 있어 관리 화면에서는 바꿀 수 없습니다.');
    }
    const clean = typeof apiKey === 'string' ? apiKey.trim() : '';
    if (clean && (clean.length < 20 || clean.length > 200)) throw new Error('Google Places API 키 형식을 확인해주세요.');
    this.configuredApiKey = clean;
    for (const [key, value] of this.clusters) {
      if (value.failedAt) this.clusters.delete(key);
    }
    const temporary = `${this.configFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ apiKey: clean }, null, 2)}\n`, 'utf8');
    await rename(temporary, this.configFile);
    return this.status();
  }

  groupLocations(locations) {
    const groups = new Map();
    for (const value of locations) {
      if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) continue;
      const key = clusterKey(value.latitude, value.longitude);
      if (!groups.has(key)) groups.set(key, { latitudeTotal: 0, longitudeTotal: 0, count: 0 });
      const group = groups.get(key);
      group.latitudeTotal += value.latitude;
      group.longitudeTotal += value.longitude;
      group.count++;
    }
    return new Map([...groups].map(([key, value]) => [key, {
      latitude: value.latitudeTotal / value.count,
      longitude: value.longitudeTotal / value.count,
      count: value.count
    }]));
  }

  pendingJobs(locations) {
    if (!this.enabled) return [];
    if (Number(this.usage[monthKey()] || 0) >= MONTHLY_REQUEST_LIMIT) return [];
    const now = Date.now();
    const groups = [...this.groupLocations(locations)].sort((a, b) => b[1].count - a[1].count);
    const jobs = [];
    for (const [key, center] of groups) {
      const cached = this.clusters.get(key);
      const popularPending = !cached
        || (cached.failedAt ? now - cached.failedAt >= FAILED_RETRY_MS : !cached.fetchedAt || now - cached.fetchedAt >= CACHE_TTL_MS);
      const exactPending = !cached
        || cached.exactSchema !== EXACT_VENUE_SCHEMA_VERSION
        || (cached.exactFailedAt
          ? now - cached.exactFailedAt >= FAILED_RETRY_MS
          : !cached.exactFetchedAt || now - cached.exactFetchedAt >= CACHE_TTL_MS);
      if (popularPending) jobs.push({ key, center, mode: 'popular' });
      if (exactPending) jobs.push({ key, center, mode: 'exact' });
    }
    return jobs;
  }

  hasPending(locations) {
    return this.pendingJobs(locations).length > 0;
  }

  async search(latitude, longitude, mode = 'popular') {
    const exact = mode === 'exact';
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType,places.types'
      },
      body: JSON.stringify({
        includedTypes: exact ? EXACT_VENUE_TYPES : LANDMARK_TYPES,
        maxResultCount: MAX_RESULTS,
        rankPreference: exact ? 'DISTANCE' : 'POPULARITY',
        languageCode: 'ko',
        locationRestriction: {
          circle: { center: { latitude, longitude }, radius: exact ? 1000 : 5000 }
        }
      }),
      signal: AbortSignal.timeout(20_000)
    });
    if (!response.ok) {
      let message = `Google Places ${response.status}`;
      try { message = (await response.json()).error?.message || message; } catch {}
      throw new Error(message);
    }
    const result = await response.json();
    return (result.places || []).map(compactPlace).filter(Boolean);
  }

  async ensureClusters(locations, onProgress) {
    const pending = this.pendingJobs(locations);
    const month = monthKey();
    let completed = 0;
    for (const { key, center, mode } of pending) {
      onProgress?.(completed, pending.length, this.status());
      if (!this.enabled || Number(this.usage[month] || 0) >= MONTHLY_REQUEST_LIMIT) break;
      this.usage[month] = Number(this.usage[month] || 0) + 1;
      await this.saveCache();
      try {
        const candidates = await this.search(center.latitude, center.longitude, mode);
        const cached = this.clusters.get(key) || {};
        this.clusters.set(key, mode === 'exact'
          ? {
              ...cached,
              exactSchema: EXACT_VENUE_SCHEMA_VERSION,
              exactFetchedAt: Date.now(),
              exactCandidates: candidates,
              exactFailedAt: null
            }
          : { ...cached, fetchedAt: Date.now(), candidates, failedAt: null });
      } catch (error) {
        console.warn(`Google Places 지역 ${key} ${mode} 조회 실패:`, error.message);
        const cached = this.clusters.get(key) || {};
        this.clusters.set(key, mode === 'exact'
          ? {
              ...cached,
              exactSchema: EXACT_VENUE_SCHEMA_VERSION,
              exactFailedAt: Date.now(),
              exactCandidates: []
            }
          : { ...cached, failedAt: Date.now(), candidates: [] });
        await this.saveCache();
        throw error;
      }
      completed++;
      await this.saveCache();
    }
    onProgress?.(completed, pending.length, this.status());
  }

  find(latitude, longitude, hints = []) {
    const cached = this.clusters.get(clusterKey(latitude, longitude));
    if (!cached?.fetchedAt || Date.now() - cached.fetchedAt >= CACHE_TTL_MS) return null;
    return bestCandidate(cached.candidates || [], latitude, longitude, hints);
  }

  findExactVenue(latitude, longitude, hints = []) {
    const cached = this.clusters.get(clusterKey(latitude, longitude));
    if (cached?.exactSchema !== EXACT_VENUE_SCHEMA_VERSION
      || !cached.exactFetchedAt
      || Date.now() - cached.exactFetchedAt >= CACHE_TTL_MS) return null;
    return exactVenueCandidate(cached.exactCandidates || [], latitude, longitude, hints);
  }

  async saveCache() {
    const currentMonth = monthKey();
    this.usage = Object.fromEntries(Object.entries(this.usage).filter(([key]) => key === currentMonth));
    const temporary = `${this.cacheFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify({
      schema: CACHE_SCHEMA_VERSION,
      clusters: Object.fromEntries(this.clusters),
      usage: this.usage
    })}\n`, 'utf8');
    await rename(temporary, this.cacheFile);
  }
}
