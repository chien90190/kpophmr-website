// Interactive 3D views over part of a video. Every element with data-viewer3d gets one: data-viewer3d is the data
// folder, data-viewer3d-at where the panel sits (a class on .world3d), data-vid the clip to show; the element fires
// "clip" when data-vid changes. The clip's video is the clock: each frame shows the meshes for its current time, so
// playback, pausing and seeking carry over. Without the 3D (VIEWER_3D false, no WebGL, file://) the video's own view
// shows. The badge and a loading chip show at once, over the video, until the clip's data is in; the data is fetched
// once the clip's video shows a frame (videoFirst), so the two do not compete for the connection. On a phone the 3D
// is its own panel under the player instead, opened by a button, and its data is fetched only then; it renders
// lighter there (no antialiasing, smaller and harder shadows, at most 1.5x pixels) to spare the phone's GPU. If the
// GPU drops the context, the panel shows a message and a restart.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const FACES_GLYPH = [[0, 1, 2], [0, 2, 3], [0, 3, 4], [0, 4, 1], [1, 3, 2], [1, 4, 3]];
const AMBIENT = 1.6, SUN = 1.9;  // matched to the rendered clips
// the zoom part is hidden on a narrow panel
const DRAG_HINT = 'Drag to rotate<span class="w3d-more">, scroll to zoom</span>';
const PHONE = matchMedia("(max-width: 768px)").matches;
const CUBE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5 20.5 7v10L12 21.5 3.5 17V7z"/><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10"/></svg>';

// Resolves once a video of clip `id` in host shows a frame, or fails to load: a clip's video loads before its 3D data.
function videoFirst(host, id) {
  const ready = () => [...host.querySelectorAll("video")].some(v => v.src.includes(id) && v.readyState >= 2);
  if (ready()) return Promise.resolve();
  return new Promise(res => {
    const check = e => {
      if (e.type === "error" ? !e.target.src?.includes(id) : !ready()) return;
      host.removeEventListener("loadeddata", check, true);
      host.removeEventListener("error", check, true);
      res();
    };
    host.addEventListener("loadeddata", check, true);  // media events do not bubble, so listen in the capture phase
    host.addEventListener("error", check, true);
  });
}

// The response body as an ArrayBuffer, calling onProgress(fraction) as it arrives (never without a length).
async function download(r, onProgress) {
  const total = +r.headers.get("Content-Length");
  if (!total || !r.body) return r.arrayBuffer();
  const reader = r.body.getReader(), parts = [];
  let got = 0;
  for (; ;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(Math.min(got / total, 1));
  }
  return new Blob(parts).arrayBuffer();
}

// The 3D panel for one data-viewer3d element, over the player, or on a phone after the element `below`; returns
// the panel, or false without WebGL. restart() is called after the panel is torn down from its "Restart 3D" button.
function mountViewer(host, below, restart) {
  const dir = host.dataset.viewer3d;
  let renderer;
  // without antialiasing as a second try: it needs less GPU memory
  for (const antialias of PHONE ? [false] : [true, false]) {
    try {
      renderer = new THREE.WebGLRenderer({ antialias });
      break;
    } catch (e) {
      console.warn("3D view: no WebGL context", e);
    }
  }
  if (!renderer) return false;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PHONE ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  const off = new AbortController();  // removes this panel's listeners on the player when it is torn down

  const wrap = document.createElement("div");
  wrap.className = `world3d ${host.dataset.viewer3dAt}${below ? " phone" : ""}`;
  renderer.domElement.classList.add("fill");
  wrap.append(renderer.domElement);
  const hint = document.createElement("button");
  hint.type = "button";
  hint.className = "w3d-hint loading";
  wrap.append(hint);
  // marks the panel as interactive
  const badge = document.createElement("div");
  badge.className = "w3d-badge";
  badge.innerHTML = `${CUBE}Interactive 3D`;
  wrap.append(badge);
  below ? below.after(wrap) : host.append(wrap);
  // presses here orbit; they do not reach the player around it
  wrap.addEventListener("pointerdown", e => e.stopPropagation());
  // zoom: the wheel or a pinch over the panel, or the + / - buttons
  const zoom = document.createElement("div");
  zoom.className = "w3d-zoom";
  zoom.innerHTML = '<button type="button" aria-label="Zoom in">+</button><button type="button" aria-label="Zoom out">&minus;</button>';
  wrap.append(zoom);
  // a lost context (e.g. a GPU reset): three keeps the scene and redraws it if the browser restores the context;
  // until then the video's own view shows, under a message and a restart
  const lost = document.createElement("div");
  lost.className = "w3d-lost";
  lost.innerHTML = '<p>The browser stopped the 3D view.</p><button type="button">Restart 3D</button>';
  wrap.append(lost);
  renderer.domElement.addEventListener("webglcontextlost", () => wrap.classList.add("lost"));
  renderer.domElement.addEventListener("webglcontextrestored", () => { wrap.classList.remove("lost"); shown = -1; });
  lost.querySelector("button").addEventListener("click", () => {
    off.abort();
    wrap.remove();
    scene = clip = null;
    cache.clear();
    renderer.dispose();
    restart();
  });

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = false;
  controls.maxPolarAngle = Math.PI / 2 - 0.08;  // stay above the floor
  controls.zoomSpeed = 3;
  let scene = null, clip = null, home = null, moved = false, shown = -1, want = null, visible = false;
  const cache = new Map(), progress = new Map();  // clip id -> its data; the part of its mesh file downloaded

  // the loading chip: the share of the wanted clip downloaded, as text and as the chip's fill
  const paint = () => {
    if (!hint.classList.contains("loading")) return;
    const p = Math.round((progress.get(want ?? host.dataset.vid) ?? 0) * 100);
    hint.style.setProperty("--p", `${p}%`);
    hint.textContent = p ? `Loading 3D \u00b7 ${p}%` : "Loading 3D";
  };
  paint();

  const render = () => scene && renderer.render(scene, camera);
  controls.addEventListener("change", () => {
    if (!moved) { moved = true; hint.textContent = "Reset view"; hint.classList.add("reset"); }
    render();
  });
  const dolly = k => {
    const off = camera.position.clone().sub(controls.target);
    off.setLength(Math.min(controls.maxDistance, Math.max(controls.minDistance, off.length() * k)));
    camera.position.copy(controls.target).add(off);
    controls.update();
  };
  zoom.children[0].addEventListener("click", () => dolly(0.8));
  zoom.children[1].addEventListener("click", () => dolly(1.25));
  hint.addEventListener("click", () => {
    if (!home) return;
    camera.position.copy(home.position);
    camera.quaternion.copy(home.quaternion);
    controls.target.copy(home.target);
    controls.update();
    moved = false;
    hint.innerHTML = DRAG_HINT;
    hint.classList.remove("reset");
    render();
  });

  fitCanvas(renderer.domElement, (w, h, ratio) => {
    renderer.setPixelRatio(PHONE ? Math.min(ratio, 1.5) : ratio);
    renderer.setSize(w, h, false);  // false: CSS sizes the canvas
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    render();
  });

  async function fetchClip(id) {
    if (cache.has(id)) return cache.get(id);
    const p = (async () => {
      const base = `${dir}/${id}`;
      const [meta, raw] = await Promise.all([
        fetch(`${base}.json`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
        fetch(`${base}.bin.gz`).then(r => {
          if (!r.ok) throw new Error(r.status);
          return download(r, f => { progress.set(id, f); paint(); });
        }),
      ]);
      const head = new Uint8Array(raw, 0, 2);  // gzip, unless the server already decompressed it
      const buf = head[0] === 0x1f && head[1] === 0x8b
        ? await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer() : raw;
      return { meta, buf };
    })();
    cache.set(id, p);
    p.catch(() => cache.delete(id));
    return p;
  }

  async function show(id) {
    if (id === want || !wrap.isConnected) return;  // already shown or on its way, or torn down
    want = id;
    wrap.classList.remove("ready", "off");
    hint.classList.remove("reset");
    hint.classList.add("loading");
    paint();
    let data;
    try {
      if (!cache.has(id)) await videoFirst(host, id);
      if (want !== id) return;  // another clip was picked meanwhile
      data = await fetchClip(id);
    } catch (e) {
      if (want === id) { want = null; wrap.classList.add("off"); }  // no data for this clip: the video's own view stays
      return;
    }
    if (want !== id || !wrap.isConnected) return;  // another clip was picked meanwhile, or torn down
    if (below) for (const k of cache.keys()) if (k !== id) cache.delete(k);  // a phone keeps one clip's data
    const built = buildScene(data);
    if (scene) scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    scene = built.sc;
    clip = built;
    home = built.view;
    camera.fov = built.view.fov;
    const dist = built.view.position.distanceTo(built.view.target);
    camera.near = dist * 0.02;
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.minDistance = dist * 0.15;
    controls.maxDistance = dist * 3;
    hint.classList.remove("loading");
    hint.click();  // the home view
    shown = -1;
    wrap.classList.add("ready");
    // the first time, the hint flashes so the change from video to 3D is seen
    if (!wrap.classList.contains("seen")) wrap.classList.add("seen", "flash");
  }
  hint.addEventListener("animationend", () => wrap.classList.remove("flash"));

  whileInView(below ? wrap : host, inView => { visible = inView; });
  const tick = () => {
    if (!wrap.isConnected) return;  // torn down
    requestAnimationFrame(tick);
    if (!clip || !visible) return;
    const v = [...host.querySelectorAll("video")].find(x => x.currentSrc.includes(clip.meta.vid));
    if (!v) return;
    const f = Math.min(clip.meta.frames - 1, Math.max(0, Math.floor(v.currentTime * clip.meta.fps + 1e-3)));
    if (f === shown) return;
    shown = f;
    clip.setFrame(f);
    render();
  };
  requestAnimationFrame(tick);

  if (below) {
    // a phone: the open panel follows the player's clip; nothing is fetched ahead
    host.addEventListener("clip", () => !wrap.hidden && show(host.dataset.vid), { signal: off.signal });
    wrap.open = () => show(host.dataset.vid);
    return wrap;
  }
  host.addEventListener("clip", () => show(host.dataset.vid), { signal: off.signal });
  // "prefetch" (detail: a clip id) fetches a clip's data without showing it, e.g. on hovering its thumbnail
  host.addEventListener("prefetch", e => fetchClip(e.detail).catch(() => { }), { signal: off.signal });
  // the opening clip (data-vid) is fetched and shown once the player comes near the viewport and its video is in
  onceInView(host, () => host.dataset.vid && show(host.dataset.vid), "600px 0px");
  return wrap;
}

// On a phone: a button under the player opens and closes the 3D panel, made on the first press.
function phoneButton(host) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "w3d-open";
  const label = open => { btn.innerHTML = `${CUBE}${open ? "Hide the 3D view" : "Explore this clip in 3D"}`; };
  label(false);
  host.after(btn);
  let wrap = null;
  // a restart makes a new panel and opens it
  const toggle = open => {
    wrap ||= mountViewer(host, btn, () => { wrap = null; toggle(true); });
    if (!wrap) {  // no WebGL context: the button says so, and another press tries again
      btn.innerHTML = `${CUBE}This browser could not start the 3D view. Tap to retry`;
      btn.classList.add("failed");
      btn.setAttribute("aria-expanded", false);
      return;
    }
    btn.classList.remove("failed");
    wrap.hidden = !open;
    btn.setAttribute("aria-expanded", open);
    label(open);
    if (open) wrap.open();
  };
  btn.addEventListener("click", () => toggle(btn.getAttribute("aria-expanded") !== "true"));
}

// On a larger screen: the panel over the player; a restart mounts a new one.
const desktopViewer = host => mountViewer(host, null, () => desktopViewer(host));

// Area-weighted vertex normals of an indexed geometry: the sum of the cross products of its faces' edges at each
// vertex, normalized, exactly as three's computeVertexNormals, but on the typed arrays (it makes a Vector3 per corner,
// which took most of the page's CPU at 24 frames a second for every body).
function vertexNormals(g) {
  const p = g.attributes.position.array, idx = g.index.array;
  let attr = g.attributes.normal;
  if (!attr) g.setAttribute("normal", attr = new THREE.BufferAttribute(new Float32Array(p.length), 3));
  const n = attr.array;
  n.fill(0);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[c] - p[b], uy = p[c + 1] - p[b + 1], uz = p[c + 2] - p[b + 2];
    const vx = p[a] - p[b], vy = p[a + 1] - p[b + 1], vz = p[a + 2] - p[b + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    n[a] += x; n[a + 1] += y; n[a + 2] += z;
    n[b] += x; n[b + 1] += y; n[b + 2] += z;
    n[c] += x; n[c + 1] += y; n[c + 2] += z;
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.sqrt(n[i] * n[i] + n[i + 1] * n[i + 1] + n[i + 2] * n[i + 2]) || 1;
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l;
  }
  attr.needsUpdate = true;
}

function buildScene({ meta, buf }) {
  const V = meta.verts, F = meta.faces, s = meta.style;
  const faces = new Uint16Array(buf, 0, F * 3);
  const deltas = new Int16Array(buf, F * 6);
  const sc = new THREE.Scene();
  sc.background = new THREE.Color().setRGB(...s.bg);
  const lin = c => new THREE.Color().setRGB(...c.map(x => Math.pow(x, 1.2)));  // as in the renders

  // lights: ambient plus one sun with shadows, as in the renders
  sc.add(new THREE.AmbientLight(0xffffff, AMBIENT));
  const target = new THREE.Vector3(...meta.view.target);
  const sun = new THREE.DirectionalLight(0xffffff, SUN);
  const dir = new THREE.Vector3(...meta.view.light).normalize();
  const reach = meta.floor.half * 2;
  sun.position.copy(target).addScaledVector(dir, -reach);
  sun.target.position.copy(target);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(PHONE ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -meta.floor.half, right: meta.floor.half, top: meta.floor.half,
    bottom: -meta.floor.half, near: 0.1, far: reach * 2 });
  sun.shadow.bias = -0.0005;
  sc.add(sun, sun.target);

  // floor: checkerboard fading into the background
  {
    const { focus, half, tile, y, alpha } = meta.floor, n = Math.ceil(half / tile), bg = s.bg;
    const lit = (AMBIENT + SUN * Math.max(0, -dir.y)) / Math.PI;  // light on the floor, divided out to keep its tones
    const pos = [], col = [], idx = [];
    for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) {
      const x0 = focus[0] + j * tile, z0 = focus[2] + i * tile, b = pos.length / 3, c = s.floor[((i + j) % 2 + 2) % 2];
      for (const [x, z] of [[x0, z0], [x0 + tile, z0], [x0 + tile, z0 + tile], [x0, z0 + tile]]) {
        pos.push(x, y, z);
        const fade = Math.min(1, Math.max(0, (Math.hypot(x - focus[0], z - focus[2]) - 0.45 * half) / (0.5 * half)));
        col.push(...c.map((v, k) => (v * (1 - fade) + bg[k] * fade) / lit));
      }
      idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide,
      transparent: alpha < 1, opacity: alpha }));
    m.receiveShadow = true;
    sc.add(m);
  }

  // bodies: one mesh per track; positions decoded once (int16 deltas along the track -> metres)
  const origin = meta.origin, step = meta.step;
  const bodies = meta.tracks.map(t => {
    const n = t.frames.length, d = deltas.subarray(t.offset, t.offset + n * V * 3);
    const abs = new Float32Array(n * V * 3), acc = new Int32Array(V * 3);
    for (let k = 0; k < n; k++) for (let i = 0; i < V * 3; i++) {
      acc[i] += d[k * V * 3 + i];
      abs[k * V * 3 + i] = origin[i % 3] + acc[i] * step;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    g.setIndex(new THREE.BufferAttribute(faces, 1));
    const mat = new THREE.MeshStandardMaterial({ color: lin(t.color), roughness: 0.65, metalness: 0 });
    if (t.ghost) Object.assign(mat, { transparent: true, opacity: s.ghost_alpha, depthWrite: false });
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    sc.add(mesh);
    const lookup = new Map(t.frames.map((f, k) => [f, k]));
    // floor trail: the last trail_frames root positions as a ribbon fading from the floor colour to the body's
    const trail = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
    trail.frustumCulled = false;
    sc.add(trail);
    return { t, mesh, abs, lookup, trail, width: (t.ghost ? 0.045 : 0.07) * meta.height };
  });

  const setCamera = meta.camera ? cameraParts(sc, meta, lin) : () => { };
  const lift = meta.floor.y + 0.004 * meta.height, floorC = s.floor[0];
  function setFrame(f) {
    for (const b of bodies) {
      const k = b.lookup.get(f);
      b.mesh.visible = k !== undefined;
      if (k !== undefined) {
        const p = b.mesh.geometry.attributes.position;
        p.array.set(b.abs.subarray(k * V * 3, (k + 1) * V * 3));
        p.needsUpdate = true;
        vertexNormals(b.mesh.geometry);
      }
      const pts = [];
      for (let g = Math.max(0, f - s.trail_frames); g <= f; g++) { const kk = b.lookup.get(g); if (kk !== undefined) pts.push(b.t.floor[kk]); }
      b.trail.visible = pts.length > 1;
      if (pts.length > 1) {
        const pos = [], col = [], idx = [], c = b.t.color;
        pts.forEach((q, i) => {
          const a = pts[Math.min(i + 1, pts.length - 1)], z = pts[Math.max(i - 1, 0)];
          let sx = -(a[1] - z[1]), sz = a[0] - z[0];
          const l = Math.hypot(sx, sz) || 1;
          sx = sx / l * b.width / 2; sz = sz / l * b.width / 2;
          if (!(Math.hypot(a[0] - z[0], a[1] - z[1]) > 1e-9)) { sx = b.width / 2; sz = 0; }
          pos.push(q[0] + sx, lift, q[1] + sz, q[0] - sx, lift, q[1] - sz);
          const w = (i + 1) / pts.length, mix = floorC.map((v, k) => v * (1 - w) + c[k] * w);
          col.push(...mix, ...mix);
          if (i) { const j = 2 * (i - 1); idx.push(j, j + 1, j + 3, j, j + 3, j + 2); }
        });
        const g = b.trail.geometry;
        g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
        g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
        g.setIndex(idx);
        g.computeVertexNormals();
      }
    }
    setCamera(f);
  }

  // the starting view
  const pose = new THREE.Matrix4().set(...meta.view.pose.flat());
  const position = new THREE.Vector3(), quaternion = new THREE.Quaternion();
  pose.decompose(position, quaternion, new THREE.Vector3());
  return { sc, setFrame, view: { position, quaternion, target, fov: meta.view.fov }, meta };
}

// The broadcast camera's path, drawn up to the current frame, and its glyph; returns the per-frame update.
function cameraParts(sc, meta, lin) {
  const s = meta.style;
  const pathPts = meta.camera.path.map(p => new THREE.Vector3(...p));
  // one tube segment per frame (TubeGeometry would otherwise space segments by arc length)
  const pathCurve = new THREE.CatmullRomCurve3(pathPts, false, "centripetal");
  pathCurve.getUtoTmapping = u => u;
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(pathCurve, pathPts.length - 1, 0.015 * meta.height, 8, false),
    new THREE.MeshStandardMaterial({ color: lin(s.path), roughness: 0.65, metalness: 0 }));
  tube.castShadow = true;
  sc.add(tube);
  const glyph = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
    color: lin(s.body), roughness: 0.65, metalness: 0, flatShading: true, side: THREE.DoubleSide }));
  glyph.geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(FACES_GLYPH.length * 9), 3));
  glyph.castShadow = true;
  glyph.frustumCulled = false;
  sc.add(glyph);
  return f => {
    tube.geometry.setDrawRange(0, f * 8 * 6);
    const gl = meta.camera.glyph[f], gp = glyph.geometry.attributes.position;
    FACES_GLYPH.forEach((tri, i) => tri.forEach((v, j) => gp.array.set(gl.slice(3 * v, 3 * v + 3), (3 * i + j) * 3)));
    gp.needsUpdate = true;
    glyph.geometry.computeVertexNormals();
  };
}

if (typeof VIEWER_3D !== "undefined" && VIEWER_3D)
  for (const host of document.querySelectorAll("[data-viewer3d]")) {
    if (PHONE) phoneButton(host);
    else if (!desktopViewer(host)) break;
  }
