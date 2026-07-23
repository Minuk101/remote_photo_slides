import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ENDPOINT = 'https://places.googleapis.com/v1/places:searchNearby';
const CACHE_SCHEMA_VERSION = 3;
const CLUSTER_SIZE_DEGREES = 0.0025;
const CACHE_TTL_MS = 29 * 24 * 60 * 60 * 1000;
const FAILED_RETRY_MS = 60 * 60 * 1000;
const MONTHLY_REQUEST_LIMIT = 4_000;
const MAX_RESULTS = 20;
const SEARCH_RADIUS_METERS = 500;
const MAX_EXACT_DISTANCE_KM = 0.03;
const MAX_POPULAR_DISTANCE_KM = 0.3;
const NON_VISITOR_PRIMARY_TYPES = new Set([
  '', 'corporate_office', 'electrician', 'general_contractor', 'manufacturer',
  'point_of_interest', 'research_institute', 'service', 'storage',
  'telecommunications_service_provider', 'wholesaler'
]);

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

function isKoreanVisitorPlace(candidate) {
  const letters = candidate.name.match(/\p{L}/gu) || [];
  return letters.length > 0
    && letters.every(letter => /[가-힣]/.test(letter))
    && !NON_VISITOR_PRIMARY_TYPES.has(candidate.primaryType)
    && !/주식회사|\(주\)/.test(candidate.name);
}

function nearestCandidate(candidates, latitude, longitude, maxDistanceKm) {
  let best = null;
  let nearestDistanceKm = Infinity;
  for (const candidate of candidates) {
    if (!isKoreanVisitorPlace(candidate)) continue;
    const distanceKm = haversineKm(latitude, longitude, candidate.latitude, candidate.longitude);
    if (distanceKm > maxDistanceKm || distanceKm >= nearestDistanceKm) continue;
    best = { ...candidate, distanceKm };
    nearestDistanceKm = distanceKm;
  }
  return best;
}

function popularCandidate(candidates, latitude, longitude) {
  for (const candidate of candidates) {
    if (!isKoreanVisitorPlace(candidate)) continue;
    const distanceKm = haversineKm(latitude, longitude, candidate.latitude, candidate.longitude);
    if (distanceKm <= MAX_POPULAR_DISTANCE_KM) return { ...candidate, distanceKm };
  }
  return null;
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
      this.usage = parsed.usage || {};
      if (parsed.schema === CACHE_SCHEMA_VERSION) {
        for (const [key, value] of Object.entries(parsed.clusters || {})) this.clusters.set(key, value);
      } else if (parsed.schema === 2) {
        for (const [key, value] of Object.entries(parsed.clusters || {})) {
          this.clusters.set(key, {
            distanceFetchedAt: value.fetchedAt,
            distanceCandidates: value.candidates || [],
            distanceFailedAt: value.failedAt || null
          });
        }
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
      const distancePending = cached?.distanceFailedAt
        ? now - cached.distanceFailedAt >= FAILED_RETRY_MS
        : !cached?.distanceFetchedAt || now - cached.distanceFetchedAt >= CACHE_TTL_MS;
      const popularPending = cached?.popularFailedAt
        ? now - cached.popularFailedAt >= FAILED_RETRY_MS
        : !cached?.popularFetchedAt || now - cached.popularFetchedAt >= CACHE_TTL_MS;
      if (distancePending) jobs.push({ key, center, mode: 'distance' });
      if (popularPending) jobs.push({ key, center, mode: 'popular' });
    }
    return jobs;
  }

  hasPending(locations) {
    return this.pendingJobs(locations).length > 0;
  }

  async search(latitude, longitude, mode) {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': this.apiKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.location,places.primaryType,places.types'
      },
      body: JSON.stringify({
        maxResultCount: MAX_RESULTS,
        rankPreference: mode === 'popular' ? 'POPULARITY' : 'DISTANCE',
        languageCode: 'ko',
        locationRestriction: {
          circle: { center: { latitude, longitude }, radius: SEARCH_RADIUS_METERS }
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
        this.clusters.set(key, mode === 'popular'
          ? { ...cached, popularFetchedAt: Date.now(), popularCandidates: candidates, popularFailedAt: null }
          : { ...cached, distanceFetchedAt: Date.now(), distanceCandidates: candidates, distanceFailedAt: null });
      } catch (error) {
        console.warn(`Google Places 지역 ${key} ${mode} 조회 실패:`, error.message);
        const cached = this.clusters.get(key) || {};
        this.clusters.set(key, mode === 'popular'
          ? { ...cached, popularFailedAt: Date.now(), popularCandidates: [] }
          : { ...cached, distanceFailedAt: Date.now(), distanceCandidates: [] });
        await this.saveCache();
        throw error;
      }
      completed++;
      await this.saveCache();
    }
    onProgress?.(completed, pending.length, this.status());
  }

  findBest(latitude, longitude) {
    const cached = this.clusters.get(clusterKey(latitude, longitude));
    const now = Date.now();
    if (cached?.distanceFetchedAt && now - cached.distanceFetchedAt < CACHE_TTL_MS) {
      const exact = nearestCandidate(
        cached.distanceCandidates || [],
        latitude,
        longitude,
        MAX_EXACT_DISTANCE_KM
      );
      if (exact) return exact;
    }
    if (!cached?.popularFetchedAt || now - cached.popularFetchedAt >= CACHE_TTL_MS) return null;
    return popularCandidate(cached.popularCandidates || [], latitude, longitude);
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
