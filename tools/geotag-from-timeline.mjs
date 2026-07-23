import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HOUR_MS = 60 * 60 * 1000;
const MAX_NEAREST_SECONDS = 15 * 60;
const MAX_INTERPOLATION_SECONDS = 30 * 60;
const MAX_STATIONARY_SECONDS = 4 * 60 * 60;
const MAX_STATIONARY_DISTANCE_KM = 0.5;
const MAX_VALIDATION_MEDIAN_KM = 3;
const OFFSET_CANDIDATES = [9, 10];

function option(name, fallback = '') {
  const argument = process.argv.find(value => value.startsWith(`${name}=`));
  return argument ? argument.slice(name.length + 1) : fallback;
}

const writeMode = process.argv.includes('--write');
const applyReportPath = option('--apply-report');
const assignmentLimit = Number(option('--limit', '0'));
const gpxPath = option('--gpx', 'D:\\민욱\\타임라인\\google_maps\\260723\\timeline_export_1784779939485.gpx');
const roots = option('--roots', 'D:\\민욱\\사진\\2025|D:\\민욱\\사진\\2026').split('|');
const reportDirectory = option('--report-dir', path.dirname(gpxPath));

function parseExifLocal(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], Math.floor(+match[6]), (+match[6] % 1) * 1000);
}

function parseGpsUtc(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
  if (!match) return null;
  return Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], Math.floor(+match[6]), (+match[6] % 1) * 1000);
}

function parseOffset(value) {
  const match = String(value || '').match(/^([+-])(\d{2}):?(\d{2})$/);
  if (!match) return null;
  return (match[1] === '-' ? -1 : 1) * (+match[2] + +match[3] / 60);
}

function eventFolder(sourceFile) {
  const normalized = path.resolve(sourceFile);
  const root = roots.find(candidate => {
    const relative = path.relative(path.resolve(candidate), normalized);
    return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
  if (!root) return '';
  return path.relative(path.resolve(root), normalized).split(path.sep)[0] || '';
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const deltaLat = (lat2 - lat1) * radians;
  const deltaLon = (lon2 - lon1) * radians;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(deltaLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

function parseGpx(xml) {
  const points = [];
  let segment = 0;
  for (const segmentMatch of xml.matchAll(/<trkseg>([\s\S]*?)<\/trkseg>/g)) {
    for (const match of segmentMatch[1].matchAll(/<trkpt\s+lat="([^"]+)"\s+lon="([^"]+)">[\s\S]*?<time>([^<]+)<\/time>[\s\S]*?<\/trkpt>/g)) {
      const time = Date.parse(match[3]);
      if (Number.isFinite(time)) points.push({ latitude: +match[1], longitude: +match[2], time, segment });
    }
    segment++;
  }
  return points.sort((a, b) => a.time - b.time);
}

function lowerBound(points, time) {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (points[middle].time < time) low = middle + 1;
    else high = middle;
  }
  return low;
}

function positionAt(points, time) {
  const index = lowerBound(points, time);
  const previous = points[index - 1];
  const next = points[index];
  if (!previous && !next) return null;

  if (previous && next) {
    const gapSeconds = (next.time - previous.time) / 1000;
    const endpointDistance = haversineKm(previous.latitude, previous.longitude, next.latitude, next.longitude);
    const canInterpolateWithinSegment = previous.segment === next.segment
      && gapSeconds <= MAX_INTERPOLATION_SECONDS;
    const canBridgeStationarySegments = gapSeconds <= MAX_STATIONARY_SECONDS
      && endpointDistance <= MAX_STATIONARY_DISTANCE_KM;
    const canInterpolate = canInterpolateWithinSegment || canBridgeStationarySegments;
    if (canInterpolate && next.time > previous.time) {
      const ratio = (time - previous.time) / (next.time - previous.time);
      return {
        latitude: previous.latitude + (next.latitude - previous.latitude) * ratio,
        longitude: previous.longitude + (next.longitude - previous.longitude) * ratio,
        time,
        timeDeltaSeconds: 0,
        method: 'interpolated'
      };
    }
  }

  const nearest = !previous ? next : !next ? previous
    : time - previous.time <= next.time - time ? previous : next;
  const timeDeltaSeconds = Math.abs(nearest.time - time) / 1000;
  if (timeDeltaSeconds > MAX_NEAREST_SECONDS) return null;
  return { ...nearest, time: nearest.time, timeDeltaSeconds, method: 'nearest' };
}

function defaultOffset(folder) {
  return /괌/.test(folder) ? 10 : 9;
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function isoGpsParts(time) {
  const date = new Date(time);
  return {
    date: `${date.getUTCFullYear()}:${String(date.getUTCMonth() + 1).padStart(2, '0')}:${String(date.getUTCDate()).padStart(2, '0')}`,
    time: `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`
  };
}

async function writeGpsAssignments(assignments) {
  const parentDirectories = [...new Set(roots.map(root => path.dirname(path.resolve(root))))];
  if (parentDirectories.length !== 1) throw new Error('사진 폴더들은 같은 상위 폴더 안에 있어야 합니다.');
  const workingDirectory = parentDirectories[0];
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'timeline-geotag-'));
  const csvPath = path.join(temporaryDirectory, 'assignments.csv');
  const argumentPath = path.join(temporaryDirectory, 'files.args');
  const rows = ['SourceFile,GPSLatitude,GPSLatitudeRef,GPSLongitude,GPSLongitudeRef,GPSDateStamp,GPSTimeStamp,GPSMapDatum'];
  const fileArguments = [];
  for (const assignment of assignments) {
    const gps = isoGpsParts(assignment.gpsTime);
    const relativeSource = path.relative(workingDirectory, path.resolve(assignment.sourceFile)).split(path.sep).join('/');
    fileArguments.push(relativeSource);
    rows.push([
      relativeSource,
      Math.abs(assignment.latitude).toFixed(8),
      assignment.latitude < 0 ? 'S' : 'N',
      Math.abs(assignment.longitude).toFixed(8),
      assignment.longitude < 0 ? 'W' : 'E',
      gps.date,
      gps.time,
      'WGS-84'
    ].map(csvCell).join(','));
  }
  await writeFile(csvPath, `${rows.join('\n')}\n`, 'utf8');
  await writeFile(argumentPath, `${fileArguments.join('\n')}\n`, 'utf8');
  console.log(`GPS가 없는 ${assignments.length}장에 메타데이터를 기록하는 중입니다...`);
  try {
    const { stdout, stderr } = await execFileAsync('exiftool', [
      '-q', '-q', '-charset', 'filename=utf8', '-overwrite_original', '-P',
      '-if', 'not $GPSLatitude and not $GPSLongitude', `-csv=${csvPath}`,
      '-@', argumentPath
    ], {
      cwd: workingDirectory,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true
    });
    console.log(stdout.trim());
    if (stderr.trim()) console.error(stderr.trim());
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (applyReportPath) {
  const report = JSON.parse(await readFile(applyReportPath, 'utf8'));
  if (!Array.isArray(report.assignments)) throw new Error('보고서에 GPS 대상 목록이 없습니다.');
  const assignments = assignmentLimit > 0 ? report.assignments.slice(0, assignmentLimit) : report.assignments;
  await writeGpsAssignments(assignments);
  process.exit(0);
}

async function readPhotoMetadata() {
  const parentDirectories = [...new Set(roots.map(root => path.dirname(path.resolve(root))))];
  const workingDirectory = parentDirectories.length === 1 ? parentDirectories[0] : process.cwd();
  const scanRoots = roots.map(root => path.relative(workingDirectory, path.resolve(root)) || '.');
  const args = [
    '-json', '-n', '-fast2', '-charset', 'filename=utf8', '-r', '-ext', 'jpg', '-ext', 'jpeg',
    '-DateTimeOriginal', '-SubSecDateTimeOriginal', '-OffsetTimeOriginal',
    '-GPSLatitude', '-GPSLongitude', '-GPSDateTime', ...scanRoots
  ];
  const { stdout, stderr } = await execFileAsync('exiftool', args, {
    cwd: workingDirectory,
    encoding: 'utf8',
    maxBuffer: 200 * 1024 * 1024,
    windowsHide: true
  });
  if (!stdout.trim()) throw new Error(`ExifTool이 사진을 읽지 못했습니다. ${stderr.trim()}`);
  return JSON.parse(stdout).map(photo => ({
    ...photo,
    SourceFile: path.isAbsolute(photo.SourceFile) ? photo.SourceFile : path.resolve(workingDirectory, photo.SourceFile)
  }));
}

console.log('사진 메타데이터를 한 번에 읽는 중입니다...');
const [photos, gpxXml] = await Promise.all([
  readPhotoMetadata(),
  readFile(gpxPath, 'utf8')
]);
const points = parseGpx(gpxXml);
if (!points.length) throw new Error('GPX에서 시간 좌표를 찾지 못했습니다.');

const groups = new Map();
for (const photo of photos) {
  const folder = eventFolder(photo.SourceFile);
  if (!folder) continue;
  if (!groups.has(folder)) groups.set(folder, { photos: [], offsetVotes: new Map(), validationKm: [] });
  groups.get(folder).photos.push(photo);
}

for (const [folder, group] of groups) {
  for (const photo of group.photos) {
    if (!Number.isFinite(photo.GPSLatitude) || !Number.isFinite(photo.GPSLongitude)) continue;
    const localTime = parseExifLocal(photo.SubSecDateTimeOriginal || photo.DateTimeOriginal);
    const gpsTime = parseGpsUtc(photo.GPSDateTime);
    const embeddedOffset = parseOffset(photo.OffsetTimeOriginal);
    let offset = embeddedOffset;
    if (offset === null && localTime !== null && gpsTime !== null) {
      const difference = (localTime - gpsTime) / HOUR_MS;
      const rounded = Math.round(difference);
      if (Math.abs(difference - rounded) <= 0.1 && OFFSET_CANDIDATES.includes(rounded)) offset = rounded;
    }
    if (offset !== null) group.offsetVotes.set(offset, (group.offsetVotes.get(offset) || 0) + 1);
  }
  group.offset = [...group.offsetVotes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? defaultOffset(folder);

  for (const photo of group.photos) {
    if (!Number.isFinite(photo.GPSLatitude) || !Number.isFinite(photo.GPSLongitude)) continue;
    const localTime = parseExifLocal(photo.SubSecDateTimeOriginal || photo.DateTimeOriginal);
    if (localTime === null) continue;
    const position = positionAt(points, localTime - group.offset * HOUR_MS);
    if (!position) continue;
    group.validationKm.push(haversineKm(
      photo.GPSLatitude,
      photo.GPSLongitude,
      position.latitude,
      position.longitude
    ));
  }
  group.validationMedianKm = percentile(group.validationKm, 0.5);
  group.validationP95Km = percentile(group.validationKm, 0.95);
  group.safe = group.validationKm.length < 3 || group.validationMedianKm <= MAX_VALIDATION_MEDIAN_KM;
}

const assignments = [];
let existingGps = 0;
let missingCaptureTime = 0;
let outsideTimeline = 0;
let noTrackMatch = 0;
let unsafeGroup = 0;

for (const photo of photos) {
  if (Number.isFinite(photo.GPSLatitude) || Number.isFinite(photo.GPSLongitude)) {
    existingGps++;
    continue;
  }
  const localTime = parseExifLocal(photo.SubSecDateTimeOriginal || photo.DateTimeOriginal);
  if (localTime === null) {
    missingCaptureTime++;
    continue;
  }
  const folder = eventFolder(photo.SourceFile);
  const group = groups.get(folder);
  const offset = parseOffset(photo.OffsetTimeOriginal) ?? group?.offset ?? defaultOffset(folder);
  const utcTime = localTime - offset * HOUR_MS;
  if (utcTime < points[0].time || utcTime > points.at(-1).time) {
    outsideTimeline++;
    continue;
  }
  if (group && !group.safe) {
    unsafeGroup++;
    continue;
  }
  const position = positionAt(points, utcTime);
  if (!position) {
    noTrackMatch++;
    continue;
  }
  assignments.push({
    sourceFile: photo.SourceFile,
    folder,
    captureTime: photo.SubSecDateTimeOriginal || photo.DateTimeOriginal,
    offset,
    latitude: position.latitude,
    longitude: position.longitude,
    gpsTime: position.time,
    method: position.method,
    timeDeltaSeconds: position.timeDeltaSeconds
  });
}

const groupReport = [...groups].map(([folder, group]) => ({
  folder,
  photos: group.photos.length,
  existingGps: group.photos.filter(photo => Number.isFinite(photo.GPSLatitude) && Number.isFinite(photo.GPSLongitude)).length,
  candidates: assignments.filter(item => item.folder === folder).length,
  offsetHours: group.offset,
  offsetVotes: Object.fromEntries(group.offsetVotes),
  validationCount: group.validationKm.length,
  validationMedianMeters: group.validationMedianKm === null ? null : Math.round(group.validationMedianKm * 1000),
  validationP95Meters: group.validationP95Km === null ? null : Math.round(group.validationP95Km * 1000),
  safe: group.safe
})).filter(group => group.candidates || group.existingGps).sort((a, b) => a.folder.localeCompare(b.folder, 'ko'));

const summary = {
  mode: writeMode ? 'write' : 'dry-run',
  scannedPhotos: photos.length,
  existingGps,
  candidates: assignments.length,
  skipped: { missingCaptureTime, outsideTimeline, noTrackMatch, unsafeGroup },
  gpx: {
    points: points.length,
    start: new Date(points[0].time).toISOString(),
    end: new Date(points.at(-1).time).toISOString()
  },
  groups: groupReport
};

const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
const reportPath = path.join(reportDirectory, `geotag-report-${stamp}.json`);
await writeFile(reportPath, `${JSON.stringify({ summary, assignments }, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...summary, reportPath }, null, 2));

if (writeMode && assignments.length) {
  await writeGpsAssignments(assignments);
}
