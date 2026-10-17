#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readArgs(argv) {
  const options = {
    workspace: path.resolve(__dirname, 'workspace', 'preprocessed'),
    baseUrl: 'http://127.0.0.1:5180',
    rooms: null,
    allowIncomplete: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [key, inline] = arg.split('=', 2);
    if (key === '--allow-incomplete') {
      options.allowIncomplete = true;
    } else if (key === '--workspace') {
      const value = inline ?? argv[++index];
      if (!value) throw new Error('--workspace requires a path.');
      options.workspace = path.resolve(value);
    } else if (key === '--base-url') {
      const value = inline ?? argv[++index];
      if (!value) throw new Error('--base-url requires a URL.');
      options.baseUrl = value;
    } else if (key === '--rooms') {
      const value = inline ?? argv[++index];
      if (!value) throw new Error('--rooms requires a comma-separated room list.');
      options.rooms = value.split(',').map((name) => name.trim()).filter(Boolean);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function normalizeEnemyId(value) {
  return String(value).replace(/^prefab_/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function metadataPath(workspace, relative) {
  const resolved = path.resolve(workspace, relative);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${path.sep}`)) {
    throw new Error(`Manifest metadata path escapes the workspace: ${relative}`);
  }
  return resolved;
}

async function requestArtwork(baseUrl, placementIds) {
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/api/enemy-artwork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ placementIds }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Enemy-artwork API returned HTTP ${response.status}: ${detail.slice(0, 2000)}`);
  }
  return response.json();
}

async function queryArtworkResilient(baseUrl, ids, artworkByKey, warnings) {
  try {
    const response = await requestArtwork(baseUrl, ids);
    for (const [key, value] of Object.entries(response.artwork ?? {})) {
      const imageUrl = String(value.sprite?.imageUrl ?? '');
      const match = imageUrl.match(/^\/api\/artwork\/([a-f0-9]{64})\.png$/i);
      if (!match) continue;
      const { imageUrl: _imageUrl, ...sprite } = value.sprite;
      artworkByKey.set(normalizeEnemyId(key), {
        placementId: normalizeEnemyId(key),
        objectName: value.objectName,
        sourceBundle: value.sourceBundle,
        offsetX: value.offsetX,
        offsetY: value.offsetY,
        sprite: { ...sprite, textureSha256: match[1].toLowerCase() },
      });
    }
  } catch (error) {
    let healthy = false;
    try { healthy = (await fetch(`${baseUrl.replace(/\/$/, '')}/api/health`, { signal: AbortSignal.timeout(5000) })).ok; } catch { }
    if (!healthy) throw new Error(`The local Silksong asset server is unavailable after an artwork lookup failed: ${error.message}`);
    if (ids.length === 1) {
      warnings.push(`${ids[0]}: ${error.message}`);
      console.warn(`Skipped one sprite lookup that the local Unity asset reader could not decode: ${ids[0]}`);
      return;
    }
    const midpoint = Math.ceil(ids.length / 2);
    console.warn(`An artwork lookup batch of ${ids.length} failed; retrying in smaller groups.`);
    await queryArtworkResilient(baseUrl, ids.slice(0, midpoint), artworkByKey, warnings);
    await queryArtworkResilient(baseUrl, ids.slice(midpoint), artworkByKey, warnings);
  }
}

function atomicWriteJson(filePath, data) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backup = `${filePath}.${process.pid}.${Date.now()}.bak`;
  fs.writeFileSync(temporary, JSON.stringify(data), 'utf8');
  try {
    try {
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (!['EPERM', 'EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
      fs.renameSync(filePath, backup);
      try {
        fs.renameSync(temporary, filePath);
        fs.rmSync(backup, { force: true });
      } catch (replaceError) {
        fs.renameSync(backup, filePath);
        throw replaceError;
      }
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function main() {
  const options = readArgs(process.argv.slice(2));
  const workspace = path.resolve(options.workspace);
  const manifestPath = path.join(workspace, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error(`Missing preprocessed manifest: ${manifestPath}`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.complete && !options.allowIncomplete) {
    throw new Error('The preprocessed room pass is not complete. Use --allow-incomplete only for a targeted repair.');
  }

  let entries = manifest.rooms ?? [];
  if (options.rooms) {
    const wanted = new Set(options.rooms.map((name) => name.toLowerCase()));
    entries = entries.filter((entry) => wanted.has(String(entry.name).toLowerCase()));
    const found = new Set(entries.map((entry) => String(entry.name).toLowerCase()));
    const missing = options.rooms.filter((name) => !found.has(name.toLowerCase()));
    if (missing.length) throw new Error(`Rooms are not in the manifest: ${missing.join(', ')}`);
  }

  const idsByKey = new Map();
  let inspected = 0;
  for (const entry of entries) {
    if (!entry.metadata) continue;
    const filePath = metadataPath(workspace, entry.metadata);
    if (!fs.existsSync(filePath)) throw new Error(`Missing room sidecar: ${entry.name}`);
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!/"architect"\s*:/.test(raw)) continue;
    const metadata = JSON.parse(raw);
    inspected += 1;
    for (const placement of metadata.architect?.placements ?? []) {
      if (!placement.enemyCandidate) continue;
      const id = String(placement.placement?.id ?? '');
      const key = normalizeEnemyId(id);
      if (key.length >= 5 && !idsByKey.has(key)) idsByKey.set(key, id);
    }
    if (inspected % 10 === 0) console.log(`Scanned ${inspected} Architect room sidecars; found ${idsByKey.size} distinct enemy names.`);
  }

  const artworkByKey = new Map();
  const queryWarnings = [];
  const ids = [...idsByKey.values()];
  // Smaller requests keep the local Unity asset decoder's temporary memory
  // bounded when the full set contains hundreds of unrelated Architect IDs.
  const requestSize = 30;
  for (let offset = 0; offset < ids.length; offset += requestSize) {
    const batch = ids.slice(offset, offset + requestSize);
    await queryArtworkResilient(options.baseUrl, batch, artworkByKey, queryWarnings);
    console.log(`Matched ${artworkByKey.size} real Silksong enemy sprites after querying ${Math.min(offset + requestSize, ids.length)}/${ids.length} names.`);
  }
  for (const [key, artwork] of artworkByKey) artwork.placementId = idsByKey.get(key) || artwork.placementId;

  let updatedRooms = 0;
  let addedMatches = 0;
  for (const entry of entries) {
    if (!entry.metadata) continue;
    const filePath = metadataPath(workspace, entry.metadata);
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!/"architect"\s*:/.test(raw)) continue;
    const metadata = JSON.parse(raw);
    const architect = metadata.architect;
    if (!architect) continue;
    architect.enemyArtwork ??= {};
    let changed = false;
    for (const placement of architect.placements ?? []) {
      const placementId = String(placement.placement?.id ?? '');
      if (placement.enemyCandidate && /enemy[\s_-]?(?:remover|clear)/i.test(placementId)) {
        placement.enemyCandidate = false;
        changed = true;
      }
    }
    const roomIds = [...new Set((architect.placements ?? [])
      .filter((placement) => placement.enemyCandidate)
      .map((placement) => normalizeEnemyId(placement.placement?.id ?? ''))
      .filter(Boolean))];
    let added = 0;
    for (const key of roomIds) {
      if (!artworkByKey.has(key)) continue;
      if (!Object.hasOwn(architect.enemyArtwork, key)) added += 1;
      architect.enemyArtwork[key] = artworkByKey.get(key);
      changed = true;
    }
    const matched = roomIds.filter((key) => Object.hasOwn(architect.enemyArtwork, key)).length;
    const lookup = {
      source: 'Silksong sprite atlases',
      requestedEnemyTypes: roomIds.length,
      matchedEnemyTypes: matched,
      unmatchedEnemyTypes: roomIds.length - matched,
    };
    if (architect.enemyArtworkLookup?.requestedEnemyTypes !== lookup.requestedEnemyTypes ||
        architect.enemyArtworkLookup?.matchedEnemyTypes !== lookup.matchedEnemyTypes ||
        architect.enemyArtworkLookup?.unmatchedEnemyTypes !== lookup.unmatchedEnemyTypes) changed = true;
    architect.enemyArtworkLookup = lookup;
    if (!changed) continue;
    atomicWriteJson(filePath, metadata);
    updatedRooms += 1;
    addedMatches += added;
    if (updatedRooms % 10 === 0) console.log(`Updated ${updatedRooms} room sidecars so far.`);
  }

  console.log(`Done: queried ${ids.length} enemy names, matched ${artworkByKey.size} real sprites, added ${addedMatches} room matches across ${updatedRooms} rooms.`);
  if (queryWarnings.length) console.warn(`The asset reader could not decode ${queryWarnings.length} individual sprite lookups; those names remain without sprite artwork.`);
}

main().catch((error) => {
  console.error(error.stack ?? error.message ?? error);
  process.exitCode = 1;
});
