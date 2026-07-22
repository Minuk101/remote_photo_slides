const SLIDE_INTERVAL_MS = 5000;
const RETRY_INTERVAL_MS = 3000;
const MANIFEST_POLL_MS = 30000;
const QUEUE_SIZE = 12;
const PREFETCH_AHEAD = 4;
const MAX_MEMORY_BLOBS = 5;
const MAX_DISK_ENTRIES = 80;
const MAX_DISK_BYTES = 400 * 1024 * 1024;
const DB_NAME = 'remote-photo-slides';
const DB_VERSION = 2;

let photos = [];
let manifestVersion = '';
let queue = [];
let played = new Set();
let currentPhotoId = null;
let advancing = false;
let slideTimer = null;
let lastTransitionAt = Date.now();
let activeLayer = 0;
let activeObjectUrl = null;
let databasePromise = null;
const memoryCache = new Map();
const pendingLoads = new Map();

const layers = [
  { image: document.getElementById('img1'), background: document.getElementById('bg1') },
  { image: document.getElementById('img2'), background: document.getElementById('bg2') }
];
const emptyState = document.getElementById('empty-state');
const emptyTitle = document.getElementById('empty-title');
const emptyMessage = document.getElementById('empty-message');
const connectionMessage = document.getElementById('connection-message');

function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('photos')) {
        const store = db.createObjectStore('photos', { keyPath: 'id' });
        store.createIndex('lastAccess', 'lastAccess');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

async function dbGetMeta(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('meta', 'readonly').objectStore('meta').get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function dbPutMeta(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put(value, key);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function dbGet(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('photos', 'readonly').objectStore('photos').get(id);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function dbPut(entry) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('photos', 'readwrite');
    transaction.objectStore('photos').put(entry);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

async function dbAll() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('photos', 'readonly').objectStore('photos').getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function dbDelete(ids) {
  if (ids.length === 0) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('photos', 'readwrite');
    const store = transaction.objectStore('photos');
    ids.forEach(id => store.delete(id));
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
}

function rememberBlob(id, blob) {
  memoryCache.delete(id);
  memoryCache.set(id, blob);
  while (memoryCache.size > MAX_MEMORY_BLOBS) {
    memoryCache.delete(memoryCache.keys().next().value);
  }
}

async function trimDiskCache() {
  const entries = await dbAll();
  entries.sort((a, b) => b.lastAccess - a.lastAccess);
  let total = 0;
  const remove = [];
  entries.forEach((entry, index) => {
    total += entry.size || entry.blob?.size || 0;
    if (index >= MAX_DISK_ENTRIES || total > MAX_DISK_BYTES) remove.push(entry.id);
  });
  await dbDelete(remove);
}

async function getPhotoBlob(photo) {
  if (memoryCache.has(photo.id)) {
    const blob = memoryCache.get(photo.id);
    rememberBlob(photo.id, blob);
    return blob;
  }
  if (pendingLoads.has(photo.id)) return pendingLoads.get(photo.id);

  const promise = (async () => {
    const version = `${photo.modifiedAt}-${photo.size}`;
    const cached = await dbGet(photo.id);
    if (cached && cached.version === version) {
      cached.lastAccess = Date.now();
      dbPut(cached).catch(() => {});
      rememberBlob(photo.id, cached.blob);
      return cached.blob;
    }

    const response = await fetch(photo.url, { cache: 'force-cache' });
    if (!response.ok) throw new Error(`사진 다운로드 실패: ${response.status}`);
    const blob = await response.blob();
    rememberBlob(photo.id, blob);
    await dbPut({ id: photo.id, version, blob, size: blob.size, lastAccess: Date.now() });
    trimDiskCache().catch(() => {});
    return blob;
  })().finally(() => pendingLoads.delete(photo.id));

  pendingLoads.set(photo.id, promise);
  return promise;
}

function shuffle(items) {
  for (let index = items.length - 1; index > 0; index--) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }
  return items;
}

function refillQueue() {
  if (photos.length === 0) return;
  const queued = new Set(queue.map(photo => photo.id));
  let candidates = photos.filter(photo => !played.has(photo.id) && !queued.has(photo.id) && photo.id !== currentPhotoId);
  if (candidates.length === 0) {
    played.clear();
    if (currentPhotoId) played.add(currentPhotoId);
    candidates = photos.filter(photo => !queued.has(photo.id) && photo.id !== currentPhotoId);
  }
  shuffle(candidates);
  while (queue.length < QUEUE_SIZE && candidates.length > 0) queue.push(candidates.shift());
}

function prefetchSlides() {
  for (const photo of queue.slice(0, PREFETCH_AHEAD)) {
    getPhotoBlob(photo).catch(() => {});
  }
}

function showPhoto(blob) {
  const nextLayerIndex = activeLayer === 0 ? 1 : 0;
  const current = layers[activeLayer];
  const next = layers[nextLayerIndex];
  const oldUrl = activeObjectUrl;
  const newUrl = URL.createObjectURL(blob);
  const origins = ['center center', 'left top', 'right top', 'left bottom', 'right bottom'];

  next.image.style.transition = 'none';
  next.image.style.transform = 'scale(1)';
  next.image.style.transformOrigin = origins[Math.floor(Math.random() * origins.length)];
  next.background.style.transition = 'none';
  next.image.src = newUrl;
  next.background.src = newUrl;
  void next.image.offsetHeight;

  next.image.style.transition = 'transform 5s ease-out, opacity 2s';
  next.image.style.transform = 'scale(1.05)';
  next.image.style.opacity = '1';
  next.background.style.transition = 'opacity 2s';
  next.background.style.opacity = '1';
  current.image.style.opacity = '0';
  current.background.style.opacity = '0';

  activeLayer = nextLayerIndex;
  activeObjectUrl = newUrl;
  setTimeout(() => {
    current.image.removeAttribute('src');
    current.background.removeAttribute('src');
    if (oldUrl) URL.revokeObjectURL(oldUrl);
  }, 2200);
}

function scheduleNext(delay = SLIDE_INTERVAL_MS) {
  clearTimeout(slideTimer);
  slideTimer = setTimeout(advanceSlide, delay);
}

async function advanceSlide() {
  if (advancing || photos.length === 0) return;
  advancing = true;
  let photo;
  try {
    refillQueue();
    photo = queue.shift() || photos[Math.floor(Math.random() * photos.length)];
    currentPhotoId = photo.id;
    played.add(photo.id);
    refillQueue();
    prefetchSlides();
    const blob = await getPhotoBlob(photo);
    showPhoto(blob);
    lastTransitionAt = Date.now();
    scheduleNext();
  } catch (error) {
    console.warn(error);
    if (photo) queue.push(photo);
    showConnectionMessage('사진 연결을 다시 시도하고 있습니다.');
    scheduleNext(RETRY_INTERVAL_MS);
  } finally {
    advancing = false;
  }
}

function showConnectionMessage(message = '') {
  connectionMessage.textContent = message;
  connectionMessage.classList.toggle('visible', Boolean(message));
}

async function removeStaleCache(validIds) {
  try {
    const entries = await dbAll();
    await dbDelete(entries.filter(entry => !validIds.has(entry.id)).map(entry => entry.id));
  } catch {
    // Cache cleanup is optional; playback can continue without it.
  }
}

async function refreshManifest(initial = false) {
  try {
    const suffix = manifestVersion ? `?version=${encodeURIComponent(manifestVersion)}` : '';
    const response = await fetch(`/api/photos${suffix}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`목록 확인 실패: ${response.status}`);
    const result = await response.json();
    showConnectionMessage('');
    if (result.unchanged) return;

    await applyManifest(result, initial);
    dbPutMeta('manifest', { version: result.version || '', photos: result.photos || [] }).catch(() => {});
  } catch (error) {
    console.warn(error);
    showConnectionMessage('PC 서버 연결이 끊겼습니다. 저장된 사진으로 계속 재생합니다.');
    if (photos.length === 0) {
      emptyTitle.textContent = 'PC 서버에 연결할 수 없습니다';
      emptyMessage.textContent = 'PC와 Wi-Fi 연결을 확인해주세요.';
    }
  }
}

async function applyManifest(result, initial = false, cachedOnlyIds = null) {
    photos = (result.photos || []).filter(photo => !cachedOnlyIds || cachedOnlyIds.has(photo.id));
    manifestVersion = cachedOnlyIds ? '' : (result.version || '');
    const validIds = new Set(photos.map(photo => photo.id));
    played = new Set([...played].filter(id => validIds.has(id)));
    queue = queue.filter(photo => validIds.has(photo.id));
    if (!cachedOnlyIds) removeStaleCache(validIds);

    if (photos.length === 0) {
      emptyState.classList.remove('hidden');
      emptyTitle.textContent = '재생할 사진이 없습니다';
      emptyMessage.textContent = '사진 폴더 관리에서 폴더를 선택해주세요.';
      clearTimeout(slideTimer);
      return false;
    }

    emptyState.classList.add('hidden');
    refillQueue();
    prefetchSlides();
    if (initial || !slideTimer) advanceSlide();
    return true;
}

async function bootstrap() {
  let startedFromCache = false;
  try {
    const [savedManifest, cachedEntries] = await Promise.all([dbGetMeta('manifest'), dbAll()]);
    if (savedManifest?.photos?.length && cachedEntries.length) {
      const cachedIds = new Set(cachedEntries.map(entry => entry.id));
      startedFromCache = await applyManifest(savedManifest, true, cachedIds);
    }
  } catch (error) {
    console.warn('저장된 슬라이드 목록을 읽지 못했습니다.', error);
  }
  await refreshManifest(!startedFromCache);
}

async function enterFullscreen() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  } catch {
    // Fullscreen always requires a browser-supported user gesture.
  }
}

document.getElementById('fullscreen').addEventListener('click', enterFullscreen);
document.addEventListener('click', event => {
  if (!event.target.closest('button, a') && photos.length > 0) enterFullscreen();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() - lastTransitionAt > SLIDE_INTERVAL_MS * 2) advanceSlide();
});

setInterval(() => refreshManifest(false), MANIFEST_POLL_MS);
setInterval(() => {
  if (photos.length > 0 && !advancing && Date.now() - lastTransitionAt > 60_000) advanceSlide();
}, 10_000);

bootstrap();
