const $ = id => document.getElementById(id);
const HOSTED_MODE = Boolean(window.SILKSONG_ATLAS_HOSTED);
const DATA_BASE = String(window.SILKSONG_ATLAS_DATA_BASE || '/atlas-data/').replace(/\/?$/, '/');
const ARTWORK_BASE = String(window.SILKSONG_ATLAS_ARTWORK_BASE || '/api/artwork/').replace(/\/?$/, '/');
const ARTWORK_EXTENSION = String(window.SILKSONG_ATLAS_ARTWORK_EXTENSION || 'png').replace(/^\./, '');
const GZIP_JSON = Boolean(window.SILKSONG_ATLAS_GZIP_JSON);
const state = { manifest: null, navigation: null, mode: 'world', area: null, room: null, roomMeta: null,
  roomImage: null, roomViewImage: null, wideImage: null, detailImage: null, imageCache: new Map(), atlasCache: new Map(),
  selectedGauntlet: null, selectedWave: 'all', visiblePlacements: new Map(), selectedAreaName: null, hoverAreaKey: null,
  cameraSections: [], roomViewKey: 'whole', mapBackdropVisible: false, mapBackdropAuto: false,
  viewport: { key: '', zoom: 1, offsetX: 0, offsetY: 0 }, hoverRoomName: null, mapSpriteTintCache: new Map(), mapRoomCache: new Map(),
  drag: null, suppressClickUntil: 0,
  showMappedMapArtwork: true, showUnmappedMapArtwork: true, showConditionalMapArtwork: false,
  showArchitectMapMarkers: false,
  roomStateOverrides: new Map(), roomStateGroups: [], roomStateCandidates: [], showAllInactiveArtwork: false,
  includeDisabledStateArtwork: false, conditionalCache: null, conditionalBuildVersion: 0 };
const canvas = $('mapCanvas'), ctx = canvas.getContext('2d');

function setPanelOpen(name, open) {
  const panel = $(name === 'navigator' ? 'navigator' : 'inspector');
  const button = $(name === 'navigator' ? 'toggleNavigatorButton' : 'toggleInspectorButton');
  if (open) {
    const otherName = name === 'navigator' ? 'inspector' : 'navigator';
    setPanelOpen(otherName, false);
  }
  panel.classList.toggle('is-open', open);
  panel.setAttribute('aria-hidden', String(!open));
  button.setAttribute('aria-expanded', String(open));
}

function closePanel(name) { setPanelOpen(name, false); }

function togglePanel(name) {
  const panel = $(name === 'navigator' ? 'navigator' : 'inspector');
  setPanelOpen(name, !panel.classList.contains('is-open'));
}
function clearConditionalCache(){state.conditionalBuildVersion++;state.conditionalCache=null;}

function esc(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }
function cleanLabel(value) { return String(value ?? '').replaceAll('Ã‚Â·','·').replaceAll('Â·','·'); }
function labelCase(value) { return String(value || '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g,' ').trim(); }
function fileBase(value) { return String(value || '').replace(/\.bundle$/i, ''); }
function mapByFile(file) { return file ? `${DATA_BASE}${String(file).replace(/^\/+/, '')}` : ''; }
async function loadJson(file) {
  const response = await fetch(mapByFile(`${file}${GZIP_JSON ? '.gz' : ''}`), { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${file} (${response.status}).`);
  if (!GZIP_JSON) return response.json();
  if (!('DecompressionStream' in window)) throw new Error('This browser cannot decompress the packaged room metadata. Update to a current browser.');
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
}
function worldMapImage(type) {
  const record = state.navigation?.maps?.[type];
  if (!record?.file) return null;
  if (state.imageCache.has(record.file)) return state.imageCache.get(record.file);
  const image = new Image(); image.onload = draw; image.onerror = draw;
  image.src = mapByFile(record.file); state.imageCache.set(record.file, image); return image;
}
function loadImage(file) {
  if (!file) return Promise.resolve(null);
  if (state.imageCache.has(file)) {
    const image = state.imageCache.get(file);
    return image.complete && image.naturalWidth ? Promise.resolve(image) : new Promise(resolve => {
      image.addEventListener('load', () => resolve(image), { once: true });
      image.addEventListener('error', () => resolve(null), { once: true });
    });
  }
  return new Promise(resolve => {
    const image = new Image(); state.imageCache.set(file,image);
    image.onload = () => { draw(); resolve(image); }; image.onerror = () => resolve(null); image.src = mapByFile(file);
  });
}

async function loadDataset() {
  $('canvasNotice').hidden = true;
  try {
    state.manifest = await loadJson('manifest.json');
    try { state.navigation = await loadJson('maps/navigation.json'); }
    catch { state.navigation = { maps: {}, areas: [] }; }
    const done = state.manifest.processedSceneCount ?? state.manifest.rooms?.length ?? 0;
    const total = state.manifest.requestedSceneCount ?? state.manifest.rooms?.length ?? 0;
    const complete = state.manifest.complete ? 'ready' : `${done.toLocaleString()} / ${total.toLocaleString()} preprocessed`;
    $('datasetStatus').textContent = `${complete} · ${HOSTED_MODE ? 'game art + Architect data' : 'clean game PNGs + metadata'}`;
    const mapRegions = (state.navigation.areas || []).filter(area => area.widePosition).length;
    const chartedSections = (state.navigation.areas || []).filter(area => area.supplemental).length;
    $('datasetCounts').textContent = `${done.toLocaleString()} processed scenes · ${mapRegions} map regions${chartedSections ? ` + ${chartedSections} charted sections` : ''}`;
    if (!state.navigation.areas?.length) {
      $('canvasNotice').textContent = 'Room images are ready, but game map artwork is unavailable. Use the room index to browse preprocessed scenes.';
      $('canvasNotice').hidden = false;
    }
    renderNavigation(); draw();
  } catch (error) {
    $('datasetStatus').textContent = 'preprocessed dataset not ready';
    $('datasetCounts').textContent = 'The viewer is waiting for the local preprocessing pass.';
    $('navList').innerHTML = '<div class="empty">The saved dataset will appear here when preprocessing finishes.</div>';
    $('canvasNotice').textContent = error.message || String(error); $('canvasNotice').hidden = false;
  }
}

function allRooms() { return state.manifest?.rooms || []; }
function findRoom(name) { return allRooms().find(entry => entry.name.toLowerCase() === String(name).toLowerCase()) || null; }
function findArea(key) { return (state.navigation?.areas || []).find(area => area.key === key) || null; }

function renderNavigation() {
  const query = $('search').value.trim().toLowerCase();
  const isRoom = state.mode === 'room';
  $('worldButton').hidden = state.mode === 'world' || (isRoom && Boolean(state.area));
  $('worldButton').textContent = isRoom && !state.area ? 'All rooms' : 'World map';
  $('areaButton').hidden = !isRoom || !state.area;
  $('allRoomsButton').hidden = state.mode === 'all-rooms' || (isRoom && !state.area);
  $('navTitle').textContent = state.mode === 'world' ? 'World regions' : state.mode === 'all-rooms' ? 'All rooms' : state.mode === 'area' ? (state.area?.name || 'Area') : fileBase(state.room?.name || 'Room');
  if (state.mode === 'world') {
    $('navDescription').textContent = 'Choose a numbered game-map region, or open another charted map section.';
    $('search').placeholder = 'Find an area or room…';
    const areas = (state.navigation?.areas || []).filter(area => !query || area.name.toLowerCase().includes(query) || area.key.toLowerCase().includes(query));
    const areaRows = areas.map((area,index) => `<button class="nav-row ${state.selectedAreaName===area.key?'active':''}" data-area="${esc(area.key)}"><span class="nav-index">${area.widePosition?String(index+1).padStart(2,'0'):'◇'}</span><span class="nav-copy"><span class="nav-name">${esc(area.name)}</span><span class="nav-meta">${area.rooms.length} charted rooms${area.supplemental?' · map section':''}</span></span><span class="nav-arrow">›</span></button>`).join('');
    const roomMatches = query ? allRooms().filter(room => room.name.toLowerCase().includes(query)).slice(0,80) : [];
    const roomRows = roomMatches.map((room,index) => `<button class="nav-row" data-room="${esc(room.name)}"><span class="nav-index">R${String(index+1).padStart(2,'0')}</span><span class="nav-copy"><span class="nav-name">${esc(fileBase(room.name))}</span><span class="nav-meta">${esc(room.kind || room.status)}${room.image?' · image':''}</span></span><span class="nav-arrow">›</span></button>`).join('');
    $('navList').innerHTML = areaRows ? `<div class="nav-group-label">MAP REGIONS AND CHARTED SECTIONS</div>${areaRows}${roomRows}` : roomRows || '<div class="empty">No matching map region or room. Use All rooms to browse every prepared scene.</div>';
    document.querySelectorAll('[data-area]').forEach(button => {
      button.addEventListener('click', () => showArea(button.dataset.area));
      button.addEventListener('pointerenter', () => { state.hoverAreaKey=button.dataset.area; draw(); });
      button.addEventListener('pointerleave', () => { state.hoverAreaKey=null; draw(); });
    });
    document.querySelectorAll('[data-room]').forEach(button => button.addEventListener('click', () => openRoom(button.dataset.room)));
  } else if (state.mode === 'all-rooms') {
    $('navDescription').textContent = `${allRooms().length.toLocaleString()} prepared scenes · choose one to view its game artwork.`;
    $('search').placeholder = 'Find a room…';
    const rooms = allRooms().filter(room => !query || room.name.toLowerCase().includes(query));
    $('navList').innerHTML = rooms.map((room,index) => `<button class="nav-row ${state.room?.name===room.name?'active':''}" data-room="${esc(room.name)}"><span class="nav-index">${String(index+1).padStart(2,'0')}</span><span class="nav-copy"><span class="nav-name">${esc(fileBase(room.name))}</span><span class="nav-meta">${esc(room.kind || room.status)}${room.image?' · image':''}</span></span><span class="nav-arrow">›</span></button>`).join('') || '<div class="empty">No rooms match that search.</div>';
    document.querySelectorAll('[data-room]').forEach(button => button.addEventListener('click', () => openRoom(button.dataset.room)));
  } else {
    const area = state.area;
    const anchorCount=area?.rooms.filter(room=>room.mapAnchor).length||0;
    const architectCount=area?.rooms.filter(room=>room.architect?.markerCount).length||0;
    $('navDescription').textContent = state.mode === 'room' ? `${area?.name || 'Area'} · selected room` : `${area?.rooms.length || 0} room locations · choose one to open its pre-rendered image.${anchorCount?` ${anchorCount} use game scene positions where the map has no tile art.`:''}${architectCount?` ${architectCount} rooms contain Architect markers.`:''}`;
    $('search').placeholder = 'Find a room…';
    const mapped = (area?.rooms || []).map(item => ({ ...item, export: findRoom(item.name) })).filter(item => item.export);
    const filtered = mapped.filter(item => !query || item.name.toLowerCase().includes(query));
    $('navList').innerHTML = filtered.map((room,index) => `<button class="nav-row ${state.room?.name===room.name?'active':''}" data-room="${esc(room.name)}"><span class="nav-index">${String(index+1).padStart(2,'0')}</span><span class="nav-copy"><span class="nav-name">${esc(fileBase(room.name))}</span><span class="nav-meta">${room.export.status}${room.export.image?' · image':''}${room.mapAnchor?' · game map position':''}${room.architect?.markerCount?` · G${room.architect.markerCount}`:''}</span></span><span class="nav-arrow">›</span></button>`).join('') || (area?.rooms.length ? '<div class="empty">No preprocessed rooms in this area match the search.</div>' : '<div class="empty">No room markers are recorded for this map region. Use All rooms to browse the prepared scenes.</div>');
    document.querySelectorAll('[data-room]').forEach(button => button.addEventListener('click', () => openRoom(button.dataset.room)));
  }
}

function showWorld() {
  clearConditionalCache();
  closePanel('inspector');
  state.mode='world'; state.area=null; state.room=null; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null; state.hoverAreaKey=null;
  $('stageKind').textContent='WIDE WORLD MAP'; $('stageTitle').textContent='World regions'; $('viewFoot').textContent='GAME-AUTHORED WIDE MAP · SCROLL TO ZOOM · DRAG TO PAN'; $('imageDimensions').textContent='';
  $('inspectorEyebrow').textContent='LAYERS'; $('inspectorTitle').textContent='Map layers';
  $('exportPngButton').hidden=true;
  $('toggleMapBackdrop').hidden=true;
  $('roomSummary').innerHTML='<div class="empty">Select a region from the world map or list.</div>';
  $('mapLayers').hidden=true; $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('roomStatePanel').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true; $('closeRoomButton').hidden=true;
  renderNavigation(); $('navList').scrollTop=0; const selectedAreaButton=document.querySelector('[data-area].active'); selectedAreaButton?.scrollIntoView({block:'nearest'}); draw();
}
function showAllRooms() {
  clearConditionalCache();
  closePanel('inspector');
  state.mode='all-rooms'; state.area=null; state.room=null; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null;
  $('stageKind').textContent='ALL PREPARED ROOMS'; $('stageTitle').textContent='Browse every scene'; $('viewFoot').textContent='ALL EXPORTED SCENES · SCROLL TO ZOOM · DRAG TO PAN'; $('imageDimensions').textContent='';
  $('exportPngButton').hidden=true; $('roomSummary').innerHTML='<div class="empty">Choose any prepared scene, including rooms that are not connected to a map region.</div>';
  $('toggleMapBackdrop').hidden=true;
  $('mapLayers').hidden=true; $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('roomStatePanel').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true; $('closeRoomButton').hidden=true;
  renderNavigation(); $('navList').scrollTop=0; draw();
}
function showArea(key) {
  const area = findArea(key); if (!area) return;
  clearConditionalCache();
  closePanel('inspector');
  if(state.mapBackdropAuto){state.mapBackdropVisible=false;state.mapBackdropAuto=false;}
  const hasDefaultMapArtwork=area.rooms.some(room=>(room.mapSprites?.length||room.mapAnchor)&&!room.conditionalMapState)||(area.unmappedMapArtwork||[]).length>0;
  if(!hasDefaultMapArtwork){state.mapBackdropVisible=true;state.mapBackdropAuto=true;}
  state.selectedAreaName=area.key; state.hoverAreaKey=null; state.hoverRoomName=null;
  state.mode='area'; state.area=area; state.room=null; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null;
  $('stageKind').textContent='REGION DETAIL'; $('stageTitle').textContent=area.name; $('viewFoot').textContent=`${area.key} · ${area.detailBounds?'ROOM SECTIONS':'WIDE MAP REGION'} · SCROLL TO ZOOM · DRAG TO PAN`; $('imageDimensions').textContent='';
  $('inspectorEyebrow').textContent='MAP LAYERS'; $('inspectorTitle').textContent=area.name;
  $('exportPngButton').hidden=true;
  $('toggleMapBackdrop').hidden=false; $('toggleMapBackdrop').textContent=state.mapBackdropVisible?'Hide other regions':'Show all regions'; $('toggleMapBackdrop').setAttribute('aria-pressed',String(state.mapBackdropVisible));
  $('roomSummary').innerHTML=`<div class="summary-name">${esc(area.name)}</div><div class="summary-kind">REGION ${esc(area.key)}</div><div class="summary-stat"><span>Mapped rooms</span><strong>${area.rooms.length}</strong></div><div class="summary-stat"><span>Preprocessed images</span><strong>${area.rooms.filter(room=>findRoom(room.name)?.image).length}</strong></div>`;
  $('mapPieceCount').textContent=`${(area.unmappedMapArtwork||[]).reduce((count,object)=>count+(object.mapSprites?.length||0),0)} sprites`;
  const conditionalRows=[...(area.conditionalMapArtwork||[]),...(area.rooms||[]).filter(room=>room.conditionalMapState)];
  $('mapStateCount').textContent=`${conditionalRows.reduce((count,object)=>count+(object.mapSprites?.length||0),0)} sprites`;
  $('architectMapCount').textContent=`${area.rooms.filter(room=>room.architect?.markerCount).length} rooms`;
  $('toggleArchitectMapMarkers').checked=state.showArchitectMapMarkers;
  $('mapLayers').hidden=false; $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('roomStatePanel').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true; $('closeRoomButton').hidden=true;
  renderNavigation(); $('navList').scrollTop=0; draw();
}

async function openRoom(name, options = {}) {
  const room = findRoom(name); if (!room) return;
  setPanelOpen('inspector', true);
  const mappedArea=(state.navigation?.areas||[]).find(area=>area.rooms.some(item=>item.name.toLowerCase()===room.name.toLowerCase()))||null;
  const areaForRoom=state.area?.rooms?.some(item=>item.name.toLowerCase()===room.name.toLowerCase())?state.area:mappedArea;
  state.area=areaForRoom;
  $('inspectorEyebrow').textContent='ROOM LAYERS'; $('inspectorTitle').textContent=fileBase(room.name);
  state.mode='room'; state.room=room; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null; state.selectedWave='all'; state.visiblePlacements.clear();
  state.roomStateOverrides=new Map(); state.roomStateGroups=[]; state.roomStateCandidates=[]; state.showAllInactiveArtwork=false; state.includeDisabledStateArtwork=false;
  clearConditionalCache();
  state.cameraSections=[]; state.roomViewKey='whole';
  $('stageKind').textContent=room.kind?.toUpperCase() || 'ROOM'; $('stageTitle').textContent=fileBase(room.name); $('viewFoot').textContent='CLEAN SILKSONG ROOM IMAGE · SCROLL TO ZOOM · DRAG TO PAN';
  $('canvasLoading').hidden=false; $('canvasNotice').hidden=true; $('closeRoomButton').hidden=false;
  $('exportPngButton').hidden=true;
  $('toggleMapBackdrop').hidden=true; $('mapLayers').hidden=true;
  $('roomSummary').innerHTML='<div class="empty">Loading the selected room sidecar…</div>';
  $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('roomStatePanel').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true;
  $('toggleEnemies').checked=false; $('toggleSpawns').checked=false; $('toggleChecks').checked=false;
  $('toggleAllInactiveArtwork').checked=false; $('toggleDisabledStateArtwork').checked=false; $('roomStateSearch').value='';
  $('toggleGauntlets').checked=false; $('toggleArenaChanges').checked=true; $('toggleEnemyTextures').checked=true;
  $('gauntletDetails').hidden=true;
  renderNavigation();
  const metadataPath=room.metadata;
  try {
    const [meta,image] = await Promise.all([
      metadataPath ? loadJson(metadataPath) : Promise.resolve(null),
      (room.previewImage || room.image) ? loadImage(room.previewImage || room.image) : Promise.resolve(null)
    ]);
    state.roomMeta=meta; state.roomImage=image; state.roomViewImage=null;
    $('canvasLoading').hidden=true;
    setupRoomSections(meta);
    const counts=meta?.counts||{}; $('enemyCount').textContent=counts.enemyCandidates||0; $('spawnCount').textContent=counts.spawnCandidates||0; $('checkCount').textContent=counts.checkCandidates||0;
    $('roomSummary').innerHTML=`<div class="summary-name">${esc(fileBase(room.name))}</div><div class="summary-kind">${esc(room.kind || 'room')} · ${esc(meta?.status || room.status)}</div><div class="summary-stat"><span>Scene objects</span><strong>${(counts.objectCount||0).toLocaleString()}</strong></div><div class="summary-stat"><span>Renderable artwork</span><strong>${meta?.render?.eligibleRendererCount?.toLocaleString?.()||0} renderers</strong></div><div class="summary-stat"><span>Texture atlases baked</span><strong>${meta?.render?.textureCount||0}</strong></div>`;
    $('objectLayers').hidden=!meta?.objects?.length;
    renderRoomStateControls(meta);
    $('metadataPanel').hidden=!meta;
    $('metadataRows').innerHTML=meta?[
      ['Image',meta.image?`${meta.image.width.toLocaleString()} × ${meta.image.height.toLocaleString()} px`:'No renderable artwork'],
      ['Resolution',meta.image?`${Number(meta.image.pixelsPerWorldUnit).toFixed(2)} px / unit`:'—'],
      ['Resolution status',meta.image?.resolutionLimited?'Render density capped to fit the prepared image':meta.image?.previewWidth?'Preview displayed; larger render is stored':'Full-resolution render'],
      ['Bundle',meta.scene?.source?.bundle||'—'],
      ['Missing textures',meta.render?.missingTextureSha256?.length||0]
    ].map(([k,v])=>`<div class="metadata-row"><span>${esc(k)}</span><strong>${esc(v)}</strong></div>`).join('')+(meta.image?.file?`<div class="metadata-row"><span>Stored room image</span><strong>${String(meta.image.file).toLowerCase().endsWith('.png')?'PNG':'lossless WebP'}</strong></div>`:''):'';
    $('exportPngButton').hidden=!(image&&meta?.image?.file);
    const architect=meta?.architect; const hasArchitect=Boolean(architect && (architect.markers?.length || architect.placements?.length || architect.tileCells?.length));
    $('architectPanel').hidden=!hasArchitect;
    if(hasArchitect) setupArchitect(architect);
    const selectedSection=state.cameraSections.find(section=>section.key===state.roomViewKey);
    if(selectedSection?.file)state.roomViewImage=await loadImage(selectedSection.file);
    if(Number.isInteger(options.architectMarkerIndex)&&architect?.markers?.length){$('toggleGauntlets').checked=true;selectGauntlet(Math.min(options.architectMarkerIndex,architect.markers.length-1));}
    updateRoomViewDisplay();
    if(!image&&!meta?.objects?.length){$('canvasNotice').textContent=room.status==='exported'?'Room image is not available in the hosted atlas.':'This room has no renderable game artwork.';$('canvasNotice').hidden=false;}
    draw();
  } catch(error) {
    $('canvasLoading').hidden=true; $('canvasNotice').textContent=error.message||String(error); $('canvasNotice').hidden=false;
    $('roomSummary').innerHTML=`<div class="empty">Could not load room metadata: ${esc(error.message||error)}</div>`;
  }
}

function renderRoomStateControls(meta) {
  const objects=meta?.objects||[];
  const renderableCount=objects.reduce((sum,object)=>sum+
    (object.sprites||[]).filter(sprite=>sprite.textureSha256&&sprite.rectWidth&&sprite.rectHeight).length+
    (object.meshes||[]).filter(mesh=>mesh.textureSha256).length,0);
  const inactiveCount=objects.reduce((sum,object)=>sum+(object.activeInRoom===false||object.active===false?
    (object.sprites||[]).filter(sprite=>sprite.textureSha256&&sprite.rectWidth&&sprite.rectHeight).length+
    (object.meshes||[]).filter(mesh=>mesh.textureSha256).length:0),0);
  const disabledRendererCount=objects.reduce((sum,object)=>sum+
    (object.sprites||[]).filter(sprite=>sprite.textureSha256&&sprite.rectWidth&&sprite.rectHeight&&sprite.rendererEnabled===false).length+
    (object.meshes||[]).filter(mesh=>mesh.textureSha256&&mesh.rendererEnabled===false).length,0);
  $('roomStatePanel').hidden=!objects.length||inactiveCount===0&&disabledRendererCount===0;
  $('roomStateCount').textContent=`${inactiveCount.toLocaleString()} inactive · ${disabledRendererCount.toLocaleString()} disabled · ${renderableCount.toLocaleString()} total`;
  if(!objects.length||inactiveCount===0&&disabledRendererCount===0)return;
  const index=buildRoomStateIndex(objects);
  state.roomStateGroups=index.groups;
  state.roomStateCandidates=index.candidates;
  renderRoomStateGroupFilters();
  renderRoomStateObjectFilters();
  $('toggleAllInactiveArtwork').onchange=()=>{state.showAllInactiveArtwork=$('toggleAllInactiveArtwork').checked;updateRoomViewDisplay();draw();};
  $('toggleDisabledStateArtwork').onchange=()=>{state.includeDisabledStateArtwork=$('toggleDisabledStateArtwork').checked;updateRoomViewDisplay();draw();};
  $('roomStateSearch').oninput=renderRoomStateObjectFilters;
}

function buildRoomStateIndex(objects) {
  const byId=new Map(objects.map(object=>[object.id,object])),children=new Map();
  for(const object of objects){const list=children.get(object.parentId)||[];list.push(object);children.set(object.parentId,list);}
  const countCache=new Map();
  function subtreeArtworkCount(object,path=new Set()){
    if(countCache.has(object.id))return countCache.get(object.id);
    if(path.has(object.id))return 0;
    const next=new Set(path);next.add(object.id);
    const own=(object.sprites||[]).filter(sprite=>sprite.textureSha256&&sprite.rectWidth&&sprite.rectHeight).length+
      (object.meshes||[]).filter(mesh=>mesh.textureSha256).length;
    const total=own+(children.get(object.id)||[]).reduce((sum,child)=>sum+subtreeArtworkCount(child,next),0);
    countCache.set(object.id,total);return total;
  }
  const stateTerms=/event|condition|quest|door|destroy|repair|complete|check|active|activat|normal world|black thread|intro|pre.?cleanup|post.?cleanup|before|after|lit|dark|broken|phase|act[123]|bridge|battle/i;
  const pathCache=new Map();
  function objectPath(object){
    if(pathCache.has(object.id))return pathCache.get(object.id);
    const names=[object.name||'(unnamed)'];let parent=byId.get(object.parentId),depth=0;
    while(parent&&depth++<12){names.unshift(parent.name||'(unnamed)');parent=byId.get(parent.parentId);}
    const path=names.join(' / ');pathCache.set(object.id,path);return path;
  }
  const searchable=objects.map(object=>{
    const componentNames=(object.components||[]).map(component=>component.scriptName||component.type||'').join(' '),path=objectPath(object),spriteCount=subtreeArtworkCount(object);
    const likelyState=stateTerms.test(`${object.name||''} ${componentNames}`);
    return{object,path,spriteCount,likelyState,searchText:`${path} ${componentNames}`.toLowerCase()};
  });
  const candidates=searchable.filter(item=>item.spriteCount>0&&(item.object.active===false||item.object.activeInRoom===false||item.likelyState))
    .sort((a,b)=>Number(b.likelyState)-Number(a.likelyState)||Number(a.object.activeInRoom)-Number(b.object.activeInRoom)||
      b.spriteCount-a.spriteCount||a.path.localeCompare(b.path,undefined,{numeric:true}));
  const grouped=new Map();
  for(const item of searchable.filter(entry=>(entry.object.activeInRoom===false||entry.object.active===false)&&entry.spriteCount>=20)){
    const key=item.object.parentId||'__root__',parentName=byId.get(item.object.parentId)?.name||'Other scene states';
    const group=grouped.get(key)||{key,parentName,options:[]};
    group.options.push({id:item.object.id,name:item.object.name||'(unnamed)',spriteCount:item.spriteCount,activeInRoom:item.object.activeInRoom===true});
    grouped.set(key,group);
  }
  const groups=[...grouped.values()].filter(group=>group.options.length>1&&(
    /states?|variants?|phases?|conditions?|alternatives?|versions?/i.test(group.parentName)||
    (group.options.every(option=>/\bworld\b/i.test(option.name))&&group.options.some(option=>/normal|black|thread|dream|memory|light|dark/i.test(option.name)))
  ));
  return{groups,candidates,searchable};
}

function renderRoomStateGroupFilters() {
  const root=$('roomStateGroups');
  root.innerHTML=state.roomStateGroups.length?state.roomStateGroups.map((group,index)=>{
    const overridden=group.options.some(option=>state.roomStateOverrides.has(option.id));
    const selected=group.options.find(option=>state.roomStateOverrides.get(option.id)==='show')?.id||'';
    const options=`<label class="toggle"><input type="radio" name="room-state-group-${index}" data-room-state-group="${index}" value="" ${!overridden?'checked':''}><span>Use saved state</span></label>`+
      group.options.map(option=>`<label class="toggle"><input type="radio" name="room-state-group-${index}" data-room-state-group="${index}" value="${esc(option.id)}" ${selected===option.id?'checked':''}><span>${esc(option.name)} <small>${option.spriteCount.toLocaleString()} renderers</small></span></label>`).join('');
    return`<fieldset class="room-state-group"><legend>${esc(group.parentName)}</legend>${options}</fieldset>`;
  }).join(''):'<span class="hint">No mutually named sibling state sets were found. Use the search below or show all serialized-inactive content.</span>';
  root.querySelectorAll('[data-room-state-group]').forEach(input=>input.addEventListener('change',()=>{
    if(!input.checked)return;
    const group=state.roomStateGroups[Number(input.dataset.roomStateGroup)],selectedId=input.value||null;
    for(const option of group.options){
      if(!selectedId)state.roomStateOverrides.delete(option.id);
      else state.roomStateOverrides.set(option.id,option.id===selectedId?'show':'hide');
    }
    renderRoomStateGroupFilters();renderRoomStateObjectFilters();updateRoomViewDisplay();draw();
  }));
}

function renderRoomStateObjectFilters() {
  const root=$('roomStateObjects'),query=$('roomStateSearch').value.trim().toLowerCase();
  const groupedIds=new Set(state.roomStateGroups.flatMap(group=>group.options.map(option=>option.id)));
  const all=state.roomStateCandidates.filter(item=>!groupedIds.has(item.object.id));
  const matches=query?all.filter(item=>item.searchText.includes(query)).sort((a,b)=>
    Number(b.likelyState)-Number(a.likelyState)||b.spriteCount-a.spriteCount||a.path.localeCompare(b.path,undefined,{numeric:true})):all;
  const visible=matches.slice(0,query?80:24);
  if(!visible.length){root.innerHTML=`<span class="hint">${query?'No room objects match that search.':'No separately named state objects were found.'}</span>`;return;}
  root.innerHTML=visible.map(item=>{
    const object=item.object,override=state.roomStateOverrides.get(object.id),savedVisible=object.active===true&&object.activeInRoom===true,checked=override?override==='show':savedVisible;
    const status=savedVisible?'visible in saved state':'hidden in saved state';
    return`<label class="room-state-object"><input type="checkbox" data-room-state-object="${esc(object.id)}" ${checked?'checked':''}><span>${esc(object.name||'(unnamed)')}<small>${status} · ${item.spriteCount.toLocaleString()} sprites or meshes below</small></span></label>`;
  }).join('')+(matches.length>visible.length?`<span class="hint">Showing ${visible.length} of ${matches.length.toLocaleString()} matches; search to narrow the list.</span>`:'');
  root.querySelectorAll('[data-room-state-object]').forEach(input=>input.addEventListener('change',()=>{
    const id=input.dataset.roomStateObject,item=state.roomStateCandidates.find(candidate=>candidate.object.id===id),baseline=item?.object.active===true&&item?.object.activeInRoom===true;
    const group=state.roomStateGroups.find(candidate=>candidate.options.some(option=>option.id===id));
    if(group&&input.checked){for(const option of group.options)state.roomStateOverrides.set(option.id,option.id===id?'show':'hide');}
    else if(input.checked===baseline)state.roomStateOverrides.delete(id);
    else state.roomStateOverrides.set(id,input.checked?'show':'hide');
    renderRoomStateGroupFilters();renderRoomStateObjectFilters();updateRoomViewDisplay();draw();
  }));
}

function collectCameraSections(meta) {
  const sections=[];
  for(const object of meta?.objects||[]){
    if(object.active===false||object.activeInRoom===false||!/(camera.?lock|cam.?lock)/i.test(object.name||''))continue;
    const points=(object.colliders||[]).filter(collider=>collider.enabled!==false&&['BoxCollider2D','PolygonCollider2D'].includes(collider.type)).flatMap(collider=>collider.worldPoints||[]).filter(point=>Number.isFinite(point.x)&&Number.isFinite(point.y));
    if(points.length<3)continue;
    const bounds={minX:Math.min(...points.map(point=>point.x)),maxX:Math.max(...points.map(point=>point.x)),minY:Math.min(...points.map(point=>point.y)),maxY:Math.max(...points.map(point=>point.y))};
    const width=bounds.maxX-bounds.minX,height=bounds.maxY-bounds.minY;
    if(width<.5||height<.5)continue;
    sections.push({key:`camera:${object.id||sections.length}`,name:labelCase(object.name||`Camera area ${sections.length+1}`),bounds,width,height,aspect:width/height});
  }
  const labelCounts=new Map();
  for(const section of sections)labelCounts.set(section.name,(labelCounts.get(section.name)||0)+1);
  const labelSeen=new Map();
  for(const section of sections){if(labelCounts.get(section.name)>1){const index=(labelSeen.get(section.name)||0)+1;labelSeen.set(section.name,index);section.name+=` · ${index}`;}}
  return sections.sort((a,b)=>a.bounds.minX-b.bounds.minX||b.bounds.maxY-a.bounds.maxY||a.name.localeCompare(b.name,undefined,{numeric:true}));
}
function suggestedCameraSection(sections){
  if(!sections.length)return null;
  const source=sections.filter(section=>section.file);
  if(!source.length)return null;
  const candidates=source.filter(section=>section.width>=12&&section.height>=5);
  const pool=candidates.length?candidates:source;
  return pool.slice().sort((a,b)=>{
    const score=section=>Math.abs(Math.log(Math.max(.01,section.aspect)/3.3))+(section.width<18?.45:0)+(section.height<6?.45:0)+(section.width*section.height<220?.35:0);
    return score(a)-score(b)||b.width*b.height-a.width*a.height;
  })[0];
}
function setupRoomSections(meta){
  const baked=new Map((meta?.image?.cameraSections||[]).map(section=>[section.key,section]));
  state.cameraSections=collectCameraSections(meta).map(section=>{
    const image=baked.get(section.key);if(!image)return section;
    return {...section,file:image.file,imageWidth:image.width,imageHeight:image.height,pixelsPerWorldUnit:image.pixelsPerWorldUnit,
      nativePixelsPerWorldUnit:image.nativePixelsPerWorldUnit,resolutionLimited:Boolean(image.resolutionLimited)};
  });
  const suggested=suggestedCameraSection(state.cameraSections);
  const wholeLabel='Whole scene · all sections';
  $('roomViewSelect').innerHTML=`<option value="whole">${wholeLabel}</option>`+state.cameraSections.map(section=>`<option value="${esc(section.key)}">${esc(section.name)} · ${section.width.toFixed(1)} × ${section.height.toFixed(1)}u</option>`).join('');
  state.roomViewKey=suggested?.key||'whole';
  $('roomViewSelect').value=state.roomViewKey;
  $('roomSectionPanel').hidden=!state.cameraSections.length;
  $('roomViewSelect').onchange=async()=>{state.roomViewKey=$('roomViewSelect').value;const section=state.cameraSections.find(item=>item.key===state.roomViewKey);state.roomViewImage=section?.file?await loadImage(section.file):null;updateRoomViewDisplay();draw();};
  updateRoomViewDisplay();
}
function currentRoomViewBounds(meta=state.roomMeta){
  return state.cameraSections.find(section=>section.key===state.roomViewKey)?.bounds||meta?.image?.bounds||null;
}
function roomViewDimensions(meta=state.roomMeta){
  const image=meta?.image;if(!image)return '';
  const dynamic=state.showAllInactiveArtwork||state.includeDisabledStateArtwork||state.roomStateOverrides.size>0;
  if(dynamic&&state.roomViewKey==='whole'){
    const cache=conditionalCacheFor(meta),bounds=cache?.scene.renderables.length?cache.bounds:null;
    if(bounds)return `Auto-fit · ${(bounds.maxX-bounds.minX).toFixed(1)} × ${(bounds.maxY-bounds.minY).toFixed(1)} world units`;
  }
  if(state.roomViewKey==='whole'||!state.cameraSections.some(section=>section.key===state.roomViewKey))return `${Number(image.width).toLocaleString()} × ${Number(image.height).toLocaleString()} px`;
  const section=state.cameraSections.find(item=>item.key===state.roomViewKey),ppu=Number(image.pixelsPerWorldUnit)||1;
  if(section?.file)return `${Number(section.imageWidth||state.roomViewImage?.naturalWidth||0).toLocaleString()} × ${Number(section.imageHeight||state.roomViewImage?.naturalHeight||0).toLocaleString()} px · ${Number(section.pixelsPerWorldUnit).toFixed(2)} px/unit`;
  const source=state.roomImage;
  if(source?.naturalWidth&&source?.naturalHeight){
    const base=image.bounds,left=2+(section.bounds.minX-base.minX)*ppu,top=2+(base.maxY-section.bounds.maxY)*ppu;
    const right=2+(section.bounds.maxX-base.minX)*ppu,bottom=2+(base.maxY-section.bounds.minY)*ppu;
    return `${Math.max(1,Math.ceil(right)-Math.floor(left)).toLocaleString()} × ${Math.max(1,Math.ceil(bottom)-Math.floor(top)).toLocaleString()} px`;
  }
  return `${Math.ceil(section.width*ppu).toLocaleString()} × ${Math.ceil(section.height*ppu).toLocaleString()} px`;
}
function updateRoomViewDisplay(){
  const section=state.cameraSections.find(item=>item.key===state.roomViewKey);
  const conditional=state.showAllInactiveArtwork||state.includeDisabledStateArtwork||state.roomStateOverrides.size>0;
  const cache=conditional?conditionalCacheFor():null;
  $('imageDimensions').textContent=roomViewDimensions();
  $('viewFoot').textContent=conditional?'ROOM STATE COMPOSED ONCE, THEN CACHED · SCROLL TO ZOOM · DRAG TO PAN':section?`${section.name.toUpperCase()} · CAMERA-LOCK ROOM SECTION · SCROLL TO ZOOM · DRAG TO PAN`:'WHOLE ROOM SCENE · SCROLL TO ZOOM · DRAG TO PAN';
  $('roomViewHint').textContent=conditional?cache&&!cache.scene.renderables.length?`This scene has no supported serialized renderer art to rebuild. The saved room image remains available.`:cache?.raster?`Composed from the selected real game sprites and meshes, then cached for smooth zoom and pan. The state image is kept in browser memory only.`:`Preparing this state from serialized game sprites and meshes. Atlas textures load only for the selected room; the result is cached in browser memory.`:section?section.file?`${section.resolutionLimited?'High-density camera render, capped for browser-safe dimensions':'Native-density camera render'} · ${section.width.toFixed(1)} × ${section.height.toFixed(1)} world units. Other room sections remain available in the menu.`:`Showing the ${section.width.toFixed(1)} × ${section.height.toFixed(1)} world-unit camera area from the whole-room composite.`:`Showing the complete prepared scene across all camera areas.`;
}
function currentRoomImage(){const section=state.cameraSections.find(item=>item.key===state.roomViewKey);return section?.file&&state.roomViewImage?.naturalWidth?state.roomViewImage:state.roomImage;}
function roomFrame(width,height,image=currentRoomImage(),meta=state.roomMeta){
  const section=state.cameraSections.find(item=>item.key===state.roomViewKey),dedicated=Boolean(section?.file&&image===state.roomViewImage);
  const base=dedicated?section.bounds:meta?.image?.bounds,view=dedicated?section.bounds:currentRoomViewBounds(meta);if(!image||!base||!view)return null;
  const ppu=dedicated?(Number(section.pixelsPerWorldUnit)||1):(Number(meta.image.pixelsPerWorldUnit)||1),imageScaleX=dedicated?1:image.naturalWidth/(Number(meta.image.width)||image.naturalWidth),imageScaleY=dedicated?1:image.naturalHeight/(Number(meta.image.height)||image.naturalHeight);
  const sourceX=dedicated?0:(2+(view.minX-base.minX)*ppu)*imageScaleX,sourceY=dedicated?0:(2+(base.maxY-view.maxY)*ppu)*imageScaleY;
  const sourceWidth=dedicated?image.naturalWidth:(view.maxX-view.minX)*ppu*imageScaleX,sourceHeight=dedicated?image.naturalHeight:(view.maxY-view.minY)*ppu*imageScaleY;
  const scale=Math.min((width-30)/Math.max(1,sourceWidth),(height-30)/Math.max(1,sourceHeight));
  const drawWidth=sourceWidth*scale,drawHeight=sourceHeight*scale,x=(width-drawWidth)/2,y=(height-drawHeight)/2;
  const point=(imagePixel)=>({x:x+(imagePixel.x*imageScaleX-sourceX)*scale,y:y+(imagePixel.y*imageScaleY-sourceY)*scale});
  const worldPoint=(worldX,worldY)=>({x:x+(worldX-view.minX)*(dedicated?ppu:ppu*imageScaleX)*scale,y:y+(view.maxY-worldY)*(dedicated?ppu:ppu*imageScaleY)*scale});
  return{base,view,ppu,imageScaleX,imageScaleY,sourcePpuX:dedicated?ppu:ppu*imageScaleX,sourcePpuY:dedicated?ppu:ppu*imageScaleY,sourceX,sourceY,sourceWidth,sourceHeight,scale,x,y,drawWidth,drawHeight,point,worldPoint,dedicated};
}

function waveGroups(architect) {
  const groups=architect?.eventGroups||[], byName=new Map(groups.map(group=>[String(group.name).toLowerCase(),group]));
  return groups.flatMap(group=>{
    const start=/^(.+?)([_-]?)start$/i.exec(group.name||'');
    if(!start||!/enable|show|activate/i.test(group.actions||''))return [];
    const end=byName.get(`${start[1]}${start[2]}end`.toLowerCase());
    return [{key:String(group.name),label:labelCase(start[1]),startEvent:group.name,endEvent:end?.name||null,placementCount:group.placementCount||0}];
  }).sort((a,b)=>a.label.localeCompare(b.label,undefined,{numeric:true}));
}
function setupArchitect(architect) {
  const markers=architect.markers||[], placements=architect.placements||[], waves=waveGroups(architect);
  $('toggleGauntlets').checked=false; $('gauntletDetails').hidden=true;
  $('architectCount').textContent=`${markers.length} markers`;
  const lookup=architect.enemyArtworkLookup||{}, matchedEnemyTypes=lookup.matchedEnemyTypes??Object.keys(architect.enemyArtwork||{}).length,
    requestedEnemyTypes=lookup.requestedEnemyTypes;
  const spriteSummary=requestedEnemyTypes===undefined?`${matchedEnemyTypes} enemy types matched to Silksong sprites`:`${matchedEnemyTypes}/${requestedEnemyTypes} enemy types matched to Silksong sprites`;
  $('architectNote').textContent=architect.error?`Metadata issue: ${architect.error}`:`${placements.length.toLocaleString()} serialized placements · ${architect.sourceFolder||'Architect data'} · ${spriteSummary} · gauntlet layer off by default.`;
  $('gauntletList').innerHTML=markers.length?markers.map((marker,index)=>`<button class="gauntlet-button" type="button" data-marker="${index}"><span class="gauntlet-glyph">G</span><span class="gauntlet-copy">${esc(cleanLabel(marker.label||'Gauntlet marker'))}<br><span class="nav-meta">${marker.placementCount||0} linked placements</span></span></button>`).join(''):'<div class="hint">No gauntlet markers were recorded for this room.</div>';
  document.querySelectorAll('[data-marker]').forEach(button=>button.addEventListener('click',()=>selectGauntlet(Number(button.dataset.marker))));
  const options=[{key:'all',label:'All gauntlet changes',startEvent:null,endEvent:null},...waves];
  $('waveSelect').innerHTML=options.map(wave=>`<option value="${esc(wave.key)}">${esc(wave.label)}${wave.startEvent?` · ${esc(wave.startEvent)}${wave.endEvent?` → ${esc(wave.endEvent)}`:''}`:''}</option>`).join('');
  $('waveSelect').onchange=()=>{state.selectedWave=$('waveSelect').value;renderPlacementList();draw();};
  $('toggleGauntlets').onchange=()=>{state.selectedGauntlet=null;$('gauntletDetails').hidden=true;document.querySelectorAll('.gauntlet-button').forEach(button=>button.classList.remove('active'));draw();};
  $('toggleArenaChanges').onchange=()=>draw(); $('toggleEnemyTextures').onchange=()=>draw();
  renderPlacementList();
}
function selectedWaveData() {
  const architect=state.roomMeta?.architect; const waves=waveGroups(architect);
  return state.selectedWave==='all'?{key:'all',label:'All gauntlet changes',startEvent:null,endEvent:null}:waves.find(wave=>wave.key===state.selectedWave)||{key:'all',label:'All gauntlet changes',startEvent:null,endEvent:null};
}
function placementsForWave() {
  const placements=state.roomMeta?.architect?.placements||[]; const wave=selectedWaveData();
  if(wave.key==='all')return placements.filter(record=>!record.controllerMarker);
  return placements.filter(record=>!record.controllerMarker&&(
    (record.listeners||[]).some(listener=>listener.event===wave.startEvent||listener.event===wave.endEvent)||
    (record.enemyCandidate&&!(record.listeners||[]).length)
  ));
}
function isPlacementEnabled(record) { return state.visiblePlacements.has(record.key)?state.visiblePlacements.get(record.key):Boolean(record.activeByDefault); }
function renderPlacementList() {
  if(state.mode!=='room'||!state.roomMeta?.architect)return;
  const records=placementsForWave(); const enemyRecords=records.filter(record=>record.enemyCandidate);
  const show=records.length?records:[]; $('placementCount').textContent=`${show.length}`;
  const wave=selectedWaveData(), eventLinked=show.filter(record=>(record.listeners||[]).some(listener=>listener.event===wave.startEvent||listener.event===wave.endEvent)).length,
    staticEnemies=wave.key==='all'?0:show.filter(record=>record.enemyCandidate&&!(record.listeners||[]).length).length;
  $('waveSummary').textContent=wave.key==='all'
    ? `${show.length} scene changes are available. Select a wave to focus its saved event listeners; enemy placements without event links remain separately identified.`
    : `${eventLinked} event-linked changes for ${wave.startEvent}${wave.endEvent?` and ${wave.endEvent}`:''} · ${staticEnemies} enemy placements have no saved phase listener and follow their saved active state.`;
  const uiRecords=show.slice(0,1200);
  $('placementList').innerHTML=uiRecords.length?uiRecords.map(record=>{
    const point=record.worldPosition||{}; const events=(record.listeners||[]).map(listener=>`${listener.event} · ${listener.action}`).join(', '), phase=events|| (record.enemyCandidate?'No phase listener · saved active state applies in every wave':'No saved activation event');
    return `<label class="placement-row"><input type="checkbox" data-placement="${esc(record.key)}" ${isPlacementEnabled(record)?'checked':''}><span class="placement-copy">${esc(record.label||record.placement?.id||'Placement')} · ${Number(point.x||0).toFixed(1)}, ${Number(point.y||0).toFixed(1)}${record.enemyCandidate?' · ENEMY':''}<span>${esc(phase)}</span></span></label>`;
  }).join(''):`<div class="hint">${wave.key==='all'?'No saved Architect placements in this room.':'No placements are linked to this event phase.'}</div>`;
  if(show.length>1200)$('placementList').insertAdjacentHTML('beforeend',`<div class="hint">Showing first 1,200 of ${show.length.toLocaleString()} placements.</div>`);
  document.querySelectorAll('[data-placement]').forEach(input=>input.addEventListener('change',()=>{state.visiblePlacements.set(input.dataset.placement,input.checked);draw();}));
}
function selectGauntlet(index) {
  if(!$('toggleGauntlets').checked){$('toggleGauntlets').checked=true;}
  const marker=state.roomMeta?.architect?.markers?.[index]; if(!marker)return;
  state.selectedGauntlet=marker; $('gauntletDetails').hidden=false;
  const waves=waveGroups(state.roomMeta.architect); const matching=waves.find(wave=>String(wave.startEvent).toLowerCase()===String(marker.virtualEvent||'').toLowerCase());
  state.selectedWave=matching?.key||'all'; $('waveSelect').value=state.selectedWave;
  document.querySelectorAll('.gauntlet-button').forEach((button,i)=>button.classList.toggle('active',i===index));
  if($('toggleArenaChanges').checked){
    const keys=new Set((state.roomMeta.architect.placements||[]).filter(record=>!record.controllerMarker && (record.listeners||[]).some(listener=>listener.event===marker.virtualEvent||listener.event===marker.virtualEndEvent)).map(record=>record.key));
    for(const record of state.roomMeta.architect.placements||[]) if(keys.has(record.key)&&!state.visiblePlacements.has(record.key)) state.visiblePlacements.set(record.key,Boolean(record.activeByDefault));
  }
  renderPlacementList(); draw();
}

function resizeCanvas() {
  const rect=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1);
  canvas.width=Math.max(1,Math.floor(rect.width*dpr));canvas.height=Math.max(1,Math.floor(rect.height*dpr));ctx.setTransform(dpr,0,0,dpr,0,0);draw();
}
function canvasSize(){const rect=canvas.getBoundingClientRect();return{width:rect.width,height:rect.height};}
function fitTransform(bounds,width,height,padding=26){
  if(!bounds)return{x:0,y:0,scale:1,bounds:{minX:0,maxX:1,minY:0,maxY:1}};
  const spanX=Math.max(.001,bounds.maxX-bounds.minX),spanY=Math.max(.001,bounds.maxY-bounds.minY),scale=Math.min((width-padding*2)/spanX,(height-padding*2)/spanY);
  return{x:(width-spanX*scale)/2-bounds.minX*scale,y:(height-spanY*scale)/2+bounds.maxY*scale,scale,bounds};
}
function viewportKey(){
  if(state.mode==='world'||state.mode==='all-rooms')return 'wide-map';
  if(state.mode==='area')return `area:${state.area?.key||''}:${state.mapBackdropVisible?'all-regions':'region'}`;
  if(state.mode==='room')return `room:${state.room?.name||''}:${state.roomViewKey}`;
  return state.mode;
}
function currentViewport(){
  const key=viewportKey();
  if(state.viewport.key!==key)state.viewport={key,zoom:1,offsetX:0,offsetY:0};
  return state.viewport;
}
function applyViewport(base){
  const view=currentViewport(),zoom=view.zoom;
  return{...base,x:base.x*zoom+view.offsetX,y:base.y*zoom+view.offsetY,scale:base.scale*zoom};
}
function mapTransform(bounds,width,height,padding=34){return applyViewport(fitTransform(bounds,width,height,padding));}
function zoomAt(screenPoint,deltaY){
  const view=currentViewport(),oldZoom=view.zoom;
  const nextZoom=Math.max(1,Math.min(14,oldZoom*Math.exp(-deltaY*.0012)));
  if(Math.abs(nextZoom-oldZoom)<.0001)return;
  const ratio=nextZoom/oldZoom;
  view.offsetX=screenPoint.x-(screenPoint.x-view.offsetX)*ratio;
  view.offsetY=screenPoint.y-(screenPoint.y-view.offsetY)*ratio;
  view.zoom=nextZoom;
  if(nextZoom===1){view.offsetX=0;view.offsetY=0;}
  draw();
}
function zoomRoomFrame(frame){
  if(!frame)return null;
  const view=currentViewport(),zoom=view.zoom,worldPoint=frame.worldPoint;
  return{...frame,x:frame.x*zoom+view.offsetX,y:frame.y*zoom+view.offsetY,
    drawWidth:frame.drawWidth*zoom,drawHeight:frame.drawHeight*zoom,scale:frame.scale*zoom,
    worldPoint:(x,y)=>{const point=worldPoint(x,y);return{x:point.x*zoom+view.offsetX,y:point.y*zoom+view.offsetY};}};
}
function screenPoint(point,transform){return{x:transform.x+point.x*transform.scale,y:transform.y-point.y*transform.scale};}
function worldAt(screen,transform){return{x:(screen.x-transform.x)/transform.scale,y:(transform.y-screen.y)/transform.scale};}
function mapBoundsForMode(){
  if(state.mode==='world'||state.mode==='all-rooms')return state.navigation?.maps?.wide?.bounds;
  if(state.mode==='area')return state.mapBackdropVisible?(allDetailBounds()||visibleAreaDetailBounds(state.area)||state.area?.wideBounds):(visibleAreaDetailBounds(state.area)||state.area?.wideBounds);
  return null;
}
function visibleAreaDetailBounds(area){return state.showConditionalMapArtwork?(area?.detailBoundsWithConditional||area?.detailBounds):area?.detailBounds;}
function allDetailBounds(){
  const bounds=(state.navigation?.areas||[]).map(visibleAreaDetailBounds).filter(Boolean);if(!bounds.length)return null;
  return{minX:Math.min(...bounds.map(b=>b.minX)),maxX:Math.max(...bounds.map(b=>b.maxX)),minY:Math.min(...bounds.map(b=>b.minY)),maxY:Math.max(...bounds.map(b=>b.maxY))};
}
function draw() {
  if(!ctx)return; const {width,height}=canvasSize(); if(!width||!height)return;
  ctx.clearRect(0,0,width,height);ctx.fillStyle='#080a08';ctx.fillRect(0,0,width,height);
  if(state.mode==='room'){drawRoom(width,height);return;}
  const mapType=state.mode==='area'&&state.area?.detailBounds?'detail':'wide';
  const imageRecord=state.navigation?.maps?.[mapType];
  const image=state.mode==='area'?null:worldMapImage(mapType);
  const bounds=mapBoundsForMode(); const transform=mapTransform(bounds,width,height,34);
  if(state.mode==='world'||state.mode==='all-rooms')drawWorld(width,height,transform,image,imageRecord);
  else drawArea(width,height,transform,image,imageRecord);
}
function drawWorld(width,height,transform,image,imageRecord) {
  const loaded=image?.complete&&image?.naturalWidth&&imageRecord?.bounds;
  if(loaded){const b=imageRecord.bounds,w=(b.maxX-b.minX)*transform.scale,h=(b.maxY-b.minY)*transform.scale;ctx.drawImage(image,transform.x+b.minX*transform.scale,transform.y-b.maxY*transform.scale,w,h);}
  const areas=(state.navigation?.areas||[]).filter(area=>area.widePosition);
  areas.forEach((area,index)=>{
    const point=screenPoint(area.widePosition,transform),selected=state.selectedAreaName===area.key,hovered=state.hoverAreaKey===area.key,focused=selected||hovered;
    ctx.save();
    if(focused){ctx.fillStyle=selected?'rgba(195,235,145,.24)':'rgba(195,235,145,.16)';ctx.beginPath();ctx.arc(point.x,point.y,17,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#d5f5a4';ctx.lineWidth=selected?2:1.5;ctx.beginPath();ctx.arc(point.x,point.y,12.5,0,Math.PI*2);ctx.stroke();}
    ctx.fillStyle=focused?'#d9f5aa':'rgba(15,22,16,.92)';ctx.strokeStyle=focused?'#e8ffd0':'rgba(210,226,185,.88)';ctx.lineWidth=focused?1.8:1.1;ctx.beginPath();ctx.arc(point.x,point.y,8,0,Math.PI*2);ctx.fill();ctx.stroke();
    ctx.fillStyle=focused?'#1b2a17':'#edf3df';ctx.font='bold 7px Consolas,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(index+1).padStart(2,'0'),point.x,point.y+.25);
    if(focused){
      const label=`${area.name} · ${area.rooms.length} rooms`;ctx.font='600 10px Segoe UI,Arial,sans-serif';const labelWidth=ctx.measureText(label).width+16,labelHeight=23;
      const left=Math.min(Math.max(8,point.x-labelWidth/2),width-labelWidth-8),top=point.y-34<8?point.y+17:point.y-34;
      ctx.fillStyle='rgba(7,10,8,.94)';ctx.strokeStyle='#c8e89b';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(left,top,labelWidth,labelHeight,5);ctx.fill();ctx.stroke();
      ctx.fillStyle='#eff8df';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,left+labelWidth/2,top+labelHeight/2);
    }
    ctx.restore();
  });
  if(!loaded)drawFallbackNotice(width,height,'Game wide map image is still loading.');
}
function drawArea(width,height,transform,image,imageRecord) {
  const area=state.area;if(!area)return;
  if(state.mapBackdropVisible){
    for(const other of state.navigation?.areas||[])if(other.key!==area.key)drawGameMapSection(other,transform,.8);
    drawGameMapSection(area,transform,1);
    drawAreaBounds(area,transform,'rgba(237,247,216,.88)',true,true);
  }else{
    drawGameMapSection(area,transform,1);
    const hovered=(area.rooms||[]).find(room=>room.name===state.hoverRoomName);
    if(hovered)drawHoveredRoom(hovered,transform,width,height);
    if(!areaMapArtwork(area).length&&!areaMapRooms(area,state.showConditionalMapArtwork).some(room=>room.mapAnchor))drawFallbackNotice(width,height,'No room map artwork is recorded here. Choose a room from the list.');
  }
  drawMapRoomAnchors(area,transform);
  if(state.showArchitectMapMarkers)drawArchitectMapMarkers(area,transform);
}
function mapVariantKey(name){return fileBase(name).toLowerCase().replace(/(?:[_-](?:destroyed|ruined|broken|break|collapsed|completed|quiet|creature|activated|inactive|restored|secret|opened|closed|flooded|repaired|revealed|shortcut))+$/,'');}
function mapVariantRank(name){return mapVariantKey(name)===fileBase(name).toLowerCase()?0:1;}
function boundsIoU(a,b){if(!a||!b)return 0;const w=Math.max(0,Math.min(a.maxX,b.maxX)-Math.max(a.minX,b.minX)),h=Math.max(0,Math.min(a.maxY,b.maxY)-Math.max(a.minY,b.minY)),intersection=w*h,union=(a.maxX-a.minX)*(a.maxY-a.minY)+(b.maxX-b.minX)*(b.maxY-b.minY)-intersection;return union>0?intersection/union:0;}
function areaMapRooms(area,includeConditional=false){
  const cacheKey=`${area?.key||''}|${Number(includeConditional)}`;
  if(state.mapRoomCache.has(cacheKey))return state.mapRoomCache.get(cacheKey);
  const rooms=(area?.rooms||[]).filter(room=>(room.mapSprites?.length||room.mapAnchor)&&findRoom(room.name)&&(includeConditional||!room.conditionalMapState)).slice().sort((a,b)=>mapVariantRank(a.name)-mapVariantRank(b.name)||a.name.localeCompare(b.name));
  const kept=[];
  for(const room of rooms){
    const duplicate=!room.conditionalMapState&&kept.some(previous=>{
      const related=mapVariantKey(previous.name)===mapVariantKey(room.name)||mapVariantRank(previous.name)>0||mapVariantRank(room.name)>0;
      return related&&boundsIoU(previous.bounds,room.bounds)>.58;
    });
    if(!duplicate)kept.push(room);
  }
  state.mapRoomCache.set(cacheKey,kept);return kept;
}
function areaMapArtwork(area){
  const mapped=state.showMappedMapArtwork?areaMapRooms(area).flatMap(room=>room.mapSprites||[]):[];
  const unassigned=state.showUnmappedMapArtwork?(area?.unmappedMapArtwork||[]).flatMap(object=>object.mapSprites||[]):[];
  const conditional=state.showConditionalMapArtwork?[
    ...(area?.conditionalMapArtwork||[]).flatMap(object=>object.mapSprites||[]),
    ...(area?.rooms||[]).filter(room=>room.conditionalMapState).flatMap(room=>room.mapSprites||[])
  ]:[];
  return [...mapped,...unassigned,...conditional];
}
function drawAreaBounds(area,transform,color,dashed=false,detailOnly=false){
  const b=detailOnly?visibleAreaDetailBounds(area):(visibleAreaDetailBounds(area)||area.wideBounds);if(!b)return;const topLeft=screenPoint({x:b.minX,y:b.maxY},transform),bottomRight=screenPoint({x:b.maxX,y:b.minY},transform);
  ctx.save();ctx.strokeStyle=color;ctx.lineWidth=1.5;ctx.setLineDash(dashed?[6,4]:[]);ctx.strokeRect(topLeft.x,topLeft.y,bottomRight.x-topLeft.x,bottomRight.y-topLeft.y);ctx.restore();
}
function drawHoveredRoom(room,transform,width,height){
  const b=room.bounds;if(!b)return;const topLeft=screenPoint({x:b.minX,y:b.maxY},transform),bottomRight=screenPoint({x:b.maxX,y:b.minY},transform),w=bottomRight.x-topLeft.x,h=bottomRight.y-topLeft.y;
  ctx.save();ctx.fillStyle='rgba(213,245,164,.08)';ctx.strokeStyle='rgba(228,255,188,.95)';ctx.lineWidth=1.5;ctx.fillRect(topLeft.x,topLeft.y,w,h);ctx.strokeRect(topLeft.x,topLeft.y,w,h);
  const label=fileBase(room.name);ctx.font='600 11px Segoe UI,Arial,sans-serif';const labelWidth=ctx.measureText(label).width+14,labelHeight=22,left=Math.max(7,Math.min(width-labelWidth-7,topLeft.x)),top=topLeft.y-labelHeight-5<7?Math.min(height-labelHeight-7,bottomRight.y+5):topLeft.y-labelHeight-5;
  ctx.fillStyle='rgba(8,12,9,.95)';ctx.strokeStyle='rgba(228,255,188,.85)';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(left,top,labelWidth,labelHeight,4);ctx.fill();ctx.stroke();ctx.fillStyle='#eff8df';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(label,left+labelWidth/2,top+labelHeight/2);ctx.restore();
}
function drawMapRoomAnchors(area,transform){
  const anchors=areaMapRooms(area,state.showConditionalMapArtwork).filter(room=>room.mapAnchor);
  const {width,height}=canvasSize();
  const clusters=[];
  for(const room of anchors){
    const point=screenPoint(room.center,transform),near=clusters.find(item=>Math.hypot(item.point.x-point.x,item.point.y-point.y)<13);
    if(near)near.rooms.push(room);else clusters.push({point,rooms:[room]});
  }
  for(const cluster of clusters){
    const {x,y}=cluster.point;if(x<-12||y<-12||x>width+12||y>height+12)continue;
    ctx.save();ctx.fillStyle='rgba(12,16,13,.94)';ctx.strokeStyle='#c9dda9';ctx.lineWidth=1.2;ctx.beginPath();ctx.arc(x,y,7,0,Math.PI*2);ctx.fill();ctx.stroke();
    ctx.fillStyle='#eff8df';ctx.font='bold 7px Consolas,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(cluster.rooms.length>1?String(cluster.rooms.length):'R',x,y+.25);ctx.restore();
  }
}
function drawArchitectMapMarkers(area,transform){
  const {width,height}=canvasSize();
  for(const room of areaMapRooms(area,state.showConditionalMapArtwork).filter(item=>item.architect?.markerCount)){
    const {x,y}=screenPoint(room.center,transform);if(x<-16||y<-16||x>width+16||y>height+16)continue;
    ctx.save();ctx.fillStyle='rgba(40,28,54,.96)';ctx.strokeStyle='#c8a8ed';ctx.lineWidth=1.4;ctx.beginPath();ctx.arc(x,y,9,0,Math.PI*2);ctx.fill();ctx.stroke();
    ctx.fillStyle='#f1e6ff';ctx.font='bold 8px Consolas,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(`G${room.architect.markerCount}`,x,y+.25);ctx.restore();
  }
}
function mapSpriteGeometry(sprite){const ppu=Math.max(1,Number(sprite.pixelsPerUnit)||100),rotated=Number(sprite.packingRotation)===4,width=(rotated?Number(sprite.rectHeight||0):Number(sprite.rectWidth||0))/ppu,height=(rotated?Number(sprite.rectWidth||0):Number(sprite.rectHeight||0))/ppu,originalWidth=Number(sprite.originalWidth||(rotated?sprite.rectHeight:sprite.rectWidth)||0)/ppu,originalHeight=Number(sprite.originalHeight||(rotated?sprite.rectWidth:sprite.rectHeight)||0)/ppu;return{width,height,left:Number(sprite.trimOffsetX||0)/ppu-(Number(sprite.pivotX??.5)*originalWidth),bottom:Number(sprite.trimOffsetY||0)/ppu-(Number(sprite.pivotY??.5)*originalHeight)};}
function mapSpriteImage(hash,requestDraw=true){let image=state.atlasCache.get(hash);if(!image){image=new Image();image._requestDraw=Boolean(requestDraw);state.atlasCache.set(hash,image);image.onload=()=>{if(image._requestDraw)draw();};image.onerror=()=>{};image.src=`${ARTWORK_BASE}${hash}.${ARTWORK_EXTENSION}`;}else if(requestDraw&&!image.complete)image._requestDraw=true;return image;}
function drawGameMapSection(area,transform,opacity=1){
  const sprites=areaMapArtwork(area).filter(sprite=>sprite.textureSha256&&sprite.worldPosition).sort((a,b)=>(Number(a.sortingLayerValue)||0)-(Number(b.sortingLayerValue)||0)||(Number(a.sortingOrder)||0)-(Number(b.sortingOrder)||0)||(Number(b.worldPosition.z)||0)-(Number(a.worldPosition.z)||0)||(Number(a.mapObjectOrder)||0)-(Number(b.mapObjectOrder)||0)||(Number(a.mapSpriteOrder)||0)-(Number(b.mapSpriteOrder)||0));
  for(const sprite of sprites){
    const image=mapSpriteImage(sprite.textureSha256);if(!image.complete||!image.naturalWidth)continue;
    const geometry=mapSpriteGeometry(sprite),position=screenPoint(sprite.worldPosition,transform),m00=Number.isFinite(sprite.worldM00)?sprite.worldM00:1,m01=Number.isFinite(sprite.worldM01)?sprite.worldM01:0,m10=Number.isFinite(sprite.worldM10)?sprite.worldM10:0,m11=Number.isFinite(sprite.worldM11)?sprite.worldM11:1;
    if(!geometry.width||!geometry.height)continue;
    ctx.save();ctx.translate(position.x,position.y);ctx.transform(transform.scale*m00,-transform.scale*m10,transform.scale*m01,-transform.scale*m11,0,0);ctx.translate(geometry.left+geometry.width/2,geometry.bottom+geometry.height/2);
    if(sprite.flipX)ctx.scale(-1,1);if(sprite.flipY)ctx.scale(1,-1);
    const rotated=Number(sprite.packingRotation)===4;
    if(Number(sprite.packingRotation)===1)ctx.scale(-1,1);else if(Number(sprite.packingRotation)===2)ctx.scale(1,-1);else if(Number(sprite.packingRotation)===3)ctx.rotate(Math.PI);else if(rotated)ctx.rotate(-Math.PI/2);
    ctx.scale(1,-1);ctx.globalAlpha=Math.max(0,Math.min(1,Number(sprite.tintA)||1))*opacity;
    const sourceY=Number(sprite.textureHeight)-Number(sprite.rectY)-Number(sprite.rectHeight);
    const tinted=getTintedMapSprite(sprite,image,sourceY),sourceWidth=rotated?geometry.height:geometry.width,sourceHeight=rotated?geometry.width:geometry.height;
    if(tinted)ctx.drawImage(tinted,-sourceWidth/2,-sourceHeight/2,sourceWidth,sourceHeight);
    else {
      ctx.drawImage(image,Number(sprite.rectX),sourceY,Number(sprite.rectWidth),Number(sprite.rectHeight),-sourceWidth/2,-sourceHeight/2,sourceWidth,sourceHeight);
    }
    ctx.restore();
  }
}
function getTintedMapSprite(sprite,image,sourceY){
  const tint=[sprite.tintR,sprite.tintG,sprite.tintB].map(value=>Math.max(0,Math.min(1,Number(value??1))));
  if(tint.every(value=>value>.995))return null;
  const key=[sprite.textureSha256,sprite.rectX,sprite.rectY,sprite.rectWidth,sprite.rectHeight,...tint].join(':');
  if(state.mapSpriteTintCache.has(key))return state.mapSpriteTintCache.get(key);
  try{
    const width=Math.max(1,Math.ceil(Number(sprite.rectWidth))),height=Math.max(1,Math.ceil(Number(sprite.rectHeight))),canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const crop=canvas.getContext('2d',{willReadFrequently:true});crop.drawImage(image,Number(sprite.rectX),sourceY,Number(sprite.rectWidth),Number(sprite.rectHeight),0,0,width,height);
    const pixels=crop.getImageData(0,0,width,height),data=pixels.data;
    for(let i=0;i<data.length;i+=4){data[i]=Math.round(data[i]*tint[0]);data[i+1]=Math.round(data[i+1]*tint[1]);data[i+2]=Math.round(data[i+2]*tint[2]);}
    crop.putImageData(pixels,0,0);state.mapSpriteTintCache.set(key,canvas);return canvas;
  }catch{return null;}
}
function drawFallbackNotice(width,height,text){ctx.fillStyle='#aab09f';ctx.font='11px Consolas,monospace';ctx.textAlign='center';ctx.fillText(text,width/2,height/2);}
function drawRoom(width,height){
  const image=currentRoomImage(),meta=state.roomMeta;if(!meta?.image)return;
  const dynamic=state.showAllInactiveArtwork||state.includeDisabledStateArtwork||state.roomStateOverrides.size>0;
  const cache=dynamic?conditionalCacheFor(meta):null;
  const rebuild=Boolean(dynamic&&cache?.scene.renderables.length);
  const baseFrame=rebuild?(cache?.raster?conditionalRasterFrame(width,height,meta,cache):conditionalRoomFrame(width,height,meta,cache?.scene)):roomFrame(width,height,image,meta);
  const frame=zoomRoomFrame(baseFrame);if(!frame)return;
  if(rebuild&&cache?.raster){ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(cache.raster,frame.sourceX,frame.sourceY,frame.sourceWidth,frame.sourceHeight,frame.x,frame.y,frame.drawWidth,frame.drawHeight);}
  else if(rebuild){
    if(image)drawSavedRoomImage(image,meta,frame);
    drawFallbackNotice(width,height,cache?.error?'Could not compose this room state; showing the saved image.':'Preparing the selected room state…');
  }
  else if(image){ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,frame.sourceX,frame.sourceY,frame.sourceWidth,frame.sourceHeight,frame.x,frame.y,frame.drawWidth,frame.drawHeight);}
  else drawFallbackNotice(width,height,'The saved room image is unavailable.');
  const visible=[];
  for(const object of meta.objects||[]){const point=object.worldPosition;if(!point)continue;const classification=object.classification||{};
    if(classification.enemy&&$('toggleEnemies').checked)visible.push({object,point,color:'#e69b35',kind:'E'});
    if(classification.spawn&&$('toggleSpawns').checked)visible.push({object,point,color:'#79b9d4',kind:'S'});
    if(classification.check&&$('toggleChecks').checked)visible.push({object,point,color:'#77c7aa',kind:'C'});
  }
  for(const item of visible){const point=frame.worldPoint(item.point.x,item.point.y),px=point.x,py=point.y;if(px<frame.x||px>frame.x+frame.drawWidth||py<frame.y||py>frame.y+frame.drawHeight)continue;ctx.save();ctx.fillStyle=item.color;ctx.strokeStyle='#0b0d0b';ctx.lineWidth=2;ctx.beginPath();ctx.arc(px,py,5,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#0b0d0b';ctx.font='bold 6px Consolas,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(item.kind,px,py+.2);ctx.restore();}
  drawArchitect(width,height,frame,meta);
}

function drawSavedRoomImage(image,meta,frame){
  const section=state.cameraSections.find(item=>item.key===state.roomViewKey),dedicated=Boolean(section?.file&&image===state.roomViewImage);
  const bounds=dedicated?section.bounds:meta.image?.bounds,metadataWidth=Number(dedicated?section.imageWidth:meta.image?.width)||image.naturalWidth,
    metadataHeight=Number(dedicated?section.imageHeight:meta.image?.height)||image.naturalHeight;
  if(!bounds)return;
  const pixelsPerUnit=Number(dedicated?section.pixelsPerWorldUnit:meta.image?.pixelsPerWorldUnit)||1,
    pixelsX=image.naturalWidth/metadataWidth,pixelsY=image.naturalHeight/metadataHeight,
    targetScaleX=frame.sourcePpuX*frame.scale,targetScaleY=frame.sourcePpuY*frame.scale,
    sourcePpuX=pixelsPerUnit*pixelsX,sourcePpuY=pixelsPerUnit*pixelsY;
  const x=frame.x+(bounds.minX-frame.view.minX)*targetScaleX-2*targetScaleX/sourcePpuX,
    y=frame.y+(frame.view.maxY-bounds.maxY)*targetScaleY-2*targetScaleY/sourcePpuY,
    width=image.naturalWidth*targetScaleX/sourcePpuX,height=image.naturalHeight*targetScaleY/sourcePpuY;
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,x,y,width,height);
}

function conditionalRoomFrame(width,height,meta,renderables){
  const section=state.cameraSections.find(item=>item.key===state.roomViewKey),view=section?.bounds||conditionalArtworkBounds(meta,renderables);
  if(!view)return null;
  const spanX=Math.max(.001,view.maxX-view.minX),spanY=Math.max(.001,view.maxY-view.minY);
  const ppu=Math.max(1,Number(section?.pixelsPerWorldUnit)||Number(meta?.image?.pixelsPerWorldUnit)||1);
  const scale=Math.min((width-30)/(spanX*ppu),(height-30)/(spanY*ppu));
  const drawWidth=spanX*ppu*scale,drawHeight=spanY*ppu*scale,x=(width-drawWidth)/2,y=(height-drawHeight)/2;
  return{view,x,y,drawWidth,drawHeight,scale,sourcePpuX:ppu,sourcePpuY:ppu,dedicated:Boolean(section),
    worldPoint:(worldX,worldY)=>({x:x+(worldX-view.minX)*ppu*scale,y:y+(view.maxY-worldY)*ppu*scale})};
}

function conditionalRasterFrame(width,height,meta,cache){
  const section=state.cameraSections.find(item=>item.key===state.roomViewKey),bounds=cache.bounds,view=section?.bounds||bounds;
  if(!bounds||!view)return null;
  const ppu=cache.pixelsPerWorldUnit,sourceX=(view.minX-bounds.minX)*ppu,sourceY=(bounds.maxY-view.maxY)*ppu;
  const sourceWidth=(view.maxX-view.minX)*ppu,sourceHeight=(view.maxY-view.minY)*ppu;
  const scale=Math.min((width-30)/Math.max(1,sourceWidth),(height-30)/Math.max(1,sourceHeight));
  const drawWidth=sourceWidth*scale,drawHeight=sourceHeight*scale,x=(width-drawWidth)/2,y=(height-drawHeight)/2;
  return{bounds,view,ppu,sourcePpuX:ppu,sourcePpuY:ppu,sourceX,sourceY,sourceWidth,sourceHeight,scale,x,y,drawWidth,drawHeight,
    worldPoint:(worldX,worldY)=>({x:x+(worldX-view.minX)*ppu*scale,y:y+(view.maxY-worldY)*ppu*scale})};
}

function conditionalObjectVisibility(object,byId,cache){
  if(cache.has(object.id))return cache.get(object.id);
  const chain=[],seen=new Set();let current=object;
  while(current&&!seen.has(current.id)){seen.add(current.id);chain.push(current);current=byId.get(current.parentId);}
  let visible=true,forcedState=null;
  for(const item of chain.reverse()){
    const override=state.roomStateOverrides.get(item.id);
    if(override){forcedState=override;visible=override==='show';continue;}
    if(forcedState==='show'){visible=true;continue;}
    if(forcedState==='hide'){visible=false;continue;}
    const inactive=item.activeInRoom===false||item.active===false;
    if(inactive&&state.showAllInactiveArtwork){forcedState='show';visible=true;continue;}
    if(inactive)visible=false;
  }
  cache.set(object.id,visible);return visible;
}

function roomShaderEffect(object,artwork){
  const name=`${object.name||''} ${artwork.name||''} ${artwork.materialName||''}`.toLowerCase();
  return['black_solid','white_fader','black_fader','vignette','darkness','mask_beam','soft_masker','remasker',
    'light_effect','white_light','light_beam','water_fog'].some(term=>name.includes(term))||/\b(light|fog|haze|glow)\b/.test(name);
}
function roomCanvasBlend(mode){return mode==='additive'?'lighter':mode==='multiply'?'multiply':'source-over';}

function collectConditionalRoomArtwork(meta){
  const objects=meta.objects||[],byId=new Map(objects.map(object=>[object.id,object])),visibleCache=new Map(),renderables=[];
  for(let objectIndex=0;objectIndex<objects.length;objectIndex++){
    const object=objects[objectIndex];
    if(!conditionalObjectVisibility(object,byId,visibleCache))continue;
    if(object.sortingGroup?.enabled&&object.sortingGroup.sortingLayerKnown===false)continue;
    for(let rendererIndex=0;rendererIndex<(object.sprites||[]).length;rendererIndex++){
      const sprite=object.sprites[rendererIndex];
      if(!/^[a-f0-9]{64}$/i.test(sprite.textureSha256||'')||!sprite.rectWidth||!sprite.rectHeight||sprite.sortingLayerKnown===false||
        sprite.blendMode==='destination'||roomShaderEffect(object,sprite)||
        (sprite.rendererEnabled===false&&!state.includeDisabledStateArtwork))continue;
      renderables.push({object,artwork:sprite,type:'sprite',objectIndex,rendererIndex});
    }
    for(let rendererIndex=0;rendererIndex<(object.meshes||[]).length;rendererIndex++){
      const mesh=object.meshes[rendererIndex];
      if(!/^[a-f0-9]{64}$/i.test(mesh.textureSha256||'')||mesh.sortingLayerKnown===false||mesh.blendMode==='destination'||
        roomShaderEffect(object,mesh)||(mesh.rendererEnabled===false&&!state.includeDisabledStateArtwork))continue;
      renderables.push({object,artwork:mesh,type:'mesh',objectIndex,rendererIndex});
    }
  }
  return{renderables,meshAssets:new Map((meta.meshAssets||[]).map(asset=>[asset.id,asset]))};
}

function conditionalStateKey(meta){
  const overrides=[...state.roomStateOverrides.entries()].sort(([a],[b])=>String(a).localeCompare(String(b))).map(([id,value])=>`${id}:${value}`).join(',');
  return`${meta?.scene?.name||state.room?.name||''}|${state.roomViewKey}|${Number(state.showAllInactiveArtwork)}|${Number(state.includeDisabledStateArtwork)}|${overrides}`;
}

function conditionalCacheFor(meta=state.roomMeta){
  if(!meta?.image)return null;
  const key=conditionalStateKey(meta);
  if(state.conditionalCache?.meta===meta&&state.conditionalCache.key===key)return state.conditionalCache;
  const scene=collectConditionalRoomArtwork(meta),section=state.cameraSections.find(item=>item.key===state.roomViewKey),bounds=section?.bounds||conditionalArtworkBounds(meta,scene);
  const cache={meta,key,scene,bounds,raster:null,building:false,error:null,version:++state.conditionalBuildVersion,pixelsPerWorldUnit:1};
  state.conditionalCache=cache;
  void buildConditionalRaster(cache);
  return cache;
}

function orderedConditionalRenderables(scene){
  const unitsById=new Map();
  for(const renderable of scene.renderables){
    const group=renderable.object.sortingGroup?.enabled?renderable.object.sortingGroup:null;
    const unitId=group?`group:${group.objectId||renderable.object.parentId||renderable.object.id}`:`single:${renderable.objectIndex}:${renderable.type}:${renderable.rendererIndex}`;
    let unit=unitsById.get(unitId);
    if(!unit){unit={items:[],layer:Number(group?.sortingLayerValue??renderable.artwork.sortingLayerValue)||0,
      order:Number(group?.sortingOrder??renderable.artwork.sortingOrder)||0,z:Number(group?.worldPosition?.z??renderable.object.worldPosition?.z)||0,stableIndex:renderable.objectIndex};unitsById.set(unitId,unit);}
    unit.items.push(renderable);
  }
  const itemOrder=(a,b)=>(Number(a.artwork.sortingLayerValue)||0)-(Number(b.artwork.sortingLayerValue)||0)||
    (Number(a.artwork.sortingOrder)||0)-(Number(b.artwork.sortingOrder)||0)||a.objectIndex-b.objectIndex||a.rendererIndex-b.rendererIndex;
  return[...unitsById.values()].sort((a,b)=>a.layer-b.layer||a.order-b.order||b.z-a.z||a.stableIndex-b.stableIndex)
    .flatMap(unit=>unit.items.sort(itemOrder));
}

function waitForAtlas(hash){
  const image=mapSpriteImage(hash,false);
  if(image.complete)return Promise.resolve(image.naturalWidth?image:null);
  return new Promise(resolve=>{
    let settled=false;const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>finish(null),25000);
    image.addEventListener('load',()=>finish(image.naturalWidth?image:null),{once:true});
    image.addEventListener('error',()=>finish(null),{once:true});
  });
}

async function buildConditionalRaster(cache){
  if(cache.building||!cache.bounds)return;
  cache.building=true;
  try{
    const hashes=[...new Set(cache.scene.renderables.map(item=>item.artwork.textureSha256).filter(Boolean))],cursor={index:0};
    await Promise.all(Array.from({length:8},async()=>{while(cursor.index<hashes.length){const hash=hashes[cursor.index++];await waitForAtlas(hash);if(state.conditionalCache!==cache)return;}}));
    if(state.conditionalCache!==cache)return;
    const b=cache.bounds,section=state.cameraSections.find(item=>item.key===state.roomViewKey),spanX=Math.max(.01,b.maxX-b.minX),spanY=Math.max(.01,b.maxY-b.minY),desired=Math.max(1,Number(section?.pixelsPerWorldUnit)||Number(cache.meta.image?.pixelsPerWorldUnit)||1);
    const ppu=Math.max(.1,Math.min(desired,8192/spanX,8192/spanY,Math.sqrt(16000000/(spanX*spanY))));
    const width=Math.max(1,Math.ceil(spanX*ppu)),height=Math.max(1,Math.ceil(spanY*ppu)),raster=document.createElement('canvas');raster.width=width;raster.height=height;
    const rasterContext=raster.getContext('2d');if(!rasterContext)throw new Error('The browser could not allocate a room state image.');
    rasterContext.imageSmoothingEnabled=true;rasterContext.imageSmoothingQuality='high';cache.pixelsPerWorldUnit=ppu;
    const frame={view:b,x:0,y:0,drawWidth:width,drawHeight:height,scale:1,sourcePpuX:ppu,sourcePpuY:ppu,
      worldPoint:(x,y)=>({x:(x-b.minX)*ppu,y:(b.maxY-y)*ppu})};
    const items=orderedConditionalRenderables(cache.scene);let index=0;
    await new Promise((resolve,reject)=>{
      const drawBatch=()=>{
        if(state.conditionalCache!==cache){resolve();return;}
        try{const end=Math.min(items.length,index+30);for(;index<end;index++){const item=items[index];
          if(item.type==='sprite')drawConditionalSprite(item.object,item.artwork,frame,rasterContext);
          else drawConditionalMesh(item.object,item.artwork,cache.scene.meshAssets,frame,rasterContext);
        }
          if(index<items.length)requestAnimationFrame(drawBatch);else resolve();
        }catch(error){reject(error);}
      };
      requestAnimationFrame(drawBatch);
    });
    if(state.conditionalCache!==cache)return;
    cache.raster=raster;
  }catch(error){if(state.conditionalCache===cache){cache.error=error?.message||String(error);console.warn('Could not build conditional room composite:',error);}}
  finally{
    cache.building=false;
    if(state.conditionalCache===cache){updateRoomViewDisplay();draw();}
  }
}

function conditionalArtworkBounds(meta,scene){
  const base=meta?.image?.bounds;if(!base)return null;
  const bounds={minX:Infinity,minY:Infinity,maxX:-Infinity,maxY:-Infinity};
  const include=(x,y)=>{if(Number.isFinite(x)&&Number.isFinite(y)){bounds.minX=Math.min(bounds.minX,x);bounds.maxX=Math.max(bounds.maxX,x);bounds.minY=Math.min(bounds.minY,y);bounds.maxY=Math.max(bounds.maxY,y);}};
  const renderables=scene?.renderables||[];
  for(const item of renderables){
    const point=item.object.worldPosition||{x:0,y:0},artwork=item.artwork;
    if(item.type==='sprite'){
      const geometry=spriteGeometry(artwork),m00=Number.isFinite(artwork.worldM00)?artwork.worldM00:1,m01=Number.isFinite(artwork.worldM01)?artwork.worldM01:0;
      const m10=Number.isFinite(artwork.worldM10)?artwork.worldM10:0,m11=Number.isFinite(artwork.worldM11)?artwork.worldM11:1;
      for(const [x,y] of [[geometry.left,geometry.bottom],[geometry.left,geometry.bottom+geometry.height],[geometry.left+geometry.width,geometry.bottom],[geometry.left+geometry.width,geometry.bottom+geometry.height]])
        include(point.x+m00*x+m01*y,point.y+m10*x+m11*y);
    }else{
      const asset=scene.meshAssets.get(artwork.meshAssetId),matrix={m00:artwork.worldM00??1,m01:artwork.worldM01??0,m10:artwork.worldM10??0,m11:artwork.worldM11??1};
      for(const vertex of asset?.vertices||[])include(point.x+matrix.m00*vertex.x+matrix.m01*vertex.y,point.y+matrix.m10*vertex.x+matrix.m11*vertex.y);
    }
  }
  if(!Number.isFinite(bounds.minX)||!Number.isFinite(bounds.minY)||!Number.isFinite(bounds.maxX)||!Number.isFinite(bounds.maxY))return base;
  return bounds;
}

function drawConditionalSprite(object,sprite,frame,target=ctx){
  const image=mapSpriteImage(sprite.textureSha256,false);if(!image.complete||!image.naturalWidth)return;
  const ppu=Math.max(1,Number(sprite.pixelsPerUnit)||100),rotated=Number(sprite.packingRotation)===4;
  const width=(rotated?sprite.rectHeight:sprite.rectWidth)/ppu,height=(rotated?sprite.rectWidth:sprite.rectHeight)/ppu;
  const originalWidth=(sprite.originalWidth||sprite.rectWidth)/ppu,originalHeight=(sprite.originalHeight||sprite.rectHeight)/ppu;
  const left=(sprite.trimOffsetX||0)/ppu-(Number(sprite.pivotX??.5)*originalWidth),bottom=(sprite.trimOffsetY||0)/ppu-(Number(sprite.pivotY??.5)*originalHeight);
  const point=object.worldPosition||{x:0,y:0},position=frame.worldPoint(point.x,point.y);
  const m00=Number.isFinite(sprite.worldM00)?sprite.worldM00:1,m01=Number.isFinite(sprite.worldM01)?sprite.worldM01:0;
  const m10=Number.isFinite(sprite.worldM10)?sprite.worldM10:0,m11=Number.isFinite(sprite.worldM11)?sprite.worldM11:1;
  const scaleX=frame.sourcePpuX*frame.scale,scaleY=frame.sourcePpuY*frame.scale;
  const tintR=Math.max(0,Math.min(1,Number(sprite.tintR??1)*Number(sprite.materialTintR??1)));
  const tintG=Math.max(0,Math.min(1,Number(sprite.tintG??1)*Number(sprite.materialTintG??1)));
  const tintB=Math.max(0,Math.min(1,Number(sprite.tintB??1)*Number(sprite.materialTintB??1)));
  const tintA=Math.max(0,Math.min(1,(Number(sprite.tintA??1))*(Number(sprite.materialTintA??1))));
  target.save();target.globalAlpha=tintA;target.globalCompositeOperation=roomCanvasBlend(sprite.blendMode);
  target.filter=`brightness(${(tintR+tintG+tintB)/3})`;target.translate(position.x,position.y);
  target.transform(m00*scaleX,-m10*scaleY,m01*scaleX,-m11*scaleY,0,0);
  target.scale(sprite.flipX?-1:1,sprite.flipY?-1:1);target.translate(left+width/2,bottom+height/2);
  const vertices=sprite.meshVertices||[],indices=sprite.meshIndices||[];
  if(vertices.length>=3&&indices.length>=3){target.beginPath();for(let i=0;i+2<indices.length;i+=3){
    const a=vertices[indices[i]],b=vertices[indices[i+1]],c=vertices[indices[i+2]];if(!a||!b||!c)continue;
    const px=v=>v.x-(left+width/2),py=v=>v.y-(bottom+height/2);target.moveTo(px(a),py(a));target.lineTo(px(b),py(b));target.lineTo(px(c),py(c));target.closePath();}target.clip();}
  target.scale(1,-1);if(Number(sprite.packingRotation)===1)target.scale(-1,1);else if(Number(sprite.packingRotation)===2)target.scale(1,-1);
  else if(Number(sprite.packingRotation)===3)target.rotate(Math.PI);else if(rotated)target.rotate(-Math.PI/2);
  const sourceWidth=rotated?height:width,sourceHeight=rotated?width:height,sourceY=Number(sprite.textureHeight)-Number(sprite.rectY)-Number(sprite.rectHeight);
  target.drawImage(image,Number(sprite.rectX),sourceY,Number(sprite.rectWidth),Number(sprite.rectHeight),-sourceWidth/2,-sourceHeight/2,sourceWidth,sourceHeight);
  target.restore();
}

function drawConditionalMesh(object,mesh,meshAssets,frame,target=ctx){
  const asset=meshAssets.get(mesh.meshAssetId),submesh=asset?.submeshes?.[mesh.submeshIndex];
  const image=mapSpriteImage(mesh.textureSha256,false);if(!asset||!submesh||submesh.topology!==0||!image.complete||!image.naturalWidth)return;
  const vertices=asset.vertices||[],indices=submesh.indices||[],point=object.worldPosition||{x:0,y:0};
  const matrix={m00:mesh.worldM00??1,m01:mesh.worldM01??0,m10:mesh.worldM10??0,m11:mesh.worldM11??1};
  const textureWidth=mesh.textureWidth||image.naturalWidth,textureHeight=mesh.textureHeight||image.naturalHeight,transformed=new Array(vertices.length);
  const vertexAt=index=>{const vertex=vertices[index];if(!vertex)return null;if(!transformed[index]){
    const worldX=point.x+matrix.m00*vertex.x+matrix.m01*vertex.y,worldY=point.y+matrix.m10*vertex.x+matrix.m11*vertex.y,screen=frame.worldPoint(worldX,worldY);
    transformed[index]={x:screen.x,y:screen.y,u:(vertex.u*mesh.textureScaleX+mesh.textureOffsetX)*textureWidth,
      v:textureHeight-(vertex.v*mesh.textureScaleY+mesh.textureOffsetY)*textureHeight,r:vertex.r??1,g:vertex.g??1,b:vertex.b??1,a:vertex.a??1};}
    return transformed[index];};
  for(let i=0;i+2<indices.length;i+=3){
    const a=vertexAt(indices[i]),b=vertexAt(indices[i+1]),c=vertexAt(indices[i+2]);if(!a||!b||!c)continue;
    const determinant=(b.u-a.u)*(c.v-a.v)-(c.u-a.u)*(b.v-a.v),screenArea=(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);
    if(Math.abs(determinant)<1e-6||Math.abs(screenArea)<1e-6)continue;
    const sx1=b.u-a.u,sy1=b.v-a.v,sx2=c.u-a.u,sy2=c.v-a.v,dx1=b.x-a.x,dy1=b.y-a.y,dx2=c.x-a.x,dy2=c.y-a.y;
    const aa=(dx1*sy2-dx2*sy1)/determinant,cc=(sx1*dx2-sx2*dx1)/determinant,bb=(dy1*sy2-dy2*sy1)/determinant,dd=(sx1*dy2-sx2*dy1)/determinant;
    const ee=a.x-aa*a.u-cc*a.v,ff=a.y-bb*a.u-dd*a.v,tintR=mesh.tintR??1,tintG=mesh.tintG??1,tintB=mesh.tintB??1;
    const brightness=Math.max(0,Math.min(2,((a.r+b.r+c.r)/3*tintR+(a.g+b.g+c.g)/3*tintG+(a.b+b.b+c.b)/3*tintB)/3));
    target.save();target.globalCompositeOperation=roomCanvasBlend(mesh.blendMode);target.beginPath();target.moveTo(a.x,a.y);target.lineTo(b.x,b.y);target.lineTo(c.x,c.y);target.closePath();target.clip();
    target.globalAlpha=Math.max(0,Math.min(1,(mesh.tintA??1)*(a.a+b.a+c.a)/3));target.filter=`brightness(${brightness})`;target.transform(aa,bb,cc,dd,ee,ff);
    target.drawImage(image,0,0,textureWidth,textureHeight);target.restore();
  }
}

function drawArchitect(width,height,frame,meta){
  const architect=meta.architect;if(!architect)return;
  if($('toggleGauntlets').checked){
    for(const marker of architect.markers||[]){const point=marker.worldPosition;if(!point)continue;const screen=frame.worldPoint(point.x,point.y),px=screen.x,py=screen.y;if(px<frame.x||px>frame.x+frame.drawWidth||py<frame.y||py>frame.y+frame.drawHeight)continue;ctx.save();ctx.translate(px,py);ctx.rotate(Math.PI/4);ctx.fillStyle=state.selectedGauntlet===marker?'#eadcff':'#c2a0ef';ctx.strokeStyle='#211829';ctx.lineWidth=2;ctx.fillRect(-7,-7,14,14);ctx.strokeRect(-7,-7,14,14);ctx.rotate(-Math.PI/4);ctx.fillStyle='#22172d';ctx.font='bold 8px Consolas,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('G',0,0);ctx.restore();}
    if(state.selectedGauntlet&&$('toggleArenaChanges').checked){
      const active=placementsForWave().filter(record=>isPlacementEnabled(record));
      for(const record of active){const point=record.worldPosition;if(!point)continue;const screen=frame.worldPoint(point.x,point.y),px=screen.x,py=screen.y;if(px<frame.x||px>frame.x+frame.drawWidth||py<frame.y||py>frame.y+frame.drawHeight)continue;
        if(record.enemyCandidate&&$('toggleEnemyTextures').checked){drawEnemyTexture(record,px,py,frame.scale,frame.sourcePpuX,ctx);}
        ctx.save();ctx.fillStyle=record.enemyCandidate?'#e69b35':'#8060a9';ctx.strokeStyle='#1b171f';ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(px,py,4,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.restore();
      }
      for(const cell of architect.tileCells||[]){if(!Number.isFinite(cell.x)||!Number.isFinite(cell.y))continue;const point=frame.worldPoint(cell.x,cell.y),size=frame.sourcePpuX*frame.scale;if(point.x+size<frame.x||point.x>frame.x+frame.drawWidth||point.y+size<frame.y||point.y>frame.y+frame.drawHeight)continue;ctx.save();ctx.strokeStyle='#c2a0ef80';ctx.lineWidth=1;ctx.strokeRect(point.x,point.y,size,size);ctx.restore();}
    }
  }
}
function spriteGeometry(sprite){const ppu=Math.max(1,Number(sprite.pixelsPerUnit)||100),rotated=Number(sprite.packingRotation)===4,w=(rotated?sprite.rectHeight:sprite.rectWidth)/ppu,h=(rotated?sprite.rectWidth:sprite.rectHeight)/ppu,ow=(sprite.originalWidth||sprite.rectWidth)/ppu,oh=(sprite.originalHeight||sprite.rectHeight)/ppu;return{width:w,height:h,left:(sprite.trimOffsetX||0)/ppu-(sprite.pivotX??.5)*ow,bottom:(sprite.trimOffsetY||0)/ppu-(sprite.pivotY??.5)*oh,rotated};}
function drawEnemyTexture(record,px,py,roomScale,roomPpu,target){
  const id=String(record.placement?.id||'').replace(/^prefab_/i,'').toLowerCase().replace(/[^a-z0-9]/g,''),art=state.roomMeta?.architect?.enemyArtwork?.[id],sprite=art?.sprite;if(!sprite?.textureSha256)return;
  let image=state.atlasCache.get(sprite.textureSha256);if(!image){image=new Image();image.onload=draw;image.onerror=()=>{};image.src=`${ARTWORK_BASE}${sprite.textureSha256}.${ARTWORK_EXTENSION}`;state.atlasCache.set(sprite.textureSha256,image);}if(!image.complete||!image.naturalWidth)return;
  const geo=spriteGeometry(sprite),parentScale=Number(record.placement?.scale)||1,rotation=Number(record.placement?.rotation)||0,ppu=Number(roomPpu)||Number(state.roomMeta.image.pixelsPerWorldUnit)||1,scale=roomScale*ppu*parentScale,sourceY=sprite.textureHeight-sprite.rectY-sprite.rectHeight;
  target.save();target.translate(px,py);target.rotate(-rotation*Math.PI/180);target.scale(scale,-scale);target.translate(geo.left+geo.width/2,geo.bottom+geo.height/2);
  if(record.placement?.flipped)target.scale(-1,1);if(geo.rotated)target.rotate(-Math.PI/2);
  target.drawImage(image,sprite.rectX,sourceY,sprite.rectWidth,sprite.rectHeight,-geo.width/2,-geo.height/2,geo.width,geo.height);target.restore();
}

function worldAreaAt(point){let best=null;const transform=mapTransform(state.navigation?.maps?.wide?.bounds,...Object.values(canvasSize()),34);for(const area of state.navigation?.areas||[]){if(!area.widePosition)continue;const screen=screenPoint(area.widePosition,transform),distance=Math.hypot(screen.x-point.x,screen.y-point.y);if(distance<=17&&(!best||distance<best.distance))best={area,distance};}return best?.area||null;}
function selectWorldAt(point){const area=worldAreaAt(point);if(area)showArea(area.key);}
function areaRoomAt(point){
  const bounds=state.mapBackdropVisible?allDetailBounds():(visibleAreaDetailBounds(state.area)||state.area?.wideBounds),t=mapTransform(bounds,...Object.values(canvasSize()),34),world=worldAt(point,t);
  const matches=areaMapRooms(state.area,state.showConditionalMapArtwork).map(room=>{const b=room.bounds,inside=world.x>=b.minX&&world.x<=b.maxX&&world.y>=b.minY&&world.y<=b.maxY;return{room,inside,area:(b.maxX-b.minX)*(b.maxY-b.minY),distance:Math.hypot(room.center.x-world.x,room.center.y-world.y)*t.scale};})
    .filter(item=>item.inside||item.distance<17).sort((a,b)=>a.inside===b.inside?(a.inside?a.area-b.area:a.distance-b.distance):a.inside?-1:1);
  return matches[0]?.room||null;
}
function architectRoomAt(point){
  if(!state.showArchitectMapMarkers||!state.area)return null;
  const bounds=state.mapBackdropVisible?allDetailBounds():(visibleAreaDetailBounds(state.area)||state.area.wideBounds),t=mapTransform(bounds,...Object.values(canvasSize()),34);
  return areaMapRooms(state.area,state.showConditionalMapArtwork).filter(room=>room.architect?.markerCount).map(room=>({room,distance:Math.hypot(screenPoint(room.center,t).x-point.x,screenPoint(room.center,t).y-point.y)})).filter(item=>item.distance<=15).sort((a,b)=>a.distance-b.distance)[0]?.room||null;
}
function mapAnchorAt(point){
  if(!state.area)return null;
  const bounds=state.mapBackdropVisible?allDetailBounds():(visibleAreaDetailBounds(state.area)||state.area?.wideBounds),t=mapTransform(bounds,...Object.values(canvasSize()),34);
  return areaMapRooms(state.area,state.showConditionalMapArtwork).filter(room=>room.mapAnchor).map(room=>({room,distance:Math.hypot(screenPoint(room.center,t).x-point.x,screenPoint(room.center,t).y-point.y)})).filter(item=>item.distance<=12).sort((a,b)=>a.distance-b.distance)[0]?.room||null;
}
function selectRoomAt(point){const room=areaRoomAt(point);if(room)openRoom(room.name);}
canvas.addEventListener('wheel',event=>{event.preventDefault();const rect=canvas.getBoundingClientRect();zoomAt({x:event.clientX-rect.left,y:event.clientY-rect.top},event.deltaY);},{passive:false});
canvas.addEventListener('pointerdown',event=>{
  if(event.button!==0||event.isPrimary===false)return;
  state.drag={pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,lastX:event.clientX,lastY:event.clientY,moved:false};
  canvas.setPointerCapture(event.pointerId);canvas.classList.add('is-panning');canvas.style.cursor='grabbing';event.preventDefault();
});
canvas.addEventListener('pointermove',event=>{
  const drag=state.drag;
  if(drag&&drag.pointerId===event.pointerId){
    const distance=Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY),dx=event.clientX-drag.lastX,dy=event.clientY-drag.lastY;
    drag.lastX=event.clientX;drag.lastY=event.clientY;
    if(distance>=3){drag.moved=true;const view=currentViewport();view.offsetX+=dx;view.offsetY+=dy;draw();}
    return;
  }
  const rect=canvas.getBoundingClientRect(),point={x:event.clientX-rect.left,y:event.clientY-rect.top};
  if(state.mode==='world'||state.mode==='all-rooms'){const area=worldAreaAt(point),key=area?.key||null;if(key!==state.hoverAreaKey){state.hoverAreaKey=key;canvas.style.cursor=key?'pointer':'grab';draw();}return;}
  if(state.mode==='area'){const room=areaRoomAt(point),name=room?.name||null;if(name!==state.hoverRoomName){state.hoverRoomName=name;canvas.style.cursor=name?'pointer':'grab';draw();}return;}
  canvas.style.cursor='grab';
});
function endCanvasPan(event){const drag=state.drag;if(!drag||drag.pointerId!==event.pointerId)return;state.drag=null;canvas.classList.remove('is-panning');if(canvas.hasPointerCapture(event.pointerId))canvas.releasePointerCapture(event.pointerId);if(drag.moved){state.suppressClickUntil=performance.now()+250;state.hoverAreaKey=null;state.hoverRoomName=null;draw();}canvas.style.cursor='grab';}
canvas.addEventListener('pointerup',endCanvasPan);canvas.addEventListener('pointercancel',endCanvasPan);
canvas.addEventListener('pointerleave',()=>{if(state.drag)return;let changed=false;if(state.hoverAreaKey){state.hoverAreaKey=null;changed=true;}if(state.hoverRoomName){state.hoverRoomName=null;changed=true;}canvas.style.cursor='grab';if(changed)draw();});
canvas.addEventListener('click',event=>{if(performance.now()<state.suppressClickUntil){state.suppressClickUntil=0;event.preventDefault();return;}const rect=canvas.getBoundingClientRect(),point={x:event.clientX-rect.left,y:event.clientY-rect.top};if(state.mode==='world'||state.mode==='all-rooms')selectWorldAt(point);else if(state.mode==='area'){const architectRoom=architectRoomAt(point),anchorRoom=architectRoom?null:mapAnchorAt(point);if(architectRoom)openRoom(architectRoom.name,{architectMarkerIndex:0});else if(anchorRoom)openRoom(anchorRoom.name);else selectRoomAt(point);}else if($('toggleGauntlets').checked){const image=currentRoomImage(),meta=state.roomMeta;if(!meta)return;const{width,height}=canvasSize(),dynamic=state.showAllInactiveArtwork||state.includeDisabledStateArtwork||state.roomStateOverrides.size>0,cache=dynamic?conditionalCacheFor(meta):null,rebuild=Boolean(dynamic&&cache?.scene.renderables.length),frame=zoomRoomFrame(rebuild?(cache?.raster?conditionalRasterFrame(width,height,meta,cache):conditionalRoomFrame(width,height,meta,cache.scene)):roomFrame(width,height,image,meta));if(!frame)return;let best=null;for(const [i,marker] of (meta.architect?.markers||[]).entries()){if(!marker.worldPosition)continue;const screen=frame.worldPoint(marker.worldPosition.x,marker.worldPosition.y),d=Math.hypot(point.x-screen.x,point.y-screen.y);if(screen.x<frame.x||screen.x>frame.x+frame.drawWidth||screen.y<frame.y||screen.y>frame.y+frame.drawHeight)continue;if(d<15&&(!best||d<best.d))best={i,d};}if(best)selectGauntlet(best.i);}});

function exportJson(value,name){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportCleanPng() {
  const button=$('exportPngButton'),file=state.roomMeta?.image?.file;
  let image=state.roomImage;
  if(!image||!file)return;
  const selectedSection=state.cameraSections.find(section=>section.key===state.roomViewKey);
  const bakedSection=Boolean(selectedSection?.file);
  const suffix=selectedSection?`-${selectedSection.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}`:'';
  const name=`${fileBase(state.room?.name||'room')}${suffix}.png`;
  button.disabled=true;const originalText=button.textContent;button.textContent='Preparing PNG…';
  try {
    if(bakedSection){
      image=state.roomViewImage||await loadImage(selectedSection.file);
      if(!image)throw new Error('The selected camera-section image could not be loaded for export.');
      if(String(selectedSection.file).toLowerCase().endsWith('.png')){
        const anchor=document.createElement('a');anchor.href=mapByFile(selectedSection.file);anchor.download=name;anchor.click();return;
      }
    } else if(!selectedSection&&String(file).toLowerCase().endsWith('.png')) {
      const anchor=document.createElement('a');anchor.href=mapByFile(file);anchor.download=name;anchor.click();return;
    }
    if(!selectedSection&&state.room?.previewImage&&state.room.previewImage!==state.room.image){
      image=await loadImage(file);
      if(!image)throw new Error('The saved full-resolution room image could not be loaded for export.');
    }
    const frame=bakedSection?null:roomFrame(10000,10000,image,state.roomMeta);
    if(!bakedSection&&!frame)throw new Error('The selected room section has no renderable image bounds.');
    const cropLeft=selectedSection&&!bakedSection?Math.floor(frame.sourceX):0,cropTop=selectedSection&&!bakedSection?Math.floor(frame.sourceY):0;
    const cropRight=selectedSection&&!bakedSection?Math.ceil(frame.sourceX+frame.sourceWidth):image.naturalWidth,cropBottom=selectedSection&&!bakedSection?Math.ceil(frame.sourceY+frame.sourceHeight):image.naturalHeight;
    const exportWidth=selectedSection&&!bakedSection?Math.max(1,cropRight-cropLeft):image.naturalWidth;
    const exportHeight=selectedSection&&!bakedSection?Math.max(1,cropBottom-cropTop):image.naturalHeight;
    const exportCanvas=document.createElement('canvas');exportCanvas.width=Math.ceil(exportWidth);exportCanvas.height=Math.ceil(exportHeight);
    const exportContext=exportCanvas.getContext('2d',{alpha:true});
    if(!exportContext)throw new Error('The browser could not allocate a full-size clean image canvas.');
    if(selectedSection)exportContext.drawImage(image,cropLeft,cropTop,exportWidth,exportHeight,0,0,exportWidth,exportHeight);
    else exportContext.drawImage(image,0,0);
    const blob=await new Promise(resolve=>exportCanvas.toBlob(resolve,'image/png'));
    exportCanvas.width=0;exportCanvas.height=0;
    if(!blob)throw new Error('The browser could not finish the full-size PNG. Try a current desktop browser with more available memory.');
    const url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1500);
  } catch(error) {
    $('canvasNotice').textContent=error.message||String(error);$('canvasNotice').hidden=false;
  } finally {button.disabled=false;button.textContent=originalText;}
}
$('search').addEventListener('input',renderNavigation);$('worldButton').addEventListener('click',()=>state.mode==='room'&&!state.area?showAllRooms():showWorld());$('areaButton').addEventListener('click',()=>state.area?showArea(state.area.key):showAllRooms());$('allRoomsButton').addEventListener('click',showAllRooms);$('closeRoomButton').addEventListener('click',()=>state.area?showArea(state.area.key):showAllRooms());
$('toggleNavigatorButton').addEventListener('click',()=>togglePanel('navigator'));$('toggleInspectorButton').addEventListener('click',()=>togglePanel('inspector'));
$('closeNavigatorButton').addEventListener('click',()=>closePanel('navigator'));$('closeInspectorButton').addEventListener('click',()=>closePanel('inspector'));
$('fullscreenButton').addEventListener('click',async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{}});
document.addEventListener('fullscreenchange',()=>{$('fullscreenButton').setAttribute('aria-pressed',String(Boolean(document.fullscreenElement)));$('fullscreenButton').title=document.fullscreenElement?'Exit fullscreen':'Toggle fullscreen';});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){closePanel('navigator');closePanel('inspector');}});
$('fitButton').addEventListener('click',()=>{const view=currentViewport();view.zoom=1;view.offsetX=0;view.offsetY=0;draw();});$('refreshButton').addEventListener('click',loadDataset);
$('toggleMapBackdrop').addEventListener('click',()=>{state.mapBackdropVisible=!state.mapBackdropVisible;state.mapBackdropAuto=false;$('toggleMapBackdrop').textContent=state.mapBackdropVisible?'Hide other regions':'Show all regions';$('toggleMapBackdrop').setAttribute('aria-pressed',String(state.mapBackdropVisible));draw();});
$('toggleMappedMapArtwork').addEventListener('change',event=>{state.showMappedMapArtwork=event.target.checked;draw();});
$('toggleUnmappedMapArtwork').addEventListener('change',event=>{state.showUnmappedMapArtwork=event.target.checked;draw();});
$('toggleConditionalMapArtwork').addEventListener('change',event=>{state.showConditionalMapArtwork=event.target.checked;draw();});
$('toggleArchitectMapMarkers').addEventListener('change',event=>{state.showArchitectMapMarkers=event.target.checked;draw();});
$('exportPngButton').addEventListener('click',exportCleanPng);
for(const id of ['toggleEnemies','toggleSpawns','toggleChecks'])$(id).addEventListener('change',draw);
new ResizeObserver(resizeCanvas).observe(canvas);window.addEventListener('resize',resizeCanvas);
loadDataset().then(resizeCanvas);
// Refresh the lightweight manifest while room renders are still being produced.
setInterval(() => {
  if (!state.manifest?.complete) void loadDataset();
}, 30000);
