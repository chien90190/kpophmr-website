// Page chrome, standalone clips and charts.
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---- nav: solid once scrolled, progress line, link of the section in view ----
(() => {
  const nav = document.getElementById("nav");
  const progress = document.getElementById("nav-progress");
  const onScroll = () => {
    nav.classList.toggle("solid", scrollY > 8);
    progress.style.transform = `scaleX(${scrollY / Math.max(1, document.documentElement.scrollHeight - innerHeight)})`;
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  const links = [...document.querySelectorAll(".nav-links a")];
  for (const a of links) whileInView(document.querySelector(a.hash), inView => {
    if (inView) links.forEach(x => x.classList.toggle("active", x === a));
  }, "-45% 0px -50% 0px");
})();

// ---- hero: a wall of six tiles (four on a phone, which hides the rest) cycling through the HERO_WALL clips, playing
// only while in view. The clips are decoration and the figures are content, so the page loads in this order: the
// tiles' posters (<id>_ours.jpg, the first screen), then every still on the page (img loading="lazy", switched to
// eager here), then the clips, once the stills are in or at most 4 s in. Reduced motion keeps the posters. ----
(() => {
  const wall = document.getElementById("hero-wall");
  const tiles = matchMedia("(max-width: 768px)").matches ? 4 : 6;
  const clips = Array.from({ length: tiles }, (_, i) => HERO_WALL[i % HERO_WALL.length]);
  const vids = clips.map((t, i) => {
    const tile = document.createElement("div");
    tile.className = "tile";
    const v = document.createElement("video");
    v.muted = true; v.loop = true; v.playsInline = true; v.disablePictureInPicture = true; v.preload = "auto";
    v.poster = `${t.dir}/${t.id}_ours.jpg`;
    v.addEventListener("loadedmetadata", () => { v.currentTime = (i * 0.37) % Math.max(0.1, v.duration); }, { once: true });
    v.addEventListener("error", () => v.remove(), { once: true });
    tile.appendChild(v);
    wall.appendChild(tile);
    return v;
  });

  const stills = [...document.querySelectorAll('img[loading="lazy"]')].map(img => new Promise(res => {
    img.loading = "eager";
    if (img.complete) return res();
    img.addEventListener("load", res, { once: true });
    img.addEventListener("error", res, { once: true });
  }));
  if (reducedMotion) return;
  let inView = false;
  const play = () => vids.forEach(v => (inView && v.src ? v.play().catch(() => { }) : v.pause()));
  whileInView(document.querySelector(".hero"), v => { inView = v; play(); });
  Promise.race([Promise.all(stills), new Promise(res => setTimeout(res, 4000))]).then(() => {
    vids.forEach((v, i) => (v.src = `${clips[i].dir}/${clips[i].id}_ours.mp4`));
    play();
  });
})();

// ---- standalone clips (video[data-src], with a still in data-poster): load near the viewport, play only while
// visible ----
for (const v of document.querySelectorAll("video[data-src]")) whileInView(v, inView => {
  if (inView && !v.src) {
    if (v.dataset.poster) v.poster = v.dataset.poster;
    v.addEventListener("error", () => v.replaceWith(placeholder(v.dataset.src, "16 / 9")), { once: true });
    v.src = v.dataset.src;
  }
  inView ? v.play().catch(() => { }) : v.pause();
}, "300px 0px");

// ---- dataset charts: columns from DATASET_STATS, growing in left to right when in view ----
(() => {
  const col = (n, max, cls, label) => `<span class="col ${cls}" style="height:${100 * n / max}%">${label}</span>`;

  const f = DATASET_STATS.focal, fmax = Math.max(...f.kpop), at = v => `${100 * (v - f.lo) / (f.kpop.length * f.step)}%`;
  const ticks = [];
  for (let v = 500; v <= f.lo + f.kpop.length * f.step; v += 500) ticks.push(`<span style="left:${at(v)}">${v}</span>`);
  document.getElementById("chart-focal").innerHTML =
    `<div class="chart-plot">${f.kpop.map(n => `<span class="slot">${col(n, fmax, "", "")}</span>`).join("")}`
    + f.emdb.map(([v, n]) => `<span class="mark" style="left:${at(v)}"><span>EMDB ${n}</span></span>`).join("")
    + `</div><div class="chart-axis">${ticks.join("")}</div>`;

  const p = DATASET_STATS.people, pmax = Math.max(p.emdb, ...p.kpop);
  document.getElementById("chart-people").innerHTML =
    `<div class="chart-plot">${p.kpop.map((n, i) =>
      `<span class="slot">${i ? "" : col(p.emdb, pmax, "emdb", `<b>${p.emdb}</b>`)}${col(n, pmax, "", `<b>${n}</b>`)}</span>`).join("")}</div>`
    + `<div class="chart-axis slots">${p.kpop.map((_, i) => `<span>${i + 1}</span>`).join("")}</div>`;

  document.querySelectorAll(".chart-plot").forEach(plot =>
    plot.querySelectorAll(".col").forEach((c, i) => (c.style.transitionDelay = `${Math.min(i * 18, 420)}ms`)));
  onceInView(document.querySelectorAll(".charts"), el => el.classList.add("in"), "0px 0px -15% 0px");
})();

// ---- scroll reveal ----
onceInView(document.querySelectorAll(".reveal"), el => el.classList.add("in"), "0px 0px -8% 0px");

// ---- big numbers count up once when they come into view; the HTML holds the final value ----
if (!reducedMotion) onceInView(document.querySelectorAll(".count"), el => {
  const to = +el.dataset.to, dec = +(el.dataset.dec || 0), t0 = performance.now(), dur = 1400;
  const step = now => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    el.textContent = (to * e).toFixed(dec);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}, "0px 0px -10% 0px");

// ---- citation copy ----
document.getElementById("copy-bib").addEventListener("click", e => {
  navigator.clipboard.writeText(document.getElementById("bib-text").textContent).then(() => {
    e.target.textContent = "Copied";
    setTimeout(() => (e.target.textContent = "Copy"), 1500);
  });
});
