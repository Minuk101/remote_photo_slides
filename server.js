import http from 'node:http';
import { createReadStream, watch } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const CACHE_DIR = path.join(__dirname, '.photo-cache');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PHOTO_ROOT = path.resolve(process.env.PHOTO_ROOT || 'D:\\민욱\\사진');
const PORT = Number(process.env.PORT || 8080);
const SCAN_TTL_MS = 10_000;
const IMAGE_WIDTH = 1920;
const IMAGE_HEIGHT = 1080;

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.ico', 'image/x-icon']
]);

let settings = { selectedFolders: [] };
let manifest = { version: '', photos: [], photoFiles: new Map(), scannedAt: 0 };
let scanPromise = null;
let manifestDirty = true;
const imageJobs = new Map();
let folderWatchers = [];
let lastCacheCleanupAt = 0;

await mkdir(DATA_DIR, { recursive: true });
await mkdir(CACHE_DIR, { recursive: true });
await loadSettings();
configureFolderWatchers();

function json(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(body);
}

function safeRelative(input = '') {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('잘못된 폴더 경로입니다.');
  const parts = input.replaceAll('\\', '/').split('/').filter(Boolean);
  const absolute = path.resolve(PHOTO_ROOT, ...parts);
  const relative = path.relative(PHOTO_ROOT, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('허용된 사진 폴더 밖에는 접근할 수 없습니다.');
  return relative === '' ? '' : relative.split(path.sep).join('/');
}

function absoluteFromRelative(relative = '') {
  const safe = safeRelative(relative);
  return path.resolve(PHOTO_ROOT, ...safe.split('/').filter(Boolean));
}

function compareNames(a, b) {
  return a.localeCompare(b, 'ko-KR', { numeric: true, sensitivity: 'base' });
}

function photoId(relative) {
  return crypto.createHash('sha256').update(relative.toLocaleLowerCase('en-US')).digest('base64url').slice(0, 24);
}

async function loadSettings() {
  try {
    const parsed = JSON.parse(await readFile(SETTINGS_FILE, 'utf8'));
    if (Array.isArray(parsed.selectedFolders)) {
      settings.selectedFolders = parsed.selectedFolders.map(safeRelative);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn('설정을 읽지 못했습니다:', error.message);
  }
}

async function saveSettings() {
  const temporary = `${SETTINGS_FILE}.tmp`;
  await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  await rename(temporary, SETTINGS_FILE);
}

function configureFolderWatchers() {
  for (const watcher of folderWatchers) watcher.close();
  folderWatchers = [];
  for (const folder of settings.selectedFolders) {
    try {
      const watcher = watch(absoluteFromRelative(folder), { recursive: true }, () => {
        manifestDirty = true;
      });
      watcher.on('error', error => console.warn('사진 폴더 감시 오류:', error.message));
      folderWatchers.push(watcher);
    } catch (error) {
      console.warn('사진 폴더를 감시하지 못했습니다:', error.message);
    }
  }
}

function removeNestedFolders(folders) {
  const unique = [...new Set(folders.map(safeRelative))].sort((a, b) => a.length - b.length || compareNames(a, b));
  return unique.filter((folder, index) => !unique.some((parent, parentIndex) => {
    if (parentIndex === index) return false;
    if (parent === '') return true;
    return folder.startsWith(`${parent}/`);
  }));
}

async function walkJpegs(relativeFolder, found) {
  const absoluteFolder = absoluteFromRelative(relativeFolder);
  let entries;
  try {
    entries = await readdir(absoluteFolder, { withFileTypes: true });
  } catch (error) {
    console.warn(`폴더를 읽지 못했습니다: ${absoluteFolder}`, error.message);
    return;
  }

  for (const entry of entries) {
    const relative = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await walkJpegs(relative, found);
    } else if (entry.isFile() && /\.jpe?g$/i.test(entry.name)) {
      const absolute = absoluteFromRelative(relative);
      try {
        const fileStat = await stat(absolute);
        found.set(relative.toLocaleLowerCase('en-US'), {
          id: photoId(relative),
          relative,
          absolute,
          name: entry.name,
          size: fileStat.size,
          modifiedAt: Math.trunc(fileStat.mtimeMs)
        });
      } catch {
        // A file may disappear while a large folder is being scanned.
      }
    }
  }
}

async function scanPhotos(force = false) {
  if (!force && !manifestDirty && Date.now() - manifest.scannedAt < SCAN_TTL_MS) return manifest;
  if (scanPromise) return scanPromise;

  scanPromise = (async () => {
    const found = new Map();
    for (const folder of settings.selectedFolders) await walkJpegs(folder, found);

    const files = [...found.values()].sort((a, b) => compareNames(a.relative, b.relative));
    const versionHash = crypto.createHash('sha256');
    for (const file of files) versionHash.update(`${file.relative}\0${file.size}\0${file.modifiedAt}\n`);
    const version = versionHash.digest('base64url').slice(0, 20);
    const photoFiles = new Map(files.map(file => [file.id, file]));
    const photos = files.map(file => ({
      id: file.id,
      name: file.name,
      modifiedAt: file.modifiedAt,
      size: file.size,
      url: `/media/${file.id}?v=${file.modifiedAt}-${file.size}`
    }));

    manifest = { version, photos, photoFiles, scannedAt: Date.now() };
    manifestDirty = false;
    if (Date.now() - lastCacheCleanupAt > 10 * 60 * 1000) {
      lastCacheCleanupAt = Date.now();
      cleanupPlaybackCache(files).catch(error => console.warn('재생 캐시 정리 실패:', error.message));
    }
    return manifest;
  })().finally(() => {
    scanPromise = null;
  });

  return scanPromise;
}

async function cleanupPlaybackCache(files) {
  const keep = new Set(files.map(file => `${file.id}-${file.modifiedAt}-${file.size}.jpg`));
  const cachedFiles = await readdir(CACHE_DIR, { withFileTypes: true });
  await Promise.all(cachedFiles.map(async entry => {
    if (!entry.isFile() || keep.has(entry.name) || entry.name.endsWith('.tmp')) return;
    await unlink(path.join(CACHE_DIR, entry.name)).catch(() => {});
  }));
}

async function listFolders(relative) {
  const safe = safeRelative(relative);
  const entries = await readdir(absoluteFromRelative(safe), { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => ({
      name: entry.name,
      path: safe ? `${safe}/${entry.name}` : entry.name
    }))
    .sort((a, b) => compareNames(a.name, b.name));
}

async function readBody(request, limit = 256 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw new Error('요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function ensurePlaybackImage(file) {
  const key = `${file.id}-${file.modifiedAt}-${file.size}`;
  const cachedPath = path.join(CACHE_DIR, `${key}.jpg`);
  try {
    await stat(cachedPath);
    return cachedPath;
  } catch {
    // Create the playback copy below.
  }

  if (!imageJobs.has(key)) {
    const job = (async () => {
      const temporary = `${cachedPath}.${process.pid}.tmp`;
      await sharp(file.absolute)
        .rotate()
        .resize({
          width: IMAGE_WIDTH,
          height: IMAGE_HEIGHT,
          fit: 'inside',
          withoutEnlargement: true
        })
        .jpeg({ quality: 90, chromaSubsampling: '4:4:4' })
        .toFile(temporary);
      await rename(temporary, cachedPath);
      return cachedPath;
    })().finally(() => imageJobs.delete(key));
    imageJobs.set(key, job);
  }
  return imageJobs.get(key);
}

async function serveMedia(request, response, id) {
  let file = manifest.photoFiles.get(id);
  if (!file) {
    await scanPhotos(true);
    file = manifest.photoFiles.get(id);
  }
  if (!file) return json(response, 404, { error: '사진을 찾을 수 없습니다.' });

  try {
    const playbackPath = await ensurePlaybackImage(file);
    const info = await stat(playbackPath);
    const etag = `\"${file.modifiedAt}-${file.size}\"`;
    if (request.headers['if-none-match'] === etag) {
      response.writeHead(304, { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' });
      return response.end();
    }
    response.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': info.size,
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag
    });
    createReadStream(playbackPath).pipe(response);
  } catch (error) {
    console.error('사진 변환 실패:', file.absolute, error.message);
    json(response, 500, { error: '사진을 준비하지 못했습니다.' });
  }
}

async function serveStatic(response, pathname) {
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const absolute = path.resolve(PUBLIC_DIR, requested);
  const relative = path.relative(PUBLIC_DIR, absolute);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return json(response, 404, { error: '찾을 수 없습니다.' });

  try {
    const file = await open(absolute, 'r');
    const info = await file.stat();
    response.writeHead(200, {
      'Content-Type': mimeTypes.get(path.extname(absolute).toLowerCase()) || 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-cache'
    });
    file.createReadStream().pipe(response);
  } catch {
    json(response, 404, { error: '찾을 수 없습니다.' });
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);

  try {
    if (request.method === 'GET' && url.pathname === '/api/config') {
      let rootAvailable = true;
      try { await stat(PHOTO_ROOT); } catch { rootAvailable = false; }
      return json(response, 200, {
        rootName: path.basename(PHOTO_ROOT),
        rootPath: PHOTO_ROOT,
        rootAvailable,
        selectedFolders: settings.selectedFolders
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/folders') {
      const currentPath = safeRelative(url.searchParams.get('path') || '');
      const folders = await listFolders(currentPath);
      return json(response, 200, { currentPath, folders });
    }

    if (request.method === 'PUT' && url.pathname === '/api/selection') {
      const body = await readBody(request);
      if (!Array.isArray(body.folders)) return json(response, 400, { error: '폴더 목록이 필요합니다.' });
      const selectedFolders = removeNestedFolders(body.folders);
      for (const folder of selectedFolders) {
        const folderStat = await stat(absoluteFromRelative(folder));
        if (!folderStat.isDirectory()) throw new Error(`폴더가 아닙니다: ${folder}`);
      }
      settings = { selectedFolders };
      await saveSettings();
      configureFolderWatchers();
      manifestDirty = true;
      const current = await scanPhotos(true);
      return json(response, 200, {
        selectedFolders,
        photoCount: current.photos.length,
        version: current.version
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/photos') {
      const current = await scanPhotos();
      const knownVersion = url.searchParams.get('version');
      if (knownVersion && knownVersion === current.version) {
        return json(response, 200, { unchanged: true, version: current.version });
      }
      return json(response, 200, {
        unchanged: false,
        version: current.version,
        photos: current.photos
      });
    }

    if (request.method === 'GET' && url.pathname.startsWith('/media/')) {
      const id = url.pathname.slice('/media/'.length);
      if (!/^[A-Za-z0-9_-]{24}$/.test(id)) return json(response, 404, { error: '사진을 찾을 수 없습니다.' });
      return serveMedia(request, response, id);
    }

    if (request.method === 'GET' || request.method === 'HEAD') return serveStatic(response, url.pathname);
    json(response, 405, { error: '허용되지 않은 요청입니다.' }, { Allow: 'GET, PUT, HEAD' });
  } catch (error) {
    console.error(error);
    json(response, 400, { error: error.message || '요청을 처리하지 못했습니다.' });
  }
});

setInterval(() => {
  manifestDirty = true;
}, 5 * 60_000).unref();

server.listen(PORT, '0.0.0.0', () => {
  const addresses = [];
  for (const values of Object.values(os.networkInterfaces())) {
    for (const value of values || []) {
      if (value.family === 'IPv4' && !value.internal) addresses.push(`http://${value.address}:${PORT}`);
    }
  }
  console.log('\nRemote Photo Slides가 실행되었습니다.');
  console.log(`PC에서 열기: http://localhost:${PORT}`);
  for (const address of addresses) console.log(`같은 Wi-Fi에서 열기: ${address}`);
  console.log(`사진 최상위 폴더: ${PHOTO_ROOT}\n`);
});
