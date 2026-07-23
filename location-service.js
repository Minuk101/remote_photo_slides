import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import exifr from 'exifr';
import { OsmLandmarkService } from './osm-landmark-service.js';
import { GooglePlacesService } from './google-places-service.js';

const GEONAMES_BASE = 'https://download.geonames.org/export/dump';
const GEOBOUNDARIES_API = 'https://www.geoboundaries.org/api/current/gbOpen';
const CITY_GRID_SIZE = 0.5;
const LANDMARK_GRID_SIZE = 0.1;
const MAX_CITY_DISTANCE_KM = 250;
const MAX_LANDMARK_DISTANCE_KM = 3;
const LOCATION_SCHEMA_VERSION = 15;
const MAX_FOLDER_HINT_SPREAD_KM = 1;

const FOLDER_LANDMARK_SUFFIXES = [
  '농장', '팜', '호텔', '리조트', '파크', '랜드', '공원', '수목원', '식물원',
  '수족관', '아쿠아리움', '박물관', '미술관', '전시관', '마을', '시장', '해변',
  '비치', '숲', '정원', '나라', '힐', '궁', '성', '사찰', '베이커리', '카페', '타워'
];

const LANDMARK_CODES = new Set([
  'AIRP', 'AMTH', 'AMUS', 'ARCH', 'BCH', 'CAPE', 'CAVE', 'CSTL', 'FLLS', 'GLCR',
  'ISL', 'LK', 'MNMT', 'MSTY', 'MT', 'MUS', 'OPRA', 'PAL', 'PK', 'PRK',
  'PYR', 'RES', 'RSRT', 'RUIN', 'STDM', 'THTR', 'UNIV', 'VLC', 'ZOO'
]);

const VERY_LARGE_LANDMARK_CODES = new Set(['AIRP', 'AMUS', 'RSRT']);
const WIDE_LANDMARK_CODES = new Set(['PRK', 'RES', 'STDM', 'UNIV', 'ZOO']);
const NATURAL_LANDMARK_CODES = new Set(['BCH', 'CAPE', 'CAVE', 'FLLS', 'GLCR', 'ISL', 'LK', 'MT', 'PK', 'VLC']);

const countryNames = new Intl.DisplayNames(['ko'], { type: 'region' });

function gridKey(latitude, longitude, size) {
  return `${Math.floor((latitude + 90) / size)}:${Math.floor((longitude + 180) / size)}`;
}

function localizedName(name, asciiName, alternateNames = '') {
  const alternatives = alternateNames.split(',');
  const selected = alternatives.find(value => /[가-힣]/.test(value)) || name || asciiName;
  if (/에버랜드/.test(selected) || /^everland$/i.test(asciiName)) return '에버랜드';
  return selected;
}

function normalizedName(value = '') {
  return value.normalize('NFKD').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');
}

function countryName(countryCode) {
  try { return countryNames.of(countryCode) || countryCode; } catch { return countryCode; }
}

function folderLandmarkHints(relative = '') {
  const hints = [];
  const folders = relative.split('/').slice(0, -1).reverse();
  for (const folder of folders) {
    const groups = [...folder.matchAll(/\(([^)]+)\)/g)].map(match => match[1]);
    for (const group of groups) {
      const words = group.split(/[,、/&+]|\s+/)
        .map(value => value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
        .filter(value => value.length >= 2 && value.length <= 24);
      for (const word of words) {
        if (FOLDER_LANDMARK_SUFFIXES.some(suffix => word.endsWith(suffix)) && !hints.includes(word)) hints.push(word);
      }
    }
  }
  return hints;
}

function eventFolderKey(relative = '') {
  const folders = relative.split('/').slice(0, -1);
  const eventIndex = folders.findIndex(folder => /\([^)]+\)/.test(folder));
  return eventIndex >= 0 ? folders.slice(0, eventIndex + 1).join('/') : '';
}

function trustedFolderLandmarks(metadata) {
  const groups = new Map();
  for (const [relative, value] of metadata) {
    if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) continue;
    const key = eventFolderKey(relative);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, { hints: new Set(), locations: [] });
    const group = groups.get(key);
    folderLandmarkHints(relative).forEach(hint => group.hints.add(hint));
    group.locations.push({ latitude: value.latitude, longitude: value.longitude });
  }

  const trusted = new Map();
  for (const [key, group] of groups) {
    if (group.hints.size !== 1 || !group.locations.length) continue;
    const center = group.locations.reduce((total, location) => ({
      latitude: total.latitude + location.latitude / group.locations.length,
      longitude: total.longitude + location.longitude / group.locations.length
    }), { latitude: 0, longitude: 0 });
    const spreadKm = Math.max(...group.locations.map(location => haversineKm(
      center.latitude,
      center.longitude,
      location.latitude,
      location.longitude
    )));
    if (spreadKm <= MAX_FOLDER_HINT_SPREAD_KM) trusted.set(key, [...group.hints][0]);
  }
  return trusted;
}

function isUnlocalizedJapaneseName(name, countryCode) {
  return countryCode === 'JP' && !/[가-힣]/.test(name) && /[ぁ-んァ-ヶ一-龯]/u.test(name);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * radians;
  const deltaLon = (lon2 - lon1) * radians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function addToGrid(grid, item, size) {
  const key = gridKey(item.latitude, item.longitude, size);
  if (!grid.has(key)) grid.set(key, []);
  grid.get(key).push(item);
}

function nearestFromGrid(grid, latitude, longitude, size, maxDistanceKm) {
  if (!grid) return null;
  const centerLat = Math.floor((latitude + 90) / size);
  const centerLon = Math.floor((longitude + 180) / size);
  const maxRadius = Math.ceil(maxDistanceKm / (size * 90));
  let nearest = null;
  let nearestDistance = Infinity;

  for (let radius = 0; radius <= maxRadius; radius++) {
    for (let latOffset = -radius; latOffset <= radius; latOffset++) {
      for (let lonOffset = -radius; lonOffset <= radius; lonOffset++) {
        if (radius > 0 && Math.abs(latOffset) !== radius && Math.abs(lonOffset) !== radius) continue;
        const items = grid.get(`${centerLat + latOffset}:${centerLon + lonOffset}`) || [];
        for (const item of items) {
          const distance = haversineKm(latitude, longitude, item.latitude, item.longitude);
          if (distance < nearestDistance) {
            nearest = item;
            nearestDistance = distance;
          }
        }
      }
    }
    if (nearest && nearestDistance <= Math.max(2, radius * size * 70)) break;
  }
  return nearest && nearestDistance <= maxDistanceKm ? { ...nearest, distanceKm: nearestDistance } : null;
}

function nearestRelevantLandmark(grid, latitude, longitude) {
  if (!grid) return null;
  const centerLat = Math.floor((latitude + 90) / LANDMARK_GRID_SIZE);
  const centerLon = Math.floor((longitude + 180) / LANDMARK_GRID_SIZE);
  const maxRadius = Math.ceil(MAX_LANDMARK_DISTANCE_KM / (LANDMARK_GRID_SIZE * 90));
  let best = null;
  let bestScore = Infinity;

  for (let latOffset = -maxRadius; latOffset <= maxRadius; latOffset++) {
    for (let lonOffset = -maxRadius; lonOffset <= maxRadius; lonOffset++) {
      const items = grid.get(`${centerLat + latOffset}:${centerLon + lonOffset}`) || [];
      for (const item of items) {
        const distanceKm = haversineKm(latitude, longitude, item.latitude, item.longitude);
        const allowedDistance = VERY_LARGE_LANDMARK_CODES.has(item.featureCode)
          ? 3
          : (WIDE_LANDMARK_CODES.has(item.featureCode) || NATURAL_LANDMARK_CODES.has(item.featureCode)) ? 1 : 0.3;
        if (distanceKm > allowedDistance) continue;
        const score = distanceKm / allowedDistance;
        if (score < bestScore) {
          best = item;
          bestScore = score;
          best.distanceKm = distanceKm;
        }
      }
    }
  }
  return best;
}

function ringContainsPoint(ring, longitude, latitude) {
  let inside = false;
  for (let current = 0, previous = ring.length - 1; current < ring.length; previous = current++) {
    const [currentLon, currentLat] = ring[current];
    const [previousLon, previousLat] = ring[previous];
    const intersects = (currentLat > latitude) !== (previousLat > latitude)
      && longitude < ((previousLon - currentLon) * (latitude - currentLat)) / (previousLat - currentLat) + currentLon;
    if (intersects) inside = !inside;
  }
  return inside;
}

function polygonContainsPoint(polygon, longitude, latitude) {
  if (!polygon.length || !ringContainsPoint(polygon[0], longitude, latitude)) return false;
  return !polygon.slice(1).some(hole => ringContainsPoint(hole, longitude, latitude));
}

function geometryContainsPoint(geometry, longitude, latitude) {
  if (geometry.type === 'Polygon') return polygonContainsPoint(geometry.coordinates, longitude, latitude);
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some(polygon => polygonContainsPoint(polygon, longitude, latitude));
  }
  return false;
}

function geometryBounds(geometry) {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  const visit = value => {
    if (typeof value[0] === 'number') {
      minLon = Math.min(minLon, value[0]);
      maxLon = Math.max(maxLon, value[0]);
      minLat = Math.min(minLat, value[1]);
      maxLat = Math.max(maxLat, value[1]);
    } else {
      value.forEach(visit);
    }
  };
  visit(geometry.coordinates);
  return { minLon, minLat, maxLon, maxLat };
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function download(url, target) {
  if (await exists(target)) return;
  const temporary = `${target}.${process.pid}.tmp`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'RemotePhotoSlides/1.0 (personal local photo viewer)' }
  });
  if (!response.ok || !response.body) throw new Error(`위치 데이터 다운로드 실패: ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
  await rename(temporary, target);
}

function zipText(zipPath, preferredName) {
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntry(preferredName) || zip.getEntries().find(item => item.entryName.endsWith('.txt'));
  if (!entry) throw new Error(`압축 파일에서 ${preferredName}을 찾을 수 없습니다.`);
  return entry.getData().toString('utf8');
}

export class LocationService {
  constructor(dataDirectory) {
    this.dataDirectory = dataDirectory;
    this.cacheFile = path.join(dataDirectory, 'photo-locations.json');
    this.citiesZip = path.join(dataDirectory, 'cities500.zip');
    this.countryInfoFile = path.join(dataDirectory, 'countryInfo.txt');
    this.metadata = new Map();
    this.cityGrid = null;
    this.landmarkGrids = new Map();
    this.adminBoundaries = new Map();
    this.iso3Codes = new Map();
    this.countryJobs = new Map();
    this.osmLandmarks = new OsmLandmarkService(dataDirectory);
    this.googlePlaces = new GooglePlacesService(dataDirectory);
    this.preparePromise = null;
    this.indexPromise = null;
    this.status = { phase: '대기 중', total: 0, checked: 0, gps: 0, ready: 0 };
  }

  async loadCache() {
    await mkdir(this.dataDirectory, { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.cacheFile, 'utf8'));
      for (const [relative, value] of Object.entries(parsed)) this.metadata.set(relative, value);
    } catch (error) {
      if (error.code !== 'ENOENT') console.warn('GPS 캐시를 읽지 못했습니다:', error.message);
    }
    await this.osmLandmarks.loadCache();
    await this.googlePlaces.load();
  }

  getStatus() {
    return { ...this.status, googlePlaces: this.googlePlaces.status() };
  }

  async setGooglePlacesApiKey(apiKey) {
    return this.googlePlaces.setApiKey(apiKey);
  }

  get(file) {
    const value = this.metadata.get(file.relative);
    if (!value || value.signature !== `${file.modifiedAt}-${file.size}` || !Number.isFinite(value.latitude)) return null;
    return {
      latitude: value.latitude,
      longitude: value.longitude,
      city: value.city || '',
      country: value.country || '',
      landmark: value.landmark || '',
      landmarkDistanceMeters: value.landmarkDistanceMeters || null,
      landmarkSource: value.landmarkSource || ''
    };
  }

  prepare() {
    if (!this.preparePromise) {
      this.preparePromise = this.loadCities().catch(error => {
        this.status.phase = `위치 데이터 준비 실패: ${error.message}`;
        throw error;
      });
    }
    return this.preparePromise;
  }

  async loadCities() {
    this.status.phase = '무료 세계 지명 데이터 준비 중';
    await Promise.all([
      download(`${GEONAMES_BASE}/cities500.zip`, this.citiesZip),
      download(`${GEONAMES_BASE}/countryInfo.txt`, this.countryInfoFile)
    ]);
    const countryInfo = await readFile(this.countryInfoFile, 'utf8');
    for (const line of countryInfo.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const fields = line.split('\t');
      if (fields[0] && fields[1]) this.iso3Codes.set(fields[0], fields[1]);
    }
    const text = zipText(this.citiesZip, 'cities500.txt');
    const grid = new Map();
    for (const line of text.split('\n')) {
      if (!line) continue;
      const fields = line.split('\t');
      const latitude = Number(fields[4]);
      const longitude = Number(fields[5]);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      addToGrid(grid, {
        latitude,
        longitude,
        name: localizedName(fields[1], fields[2], fields[3]),
        countryCode: fields[8]
      }, CITY_GRID_SIZE);
    }
    this.cityGrid = grid;
    this.status.phase = '사진 GPS 분석 대기 중';
  }

  nearestCity(latitude, longitude) {
    return nearestFromGrid(this.cityGrid, latitude, longitude, CITY_GRID_SIZE, MAX_CITY_DISTANCE_KM);
  }

  async loadCountryLandmarks(countryCode) {
    if (!countryCode) return null;
    if (this.landmarkGrids.has(countryCode)) return this.landmarkGrids.get(countryCode);
    if (this.countryJobs.has(countryCode)) return this.countryJobs.get(countryCode);

    const job = (async () => {
      const zipPath = path.join(this.dataDirectory, `${countryCode}.zip`);
      await download(`${GEONAMES_BASE}/${countryCode}.zip`, zipPath);
      const text = zipText(zipPath, `${countryCode}.txt`);
      const grid = new Map();
      const adminNames = new Map();
      for (const line of text.split('\n')) {
        if (!line) continue;
        const fields = line.split('\t');
        if (fields[6] === 'A' && fields[7] === 'ADM2') {
          const localName = localizedName(fields[1], fields[2], fields[3]);
          adminNames.set(normalizedName(fields[1]), localName);
          adminNames.set(normalizedName(fields[2]), localName);
        }
        if (!LANDMARK_CODES.has(fields[7])) continue;
        const latitude = Number(fields[4]);
        const longitude = Number(fields[5]);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
        addToGrid(grid, {
          latitude,
          longitude,
          name: localizedName(fields[1], fields[2], fields[3]),
          featureCode: fields[7]
        }, LANDMARK_GRID_SIZE);
      }
      const bundle = { grid, adminNames };
      this.landmarkGrids.set(countryCode, bundle);
      return bundle;
    })().finally(() => this.countryJobs.delete(countryCode));

    this.countryJobs.set(countryCode, job);
    return job;
  }

  async loadAdminBoundaries(countryCode) {
    if (!countryCode || this.adminBoundaries.has(countryCode)) return this.adminBoundaries.get(countryCode) || null;
    const iso3 = this.iso3Codes.get(countryCode);
    if (!iso3) {
      this.adminBoundaries.set(countryCode, null);
      return null;
    }

    let metadata = null;
    let level = 'ADM2';
    for (const candidate of ['ADM2', 'ADM1']) {
      try {
        const response = await fetch(`${GEOBOUNDARIES_API}/${iso3}/${candidate}/`, {
          headers: { 'User-Agent': 'RemotePhotoSlides/1.0 (https://github.com/Minuk101/remote_photo_slides)' }
        });
        if (!response.ok) continue;
        metadata = await response.json();
        level = candidate;
        break;
      } catch {
        // Try the next available administrative level.
      }
    }
    if (!metadata?.simplifiedGeometryGeoJSON) {
      this.adminBoundaries.set(countryCode, null);
      return null;
    }

    const target = path.join(this.dataDirectory, `${countryCode}-${level}.geojson`);
    await download(metadata.simplifiedGeometryGeoJSON, target);
    const geojson = JSON.parse(await readFile(target, 'utf8'));
    const adminNames = this.landmarkGrids.get(countryCode)?.adminNames || new Map();
    const features = (geojson.features || []).map(feature => {
      const sourceName = feature.properties?.shapeName || '';
      const simpleName = sourceName.replace(/\s*\[.*?\]\s*/g, '');
      return {
        name: adminNames.get(normalizedName(sourceName))
          || adminNames.get(normalizedName(simpleName))
          || simpleName,
        geometry: feature.geometry,
        bounds: geometryBounds(feature.geometry)
      };
    });
    this.adminBoundaries.set(countryCode, features);
    return features;
  }

  findAdministrativeArea(countryCode, latitude, longitude) {
    const features = this.adminBoundaries.get(countryCode);
    if (!features) return '';
    for (const feature of features) {
      const bounds = feature.bounds;
      if (longitude < bounds.minLon || longitude > bounds.maxLon || latitude < bounds.minLat || latitude > bounds.maxLat) continue;
      if (geometryContainsPoint(feature.geometry, longitude, latitude)) return feature.name;
    }
    return '';
  }

  index(files, onComplete) {
    if (this.indexPromise) return this.indexPromise;
    const current = new Set(files.map(file => file.relative));
    const needsWork = files.some(file => {
      const cached = this.metadata.get(file.relative);
      return !cached
        || cached.signature !== `${file.modifiedAt}-${file.size}`
        || !cached.resolved
        || cached.locationSchema !== LOCATION_SCHEMA_VERSION;
    })
      || [...this.metadata.keys()].some(relative => !current.has(relative))
      || this.osmLandmarks.hasPending([...this.metadata.values()])
      || this.googlePlaces.hasPending([...this.metadata.values()])
      || (!this.googlePlaces.enabled && [...this.metadata.values()].some(value => value.landmarkSource === 'google'));
    if (!needsWork) {
      this.status = {
        phase: '위치 정보 준비 완료',
        total: files.length,
        checked: files.length,
        gps: [...this.metadata.values()].filter(value => Number.isFinite(value.latitude)).length,
        ready: [...this.metadata.values()].filter(value => value.city || value.landmark).length
      };
      return Promise.resolve();
    }
    this.indexPromise = this.runIndex(files)
      .then(() => onComplete?.())
      .catch(error => {
        console.warn('사진 GPS 분석 실패:', error.message);
        this.status.phase = `GPS 분석 실패: ${error.message}`;
      })
      .finally(() => { this.indexPromise = null; });
    return this.indexPromise;
  }

  async runIndex(files) {
    await this.prepare();
    const current = new Set(files.map(file => file.relative));
    for (const key of this.metadata.keys()) {
      if (!current.has(key)) this.metadata.delete(key);
    }

    const pending = files.filter(file => {
      const cached = this.metadata.get(file.relative);
      return !cached || cached.signature !== `${file.modifiedAt}-${file.size}`;
    });
    this.status = {
      phase: pending.length ? '사진 GPS 분석 중' : '위치 정보 준비 완료',
      total: files.length,
      checked: files.length - pending.length,
      gps: [...this.metadata.values()].filter(value => Number.isFinite(value.latitude)).length,
      ready: [...this.metadata.values()].filter(value => value.city || value.landmark).length
    };

    let sinceSave = 0;
    for (const file of pending) {
      const signature = `${file.modifiedAt}-${file.size}`;
      let gps;
      try { gps = await exifr.gps(file.absolute); } catch { gps = null; }
      if (gps && Number.isFinite(gps.latitude) && Number.isFinite(gps.longitude)) {
        const city = this.nearestCity(gps.latitude, gps.longitude);
        this.metadata.set(file.relative, {
          signature,
          latitude: gps.latitude,
          longitude: gps.longitude,
          city: city?.name || '',
          countryCode: city?.countryCode || '',
          country: city?.countryCode ? countryName(city.countryCode) : '',
          locationSchema: LOCATION_SCHEMA_VERSION,
          resolved: false
        });
        this.status.gps++;
      } else {
        this.metadata.set(file.relative, { signature, locationSchema: LOCATION_SCHEMA_VERSION, resolved: true });
      }
      this.status.checked++;
      sinceSave++;
      if (sinceSave >= 100) {
        await this.saveCache();
        sinceSave = 0;
      }
    }
    await this.saveCache();

    const countries = [...new Set([...this.metadata.values()]
      .map(value => value.countryCode)
      .filter(Boolean))];
    for (const countryCode of countries) {
      this.status.phase = `${countryName(countryCode)} 랜드마크 준비 중`;
      try { await this.loadCountryLandmarks(countryCode); } catch (error) {
        console.warn(`${countryCode} 랜드마크 데이터를 준비하지 못했습니다:`, error.message);
      }
      this.status.phase = `${countryName(countryCode)} 행정구역 준비 중`;
      try { await this.loadAdminBoundaries(countryCode); } catch (error) {
        console.warn(`${countryCode} 행정구역 데이터를 준비하지 못했습니다:`, error.message);
      }
    }

    this.status.phase = '가까운 장소 계산 중';
    for (const value of this.metadata.values()) {
      value.locationSchema = LOCATION_SCHEMA_VERSION;
      value.resolved = true;
      value.landmark = '';
      value.landmarkDistanceMeters = null;
      value.landmarkSource = '';
      value.googlePlaceId = '';
      if (!Number.isFinite(value.latitude)) continue;
      if (!value.countryCode) {
        continue;
      }
      const administrativeArea = this.findAdministrativeArea(
        value.countryCode,
        value.latitude,
        value.longitude
      );
      if (administrativeArea) value.city = administrativeArea;
      const grid = this.landmarkGrids.get(value.countryCode)?.grid;
      const landmark = nearestRelevantLandmark(grid, value.latitude, value.longitude);
      if (landmark && landmark.name !== value.city) {
        value.landmark = landmark.name;
        value.landmarkDistanceMeters = Math.round(landmark.distanceKm * 1000);
        value.landmarkSource = 'geonames';
      }
    }

    await this.osmLandmarks.ensureTiles([...this.metadata.values()], (completed, total) => {
      this.status.phase = total
        ? `유명 장소 자동 검색 중 · ${completed}/${total}개 지역`
        : '유명 장소 자동 검색 완료';
    });
    for (const value of this.metadata.values()) {
      if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) continue;
      const onlineLandmark = this.osmLandmarks.find(value.latitude, value.longitude);
      if (!onlineLandmark || onlineLandmark.name === value.city) continue;
      value.landmark = onlineLandmark.name;
      value.landmarkDistanceMeters = Math.round(onlineLandmark.distanceKm * 1000);
      value.landmarkSource = 'osm';
    }

    let googleError = '';
    if (this.googlePlaces.enabled) {
      try {
        await this.googlePlaces.ensureClusters([...this.metadata.values()], (completed, total, googleStatus) => {
          this.status.phase = total
            ? `Google 유명 장소 검색 중 · ${completed}/${total}개 지역 · 이번 달 ${googleStatus.usedThisMonth}/${googleStatus.monthlyLimit}회`
            : 'Google 유명 장소 검색 완료';
        });
      } catch (error) {
        googleError = error.message;
      }
      for (const [relative, value] of this.metadata) {
        if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) continue;
        const hints = folderLandmarkHints(relative);
        const googleLandmark = this.googlePlaces.find(value.latitude, value.longitude, hints);
        if (!googleLandmark
          || googleLandmark.name === value.city
          || isUnlocalizedJapaneseName(googleLandmark.name, value.countryCode)) continue;
        value.landmark = googleLandmark.name;
        value.landmarkDistanceMeters = Math.round(googleLandmark.distanceKm * 1000);
        value.landmarkSource = 'google';
        value.googlePlaceId = googleLandmark.placeId;
      }
      for (const [relative, value] of this.metadata) {
        if (!Number.isFinite(value.latitude) || !Number.isFinite(value.longitude)) continue;
        const hints = folderLandmarkHints(relative);
        const exactVenue = this.googlePlaces.findExactVenue(value.latitude, value.longitude, hints);
        if (!exactVenue
          || exactVenue.name === value.city
          || isUnlocalizedJapaneseName(exactVenue.name, value.countryCode)) continue;
        value.landmark = exactVenue.name;
        value.landmarkDistanceMeters = Math.round(exactVenue.distanceKm * 1000);
        value.landmarkSource = 'google';
        value.googlePlaceId = exactVenue.placeId;
      }
    }
    const folderLandmarks = trustedFolderLandmarks(this.metadata);
    for (const [relative, value] of this.metadata) {
      if (!Number.isFinite(value.latitude) || value.landmark) continue;
      const hint = folderLandmarks.get(eventFolderKey(relative)) || '';
      if (!hint || hint === value.city) continue;
      value.landmark = hint;
      value.landmarkDistanceMeters = null;
      value.landmarkSource = 'folder';
    }
    await this.saveCache();
    this.status.ready = [...this.metadata.values()].filter(value => value.city || value.landmark).length;
    this.status.phase = googleError
      ? `위치 정보 준비 완료 · Google 검색 실패: ${googleError}`
      : '위치 정보 준비 완료';
  }

  async saveCache() {
    const temporary = `${this.cacheFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.metadata))}\n`, 'utf8');
    await rename(temporary, this.cacheFile);
  }
}
