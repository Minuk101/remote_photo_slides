import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import exifr from 'exifr';

const GEONAMES_BASE = 'https://download.geonames.org/export/dump';
const CITY_GRID_SIZE = 0.5;
const LANDMARK_GRID_SIZE = 0.1;
const MAX_CITY_DISTANCE_KM = 250;
const MAX_LANDMARK_DISTANCE_KM = 2;
const LOCATION_SCHEMA_VERSION = 1;

const LANDMARK_CODES = new Set([
  'AIRP', 'AMTH', 'ARCH', 'BCH', 'CAPE', 'CAVE', 'CSTL', 'FLLS', 'GLCR',
  'ISL', 'LK', 'MNMT', 'MSTY', 'MT', 'MUS', 'OPRA', 'PAL', 'PK', 'PRK',
  'PYR', 'RES', 'RSRT', 'RUIN', 'STDM', 'THTR', 'UNIV', 'VLC', 'ZOO'
]);

const countryNames = new Intl.DisplayNames(['ko'], { type: 'region' });

function gridKey(latitude, longitude, size) {
  return `${Math.floor((latitude + 90) / size)}:${Math.floor((longitude + 180) / size)}`;
}

function localizedName(name, asciiName, alternateNames = '') {
  const alternatives = alternateNames.split(',');
  return alternatives.find(value => /[가-힣]/.test(value)) || name || asciiName;
}

function countryName(countryCode) {
  try { return countryNames.of(countryCode) || countryCode; } catch { return countryCode; }
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
    this.metadata = new Map();
    this.cityGrid = null;
    this.landmarkGrids = new Map();
    this.countryJobs = new Map();
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
  }

  getStatus() {
    return { ...this.status };
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
      landmarkDistanceMeters: value.landmarkDistanceMeters || null
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
    await download(`${GEONAMES_BASE}/cities500.zip`, this.citiesZip);
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
      for (const line of text.split('\n')) {
        if (!line) continue;
        const fields = line.split('\t');
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
      this.landmarkGrids.set(countryCode, grid);
      return grid;
    })().finally(() => this.countryJobs.delete(countryCode));

    this.countryJobs.set(countryCode, job);
    return job;
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
    }) || [...this.metadata.keys()].some(relative => !current.has(relative));
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
    }

    this.status.phase = '가까운 장소 계산 중';
    for (const value of this.metadata.values()) {
      value.locationSchema = LOCATION_SCHEMA_VERSION;
      value.resolved = true;
      value.landmark = '';
      value.landmarkDistanceMeters = null;
      if (!Number.isFinite(value.latitude)) continue;
      if (!value.countryCode) {
        continue;
      }
      const grid = this.landmarkGrids.get(value.countryCode);
      const landmark = nearestFromGrid(
        grid,
        value.latitude,
        value.longitude,
        LANDMARK_GRID_SIZE,
        MAX_LANDMARK_DISTANCE_KM
      );
      if (landmark && landmark.name !== value.city) {
        value.landmark = landmark.name;
        value.landmarkDistanceMeters = Math.round(landmark.distanceKm * 1000);
      }
    }
    await this.saveCache();
    this.status.ready = [...this.metadata.values()].filter(value => value.city || value.landmark).length;
    this.status.phase = '위치 정보 준비 완료';
  }

  async saveCache() {
    const temporary = `${this.cacheFile}.tmp`;
    await writeFile(temporary, `${JSON.stringify(Object.fromEntries(this.metadata))}\n`, 'utf8');
    await rename(temporary, this.cacheFile);
  }
}
