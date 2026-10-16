const $ = id => document.getElementById(id);
const HOSTED_MODE = Boolean(window.SILKSONG_ATLAS_HOSTED);
const DATA_BASE = String(window.SILKSONG_ATLAS_DATA_BASE || '/atlas-data/').replace(/\/?$/, '/');
const ARTWORK_BASE = String(window.SILKSONG_ATLAS_ARTWORK_BASE || '/api/artwork/').replace(/\/?$/, '/');
const ARTWORK_EXTENSION = String(window.SILKSONG_ATLAS_ARTWORK_EXTENSION || 'png').replace(/^\./, '');
const GZIP_JSON = Boolean(window.SILKSONG_ATLAS_GZIP_JSON);
const state = { manifest: null, navigation: null, mode: 'world', area: null, room: null, roomMeta: null,
  roomImage: null, roomViewImage: null, wideImage: null, detailImage: null, imageCache: new Map(), atlasCache: new Map(),
  selectedGauntlet: null, selectedWave: 'all', visiblePlacements: new Map(), selectedAreaName: null,
  cameraSections: [], roomViewKey: 'whole' };
const canvas = $('mapCanvas'), ctx = canvas.getContext('2d');

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
    $('datasetCounts').textContent = `${done.toLocaleString()} processed scenes · ${state.navigation.areas?.length || 0} map regions`;
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
    $('navDescription').textContent = 'Choose a region from the game-authored wide map, or browse every scene.';
    $('search').placeholder = 'Find an area or room…';
    const areas = (state.navigation?.areas || []).filter(area => !query || area.name.toLowerCase().includes(query) || area.key.toLowerCase().includes(query));
    const areaRows = areas.map((area,index) => `<button class="nav-row ${state.area?.key===area.key?'active':''}" data-area="${esc(area.key)}"><span class="nav-index">${String(index+1).padStart(2,'0')}</span><span class="nav-copy"><span class="nav-name">${esc(area.name)}</span><span class="nav-meta">${area.rooms.length} mapped rooms</span></span><span class="nav-arrow">›</span></button>`).join('');
    const roomMatches = query ? allRooms().filter(room => room.name.toLowerCase().includes(query)).slice(0,80) : [];
    const roomRows = roomMatches.map((room,index) => `<button class="nav-row" data-room="${esc(room.name)}"><span class="nav-index">R${String(index+1).padStart(2,'0')}</span><span class="nav-copy"><span class="nav-name">${esc(fileBase(room.name))}</span><span class="nav-meta">${esc(room.kind || room.status)}${room.image?' · image':''}</span></span><span class="nav-arrow">›</span></button>`).join('');
    $('navList').innerHTML = `${areaRows}${roomRows}` || '<div class="empty">No matching map region or room. Use All rooms to browse every prepared scene.</div>';
    document.querySelectorAll('[data-area]').forEach(button => button.addEventListener('click', () => showArea(button.dataset.area)));
    document.querySelectorAll('[data-room]').forEach(button => button.addEventListener('click', () => openRoom(button.dataset.room)));
  } else if (state.mode === 'all-rooms') {
    $('navDescription').textContent = `${allRooms().length.toLocaleString()} prepared scenes · choose one to view its game artwork.`;
    $('search').placeholder = 'Find a room…';
    const rooms = allRooms().filter(room => !query || room.name.toLowerCase().includes(query));
    $('navList').innerHTML = rooms.map((room,index) => `<button class="nav-row ${state.room?.name===room.name?'active':''}" data-room="${esc(room.name)}"><span class="nav-index">${String(index+1).padStart(2,'0')}</span><span class="nav-copy"><span class="nav-name">${esc(fileBase(room.name))}</span><span class="nav-meta">${esc(room.kind || room.status)}${room.image?' · image':''}</span></span><span class="nav-arrow">›</span></button>`).join('') || '<div class="empty">No rooms match that search.</div>';
    document.querySelectorAll('[data-room]').forEach(button => button.addEventListener('click', () => openRoom(button.dataset.room)));
  } else {
    const area = state.area;
    $('navDescription').textContent = state.mode === 'room' ? `${area?.name || 'Area'} · selected room` : `${area?.rooms.length || 0} mapped rooms · choose one to open its pre-rendered image.`;
    $('search').placeholder = 'Find a room…';
    const mapped = (area?.rooms || []).map(item => ({ ...item, export: findRoom(item.name) })).filter(item => item.export);
    const filtered = mapped.filter(item => !query || item.name.toLowerCase().includes(query));
    $('navList').innerHTML = filtered.map((room,index) => `<button class="nav-row ${state.room?.name===room.name?'active':''}" data-room="${esc(room.name)}"><span class="nav-index">${String(index+1).padStart(2,'0')}</span><span class="nav-copy"><span class="nav-name">${esc(fileBase(room.name))}</span><span class="nav-meta">${room.export.status}${room.export.image?' · image':''}</span></span><span class="nav-arrow">›</span></button>`).join('') || (area?.rooms.length ? '<div class="empty">No preprocessed rooms in this area match the search.</div>' : '<div class="empty">No room markers are recorded for this map region. Use All rooms to browse the prepared scenes.</div>');
    document.querySelectorAll('[data-room]').forEach(button => button.addEventListener('click', () => openRoom(button.dataset.room)));
  }
}

function showWorld() {
  state.mode='world'; state.area=null; state.room=null; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null;
  $('stageKind').textContent='WIDE WORLD MAP'; $('stageTitle').textContent='World regions'; $('viewFoot').textContent='GAME-AUTHORED WIDE MAP · REAL BUNDLE TEXTURES'; $('imageDimensions').textContent='';
  $('exportPngButton').hidden=true;
  $('roomSummary').innerHTML='<div class="empty">Select a region from the world map or list.</div>';
  $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true; $('closeRoomButton').hidden=true;
  renderNavigation(); draw();
}
function showAllRooms() {
  state.mode='all-rooms'; state.area=null; state.room=null; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null;
  $('stageKind').textContent='ALL PREPARED ROOMS'; $('stageTitle').textContent='Browse every scene'; $('viewFoot').textContent='ALL EXPORTED SCENES · GAME ART ONLY'; $('imageDimensions').textContent='';
  $('exportPngButton').hidden=true; $('roomSummary').innerHTML='<div class="empty">Choose any prepared scene, including rooms that are not connected to a map region.</div>';
  $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true; $('closeRoomButton').hidden=true;
  renderNavigation(); draw();
}
function showArea(key) {
  const area = findArea(key); if (!area) return;
  state.mode='area'; state.area=area; state.room=null; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null;
  $('stageKind').textContent='REGION DETAIL'; $('stageTitle').textContent=area.name; $('viewFoot').textContent=`${area.key} · ${area.detailBounds?'ROOM SECTIONS':'WIDE MAP REGION'}`; $('imageDimensions').textContent='';
  $('exportPngButton').hidden=true;
  $('roomSummary').innerHTML=`<div class="summary-name">${esc(area.name)}</div><div class="summary-kind">REGION ${esc(area.key)}</div><div class="summary-stat"><span>Mapped rooms</span><strong>${area.rooms.length}</strong></div><div class="summary-stat"><span>Preprocessed images</span><strong>${area.rooms.filter(room=>findRoom(room.name)?.image).length}</strong></div>`;
  $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true; $('closeRoomButton').hidden=true;
  renderNavigation(); draw();
}

async function openRoom(name) {
  const room = findRoom(name); if (!room) return;
  const mappedArea=(state.navigation?.areas||[]).find(area=>area.rooms.some(item=>item.name.toLowerCase()===room.name.toLowerCase()))||null;
  const areaForRoom=state.area?.rooms?.some(item=>item.name.toLowerCase()===room.name.toLowerCase())?state.area:mappedArea;
  state.area=areaForRoom;
  state.mode='room'; state.room=room; state.roomMeta=null; state.roomImage=null; state.selectedGauntlet=null; state.selectedWave='all'; state.visiblePlacements.clear();
  state.cameraSections=[]; state.roomViewKey='whole';
  $('stageKind').textContent=room.kind?.toUpperCase() || 'ROOM'; $('stageTitle').textContent=fileBase(room.name); $('viewFoot').textContent='CLEAN SILKSONG ROOM IMAGE · OVERLAYS ARE SEPARATE';
  $('canvasLoading').hidden=false; $('canvasNotice').hidden=true; $('closeRoomButton').hidden=false;
  $('exportPngButton').hidden=true;
  $('roomSummary').innerHTML='<div class="empty">Loading the selected room sidecar…</div>';
  $('roomSectionPanel').hidden=true; $('objectLayers').hidden=true; $('architectPanel').hidden=true; $('metadataPanel').hidden=true;
  $('toggleEnemies').checked=false; $('toggleSpawns').checked=false; $('toggleChecks').checked=false;
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
    updateRoomViewDisplay();
    if(!image){$('canvasNotice').textContent=room.status==='exported'?'Room image is not available in the hosted atlas.':'This room has no renderable game artwork.';$('canvasNotice').hidden=false;}
    draw();
  } catch(error) {
    $('canvasLoading').hidden=true; $('canvasNotice').textContent=error.message||String(error); $('canvasNotice').hidden=false;
    $('roomSummary').innerHTML=`<div class="empty">Could not load room metadata: ${esc(error.message||error)}</div>`;
  }
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
  const saved=sections.filter(section=>section.file),source=saved.length?saved:sections;
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
  $('imageDimensions').textContent=roomViewDimensions();
  $('viewFoot').textContent=section?`${section.name.toUpperCase()} · CAMERA-LOCK ROOM SECTION · CLEAN GAME ART`:'WHOLE ROOM SCENE · CLEAN GAME ART';
  $('roomViewHint').textContent=section?section.file?`${section.resolutionLimited?'High-density camera render, capped for browser-safe dimensions':'Native-density camera render'} · ${section.width.toFixed(1)} × ${section.height.toFixed(1)} world units. Other room sections remain available in the menu.`:`Showing the ${section.width.toFixed(1)} × ${section.height.toFixed(1)} world-unit camera area from the whole-room composite.`:`Showing the complete prepared scene across all camera areas.`;
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
function screenPoint(point,transform){return{x:transform.x+point.x*transform.scale,y:transform.y-point.y*transform.scale};}
function worldAt(screen,transform){return{x:(screen.x-transform.x)/transform.scale,y:(transform.y-screen.y)/transform.scale};}
function mapBoundsForMode(){
  if(state.mode==='world'||state.mode==='all-rooms')return state.navigation?.maps?.wide?.bounds;
  if(state.mode==='area')return state.area?.detailBounds||state.area?.wideBounds;
  return null;
}
function draw() {
  if(!ctx)return; const {width,height}=canvasSize(); if(!width||!height)return;
  ctx.clearRect(0,0,width,height);ctx.fillStyle='#080a08';ctx.fillRect(0,0,width,height);
  if(state.mode==='room'){drawRoom(width,height);return;}
  const mapType=state.mode==='area'&&state.area?.detailBounds?'detail':'wide';
  const imageRecord=state.navigation?.maps?.[mapType];
  const image=worldMapImage(mapType);
  const bounds=mapBoundsForMode(); const transform=fitTransform(bounds,width,height,34);
  if(state.mode==='world'||state.mode==='all-rooms')drawWorld(width,height,transform,image,imageRecord);
  else drawArea(width,height,transform,image,imageRecord);
}
function drawWorld(width,height,transform,image,imageRecord) {
  const loaded=image?.complete&&image?.naturalWidth&&imageRecord?.bounds;
  if(loaded){const b=imageRecord.bounds,w=(b.maxX-b.minX)*transform.scale,h=(b.maxY-b.minY)*transform.scale;ctx.drawImage(image,transform.x+b.minX*transform.scale,transform.y-b.maxY*transform.scale,w,h);}
  for(const area of state.navigation?.areas||[]){
    const b=area.wideBounds||{minX:area.widePosition.x-5,maxX:area.widePosition.x+5,minY:area.widePosition.y-4,maxY:area.widePosition.y+4};
    const left=transform.x+b.minX*transform.scale,top=transform.y-b.maxY*transform.scale,w=(b.maxX-b.minX)*transform.scale,h=(b.maxY-b.minY)*transform.scale;
    ctx.save();ctx.fillStyle='rgba(183,220,119,.06)';ctx.strokeStyle='rgba(201,230,153,.35)';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(left,top,Math.max(5,w),Math.max(5,h),4);ctx.fill();ctx.stroke();
    const point=screenPoint(area.widePosition,transform);ctx.fillStyle='#dce8c5';ctx.font='600 11px Georgia,serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.shadowColor='#050705';ctx.shadowBlur=6;ctx.fillText(area.name,point.x,point.y);ctx.shadowBlur=0;ctx.fillStyle='#b3c996';ctx.font='8px Consolas,monospace';ctx.fillText(`${area.rooms.length} ROOMS`,point.x,point.y+15);ctx.restore();
  }
  if(!loaded)drawFallbackNotice(width,height,'Game wide map image is still loading.');
}
function drawArea(width,height,transform,image,imageRecord) {
  const area=state.area;if(!area)return;const loaded=image?.complete&&image?.naturalWidth&&imageRecord?.bounds;
  if(loaded){
    const source=imageRecord.bounds,view=area.detailBounds||area.wideBounds,ppu=imageRecord.pixelsPerWorldUnit;
    const sx=2+(view.minX-source.minX)*ppu,sy=2+(source.maxY-view.maxY)*ppu,sw=(view.maxX-view.minX)*ppu,sh=(view.maxY-view.minY)*ppu;
    const dstW=(view.maxX-view.minX)*transform.scale,dstH=(view.maxY-view.minY)*transform.scale;
    ctx.drawImage(image,Math.max(0,sx),Math.max(0,sy),Math.min(image.naturalWidth-Math.max(0,sx),sw),Math.min(image.naturalHeight-Math.max(0,sy),sh),transform.x+view.minX*transform.scale,transform.y-view.maxY*transform.scale,dstW,dstH);
  }
  area.rooms.forEach(room=>{
    if(!findRoom(room.name))return;const b=room.bounds,left=transform.x+b.minX*transform.scale,top=transform.y-b.maxY*transform.scale,rawW=(b.maxX-b.minX)*transform.scale,rawH=(b.maxY-b.minY)*transform.scale,w=Math.max(5,rawW),h=Math.max(5,rawH);
    ctx.save();ctx.fillStyle='rgba(111,174,188,.10)';ctx.strokeStyle='rgba(130,199,207,.67)';ctx.lineWidth=1;ctx.beginPath();ctx.roundRect(left,top,w,h,3);ctx.fill();ctx.stroke();
    const p=screenPoint(room.center,transform),label=fileBase(room.name),fontSize=Math.max(7,Math.min(10,transform.scale*.18));ctx.fillStyle='#d3e6df';ctx.textAlign='center';ctx.textBaseline='middle';ctx.font=`${fontSize}px Consolas,monospace`;ctx.shadowColor='#050706';ctx.shadowBlur=4;if(rawW>=Math.max(36,label.length*fontSize*.62+8)&&rawH>=14)ctx.fillText(label,p.x,p.y);ctx.restore();
  });
  if(!loaded)drawFallbackNotice(width,height,'Game detailed map image is still loading.');
}
function drawFallbackNotice(width,height,text){ctx.fillStyle='#aab09f';ctx.font='11px Consolas,monospace';ctx.textAlign='center';ctx.fillText(text,width/2,height/2);}
function drawRoom(width,height){
  const image=currentRoomImage(),meta=state.roomMeta;if(!image||!meta?.image)return;
  const frame=roomFrame(width,height,image,meta);if(!frame)return;
  ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,frame.sourceX,frame.sourceY,frame.sourceWidth,frame.sourceHeight,frame.x,frame.y,frame.drawWidth,frame.drawHeight);
  const visible=[];
  for(const object of meta.objects||[]){const point=object.worldPosition;if(!point)continue;const classification=object.classification||{};
    if(classification.enemy&&$('toggleEnemies').checked)visible.push({object,point,color:'#e69b35',kind:'E'});
    if(classification.spawn&&$('toggleSpawns').checked)visible.push({object,point,color:'#79b9d4',kind:'S'});
    if(classification.check&&$('toggleChecks').checked)visible.push({object,point,color:'#77c7aa',kind:'C'});
  }
  for(const item of visible){const point=frame.worldPoint(item.point.x,item.point.y),px=point.x,py=point.y;if(px<frame.x||px>frame.x+frame.drawWidth||py<frame.y||py>frame.y+frame.drawHeight)continue;ctx.save();ctx.fillStyle=item.color;ctx.strokeStyle='#0b0d0b';ctx.lineWidth=2;ctx.beginPath();ctx.arc(px,py,5,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#0b0d0b';ctx.font='bold 6px Consolas,monospace';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(item.kind,px,py+.2);ctx.restore();}
  drawArchitect(width,height,frame,meta);
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

function selectWorldAt(point){const bounds=state.navigation?.maps?.wide?.bounds,t=fitTransform(bounds,...Object.values(canvasSize()),34),world=worldAt(point,t);const matches=(state.navigation?.areas||[]).map(area=>{const b=area.wideBounds;const inside=b&&world.x>=b.minX&&world.x<=b.maxX&&world.y>=b.minY&&world.y<=b.maxY;return{area,inside,distance:Math.hypot(area.widePosition.x-world.x,area.widePosition.y-world.y)};}).filter(item=>item.inside||item.distance*t.scale<22).sort((a,b)=>(a.inside===b.inside?a.distance-b.distance:a.inside?-1:1));if(matches[0])showArea(matches[0].area.key);}
function selectRoomAt(point){const bounds=state.area?.detailBounds||state.area?.wideBounds,t=fitTransform(bounds,...Object.values(canvasSize()),34),world=worldAt(point,t);const matches=(state.area?.rooms||[]).map(room=>{const b=room.bounds;const inside=world.x>=b.minX&&world.x<=b.maxX&&world.y>=b.minY&&world.y<=b.maxY;return{room,inside,distance:Math.hypot(room.center.x-world.x,room.center.y-world.y)*t.scale};}).filter(item=>findRoom(item.room.name)&&(item.inside||item.distance<13)).sort((a,b)=>(a.inside===b.inside?a.distance-b.distance:a.inside?-1:1));if(matches[0])openRoom(matches[0].room.name);}
canvas.addEventListener('click',event=>{const rect=canvas.getBoundingClientRect(),point={x:event.clientX-rect.left,y:event.clientY-rect.top};if(state.mode==='world'||state.mode==='all-rooms')selectWorldAt(point);else if(state.mode==='area')selectRoomAt(point);else if($('toggleGauntlets').checked){const image=currentRoomImage(),meta=state.roomMeta;if(!image||!meta)return;const{width,height}=canvasSize(),frame=roomFrame(width,height,image,meta);if(!frame)return;let best=null;for(const [i,marker] of (meta.architect?.markers||[]).entries()){if(!marker.worldPosition)continue;const screen=frame.worldPoint(marker.worldPosition.x,marker.worldPosition.y),d=Math.hypot(point.x-screen.x,point.y-screen.y);if(screen.x<frame.x||screen.x>frame.x+frame.drawWidth||screen.y<frame.y||screen.y>frame.y+frame.drawHeight)continue;if(d<15&&(!best||d<best.d))best={i,d};}if(best)selectGauntlet(best.i);}});

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
$('fitButton').addEventListener('click',draw);$('refreshButton').addEventListener('click',loadDataset);
$('exportPngButton').addEventListener('click',exportCleanPng);
for(const id of ['toggleEnemies','toggleSpawns','toggleChecks'])$(id).addEventListener('change',draw);
new ResizeObserver(resizeCanvas).observe(canvas);window.addEventListener('resize',resizeCanvas);
loadDataset().then(resizeCanvas);
// Refresh the lightweight manifest while room renders are still being produced.
setInterval(() => {
  if (!state.manifest?.complete) void loadDataset();
}, 30000);
