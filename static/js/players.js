// Video players: the before/after and the comparison. A player with an interactive 3D view keeps its
// current clip id in data-vid and fires a "clip" event when it changes, and "prefetch" (detail: a clip id) for a clip
// it may show next. Clips the reader is likely to pick next are fetched ahead (fetchAhead), and a clip a player moves
// off is kept, so going back to it plays at once.

// ===========================================================================
// Shared parts
// ===========================================================================

// Video elements by path, fetched ahead or put back by a player, handed to the next mount of that path. The
// POOL most recent are kept; an older one is emptied.
const POOL = 8, pool = new Map();
function newVideo(path) {
  const v = document.createElement("video");
  v.muted = true;
  v.playsInline = true;
  v.disablePictureInPicture = true;
  v.preload = "auto";
  v.dataset.path = path;
  v.src = path;
  return v;
}
function takeVideo(path) {
  const v = pool.get(path);
  pool.delete(path);
  return v || newVideo(path);
}
function stash(v) {
  v.pause();
  pool.delete(v.dataset.path);
  pool.set(v.dataset.path, v);
  for (const [path, old] of pool) {
    if (pool.size <= POOL) break;
    pool.delete(path);
    old.removeAttribute("src");
    old.load();
  }
}
// Queue the clip at `path` behind what is on screen (see ahead); `first` puts it at the front. Returns a promise that
// settles once it is in. A clip already in a player is not fetched again, but the queue still waits for it.
function fetchAhead(path, first = false) {
  return ahead.add(() => {
    const shown = document.querySelector(`video[data-path="${path}"]`);
    if (shown?.isConnected) return whenSettled(shown);
    if (!pool.has(path)) stash(newVideo(path));
    return whenSettled(pool.get(path));
  }, first);
}

// A set of videos that play as one: the longest clip is the clock, the rest follow it,
// and the whole group pauses while scrolled out of view. `bar` shows the clock's progress, and its track
// seeks: click or drag along it (playback holds while dragging, then picks up again).
class SyncGroup {
  constructor(section, onState, bar) {
    this.videos = [];
    this.master = null;
    this.playing = true;
    this.visible = false;
    this.rate = 1;
    this.token = 0;
    this.scrubbing = false;
    this.onState = onState || (() => { });
    if (bar) this.scrubber(bar.parentElement);
    whileInView(section, inView => {
      this.visible = inView;
      this.visible && this.playing ? this.run() : this.halt();
    });
    const tick = () => {
      this.follow();
      if (bar) {
        const p = this.master ? this.master.currentTime / this.master.duration : 0;
        bar.style.transform = `scaleX(${p})`;
        bar.parentElement.style.setProperty("--p", p);  // the knob
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  mount(slots, aspect, t0 = 0) {  // slots: [{ fig, path }]; t0: where to start (a tab switch keeps the time)
    const token = ++this.token;
    this.halt();
    this.videos = [];
    this.master = null;
    if (this.off) this.off.abort();  // the listeners of the last mount, whose videos may come back from the pool
    const signal = (this.off = new AbortController()).signal;
    const loads = slots.map(({ fig, path }) => new Promise(res => {
      const v = takeVideo(path);  // fetched ahead or kept from before, else new
      v.style.aspectRatio = `auto ${aspect}`;
      const fail = () => { v.replaceWith(placeholder(path, aspect)); res(null); };
      fig.prepend(v);
      if (v.error) return fail();
      if (v.readyState >= 2) return res(v);
      v.addEventListener("loadeddata", () => res(v), { once: true, signal });
      v.addEventListener("error", fail, { once: true, signal });
    }));
    Promise.all(loads).then(loaded => {
      if (token !== this.token) return;
      this.videos = loaded.filter(Boolean);
      if (!this.videos.length) return;
      this.master = this.videos.reduce((a, b) => (b.duration > a.duration ? b : a));
      this.master.addEventListener("ended", () => { if (this.playing) { this.seek(0); this.run(); } }, { signal });
      for (const v of this.videos) v.playbackRate = this.rate;
      this.seek(t0);
      this.set(this.playing);
    });
  }

  seek(t) { for (const v of this.videos) v.currentTime = Math.min(t, Math.max(0, v.duration - 1e-3)); }
  run() { if (this.visible && !this.scrubbing) for (const v of this.videos) v.play().catch(() => { }); }
  halt() { for (const v of this.videos) v.pause(); }

  scrubber(track) {
    track.classList.add("scrub");
    track.insertAdjacentHTML("beforeend", '<i class="knob"></i>');
    const seekTo = e => {
      if (!this.master) return;
      const r = track.getBoundingClientRect();
      this.seek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * this.master.duration);
    };
    track.addEventListener("pointerdown", e => {
      e.stopPropagation();  // a .cmp player's divider listens on the same area
      track.setPointerCapture(e.pointerId);
      track.classList.add("dragging");
      this.scrubbing = true;
      this.halt();
      seekTo(e);
    });
    track.addEventListener("pointermove", e => { if (track.hasPointerCapture(e.pointerId)) seekTo(e); });
    const end = () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      track.classList.remove("dragging");
      if (this.playing) this.run();
    };
    track.addEventListener("pointerup", end);
    track.addEventListener("pointercancel", end);
  }

  set(p) {
    this.playing = p;
    this.onState(p);
    if (!this.master) return;
    if (!p) return this.halt();
    if (this.master.ended) this.seek(0);
    this.run();
  }

  step(dir) {
    if (!this.master) return;
    this.set(false);
    this.seek(Math.max(0, Math.min(this.master.duration, this.master.currentTime + dir / FPS)));
  }

  setRate(r) {
    this.rate = r;
    for (const v of this.videos) v.playbackRate = r;
  }

  follow() {
    const m = this.master;
    if (!m || !this.playing || !this.visible || this.scrubbing) return;
    for (const v of this.videos) {
      if (v === m || m.currentTime >= v.duration) continue;
      if (Math.abs(v.currentTime - m.currentTime) > 0.08) v.currentTime = m.currentTime;
      if (v.paused) v.play().catch(() => { });
    }
  }
}

// Build a strip of example thumbnails (stills); a thumbnail whose image is missing shows its number.
function buildPicker(host, items, thumbPath, onPick) {
  const buttons = items.map((item, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "thumb";
    b.setAttribute("aria-label", `Example ${i + 1}`);
    const img = document.createElement("img");
    img.alt = "";
    img.loading = "lazy";
    img.addEventListener("error", () => {
      img.remove();
      b.classList.add("empty");
      b.insertAdjacentHTML("beforeend", `<span class="num">${String(i + 1).padStart(2, "0")}</span>`);
    }, { once: true });
    img.src = thumbPath(item);
    b.appendChild(img);
    b.addEventListener("click", () => onPick(i));
    host.appendChild(b);
    return b;
  });
  return i => buttons.forEach((b, j) => {
    b.classList.toggle("active", i === j);
    b.setAttribute("aria-pressed", i === j);
  });
}

// Pause / frame-step / speed buttons with ids <prefix>-play, -back, -fwd, -speeds.
function wirePlayback(group, prefix) {
  const playBtn = document.getElementById(`${prefix}-play`);
  group.onState = p => (playBtn.textContent = p ? "Pause" : "Play");
  playBtn.addEventListener("click", () => group.set(!group.playing));
  document.getElementById(`${prefix}-back`).addEventListener("click", () => group.step(-1));
  document.getElementById(`${prefix}-fwd`).addEventListener("click", () => group.step(1));
  const speeds = document.getElementById(`${prefix}-speeds`);
  SPEEDS.forEach(s => {
    const b = document.createElement("button");
    b.className = "chip";
    b.textContent = s + "×";
    b.setAttribute("aria-pressed", s === group.rate);
    b.addEventListener("click", () => {
      group.setRate(s);
      speeds.querySelectorAll(".chip").forEach(x => x.setAttribute("aria-pressed", x === b));
    });
    speeds.appendChild(b);
  });
}

// ===========================================================================
// Two-method player (.cmp), used by the before/after and the comparison. Each sequence is one stacked clip (the
// other method's clip on top, ours below), drawn into a canvas with a divider over the reprojection, so both sides
// always show the same frame.
// ===========================================================================

const STACK_ASPECT = "25 / 18";  // two 2000x720 clips stacked; the files may be scaled (stackCanvas reads videoWidth)
const SPLIT = 64;                // the reprojection's share of the clip's width (1280 of 2000 px), in percent

// Load one stacked clip into a .cmp player's group; its canvas draws from it (stackCanvas). A clip from its start has
// its first frame drawn from the poster (<clip>.jpg, half size) until it loads.
function mountStack(el, group, path, t0 = 0) {
  el.querySelectorAll(".layer video").forEach(stash);  // kept, so going back to it plays at once
  el.querySelectorAll(".layer").forEach(l => l.remove());
  el.poster = null;
  if (!t0) {
    el.poster = new Image();
    el.poster.src = path.replace(/\.mp4$/, ".jpg");
  }
  const fig = document.createElement("figure");
  fig.className = "layer";
  el.prepend(fig);  // under the canvas, tags and divider
  group.mount([{ fig, path }], STACK_ASPECT, t0);
}

// The canvas: the other method's reprojection left of the divider, ours right of it, and the world view, all from
// the same frame. While the next clip loads, draws its poster if it has one, else keeps the last frame; clears for a
// placeholder.
function stackCanvas(el, group) {
  const canvas = document.createElement("canvas");
  canvas.className = "fill";
  canvas.setAttribute("aria-hidden", "true");
  el.prepend(canvas);
  const ctx = canvas.getContext("2d");
  fitCanvas(canvas);
  const draw = () => {
    requestAnimationFrame(draw);
    if (!group.visible || !canvas.width) return;
    if (el.querySelector(".placeholder")) return ctx.clearRect(0, 0, canvas.width, canvas.height);
    const m = group.master, p = el.poster;
    const v = m && m.readyState >= 2 ? m : p && p.complete && p.naturalWidth ? p : null;
    if (!v) return;
    const k = (v.videoWidth || v.naturalWidth) / 2000, W = canvas.width, H = canvas.height;
    const sw = W * SPLIT / 100, x = sw * +el.getAttribute("aria-valuenow") / 100;
    ctx.drawImage(v, 0, 720 * k, 1280 * k, 720 * k, 0, 0, sw, H);  // ours
    if (x >= 1) ctx.drawImage(v, 0, 0, 1280 * k * x / sw, 720 * k, 0, 0, x, H);  // the other method, left of the divider
    ctx.drawImage(v, 1280 * k, 0, 720 * k, 720 * k, sw, 0, W - sw, H);  // world view
  };
  requestAnimationFrame(draw);
}

// The divider: drag anywhere on the player, or the arrow keys. aria-valuenow is its position across the
// reprojection, 0 to 100.
function wipe(el) {
  const setDivider = pct => {
    pct = Math.min(100, Math.max(0, pct));
    el.style.setProperty("--x", `${pct * SPLIT / 100}%`);
    el.setAttribute("aria-valuenow", Math.round(pct));
  };
  const dragTo = e => {
    const r = el.getBoundingClientRect();
    setDivider((e.clientX - r.left) / (r.width * SPLIT / 100) * 100);
  };
  el.addEventListener("pointerdown", e => { el.setPointerCapture(e.pointerId); dragTo(e); });
  el.addEventListener("pointermove", e => { if (el.hasPointerCapture(e.pointerId)) dragTo(e); });
  el.addEventListener("keydown", e => {
    const d = { ArrowLeft: -5, ArrowRight: 5 }[e.key];
    if (!d) return;
    e.preventDefault();
    setDivider(+el.getAttribute("aria-valuenow") + d);
  });
}

// ===========================================================================
// Before/after: before the correction left of the divider, after it right.
// ===========================================================================

(() => {
  const ba = document.getElementById("ba");
  const group = new SyncGroup(ba, null, document.getElementById("ba-bar"));
  const stats = document.getElementById("ba-stats");
  const path = i => `${BA[i].dir}/${BA[i].id}_opt_stack.mp4`;
  const pick = i => {
    mountStack(ba, group, path(i));
    mark(i);
    stats.innerHTML = `This clip's camera <span class="pill">${BA[i].speed.toFixed(1)} body/s</span>
      <span class="pill">${Math.round(BA[i].turn)}&deg;/s</span> median speed (body lengths per second) and turn rate.`;
    ba.dataset.vid = BA[i].id;
    ba.dispatchEvent(new CustomEvent("clip"));
  };
  const thumbs = document.getElementById("ba-thumbs");
  const mark = buildPicker(thumbs, BA, c => `${c.dir}/${c.id}_thumb.jpg`, pick);
  ba.dataset.vid = BA[0].id;  // the opening clip, so its 3D data can be fetched before the player mounts it
  // hovering a thumbnail fetches that clip's video, then its 3D data
  thumbs.addEventListener("pointerover", e => {
    const b = e.target.closest(".thumb");
    if (!b || b.classList.contains("active")) return;
    const i = [...thumbs.children].indexOf(b);
    fetchAhead(path(i), true).then(() => ba.dispatchEvent(new CustomEvent("prefetch", { detail: BA[i].id })));
  });
  fetchAhead(path(0));  // the opening clip, if the player has not mounted it by the time the queue starts
  wipe(ba);
  stackCanvas(ba, group);
  wirePlayback(group, "ba");
  onceInView(ba, () => pick(0), "600px 0px");  // the first clip loads only near the viewport
})();

// ===========================================================================
// Comparison: a baseline left of the divider, ours right; baseline tabs and a clip strip. A tab switch keeps the
// playback time.
// ===========================================================================

(() => {
  const cmp = document.getElementById("cmp");
  const tag = document.getElementById("cmp-tag");
  const key = document.getElementById("cmp-key");  // world view: ours in colour, the baseline in grey
  const verdict = document.getElementById("cmp-verdict");
  const group = new SyncGroup(document.getElementById("comparison"), null, document.getElementById("cmp-bar"));
  let baseIdx = 0, clipIdx = 0;

  const chips = BASELINES.map((b, i) => {
    const c = document.createElement("button");
    c.className = "chip";
    c.textContent = b.name;
    c.addEventListener("click", () => showBase(i));
    document.getElementById("cmp-base").appendChild(c);
    return c;
  });
  function showBase(i) {
    baseIdx = i;
    chips.forEach((c, j) => c.setAttribute("aria-pressed", j === i));
    tag.textContent = BASELINES[i].name;
    key.innerHTML = `<i class="dot-ours"></i><b>Ours</b><i class="dot-base"></i><b>${BASELINES[i].name}</b>`;
    verdict.innerHTML = `${BASELINES[i].says} Ours aligns in 2D and stays stable in world space.`;
    mountStack(cmp, group, path(clipIdx, i), group.master ? group.master.currentTime : 0);
  }
  const path = (c, b) => `${CMP[c].dir}/${CMP[c].id}_${BASELINES[b].key}_stack.mp4`;
  // the clip's other baselines, the likely next tabs, at the front of the queue
  const otherTabs = c => BASELINES.forEach((_, b) => b !== baseIdx && fetchAhead(path(c, b), true));
  const pick = i => {
    clipIdx = i;
    group.master = null;  // a new clip starts from the beginning
    showBase(baseIdx);
    mark(i);
    otherTabs(i);
  };
  const thumbs = document.getElementById("cmp-thumbs");
  const mark = buildPicker(thumbs, CMP, c => `${c.dir}/${c.id}_thumb.jpg`, pick);
  // hovering a thumbnail fetches that clip on the open tab
  thumbs.addEventListener("pointerover", e => {
    const b = e.target.closest(".thumb");
    if (b && !b.classList.contains("active")) fetchAhead(path([...thumbs.children].indexOf(b), baseIdx), true);
  });
  fetchAhead(path(0, 0));  // the opening clip and its other tabs, before the reader gets there
  BASELINES.forEach((_, b) => b && fetchAhead(path(0, b)));
  wipe(cmp);
  stackCanvas(cmp, group);
  wirePlayback(group, "cmp");
  onceInView(cmp, () => pick(0), "600px 0px");
})();
