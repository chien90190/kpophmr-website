// Drift explainer: how a wrong scale s moves performers with the camera, on DRIFT_DEMO's camera path.
(() => {
  const canvas = document.getElementById("drift-canvas");
  const slider = document.getElementById("drift-s");
  const out = document.getElementById("drift-out");
  const says = document.getElementById("drift-says");
  const legend = canvas.parentElement.querySelector(".legend");
  const ctx = canvas.getContext("2d");
  const markLabel = document.getElementById("drift-mark");
  const modeSwitch = document.getElementById("drift-mode");
  const { cam, heading, paths, fps } = DRIFT_DEMO;
  const N = cam.length, HOLD = fps;  // pause one second on the last frame
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const INK = css("--ink"), DRIFT_C = css("--drift");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

  let dancing = false;
  const truth = (p, t) => (dancing ? p[t] : p[0]);
  const disp = t => [cam[t][0] - cam[0][0], cam[t][1] - cam[0][1]];
  const composed = (m, t, a) => { const d = disp(t); return [m[0] + a * d[0], m[1] + a * d[1]]; };  // m: true position, a = 1 - s

  // Framing: fixed for s from 0 to 1, so the drift reads at its true size there; outside that range the view widens to
  // keep the drift in frame.
  const bounds = pts => {
    const xs = pts.map(p => p[0]), zs = pts.map(p => p[1]);
    return { x0: Math.min(...xs), x1: Math.max(...xs), z0: Math.min(...zs), z1: Math.max(...zs) };
  };
  const driftAt = a => paths.flatMap(p => { const out = []; for (let t = 0; t < N; t += 4) out.push(composed(p[t], t, a), composed(p[0], t, a)); return out; });
  const base = bounds([...cam, ...paths.flat(), ...driftAt(1)]);
  const frameFor = a => {
    if (a >= 0 && a <= 1) return base;
    const d = bounds(driftAt(a));
    return { x0: Math.min(base.x0, d.x0), x1: Math.max(base.x1, d.x1), z0: Math.min(base.z0, d.z0), z1: Math.max(base.z1, d.z1) };
  };
  let box = { ...base };

  let W = 0, H = 0, dpr = 1;  // CSS size and pixel ratio
  // world x to the right, world z down the canvas: the stage is at the top, the camera below it
  const view = () => {
    const pad = 24, top = modeSwitch.offsetTop + modeSwitch.offsetHeight + 12, bottom = legend.offsetHeight + 24;  // clear the switch and the legend
    const k = Math.min((W - 2 * pad) / (box.x1 - box.x0), (H - top - bottom) / (box.z1 - box.z0));
    const ox = (W - k * (box.x1 - box.x0)) / 2, oz = top + (H - top - bottom - k * (box.z1 - box.z0)) / 2;
    return { k, P: ([x, z]) => [ox + k * (x - box.x0), oz + k * (z - box.z0)] };
  };

  let s = +slider.value, target = s, t = still ? N - 1 : 0, last = performance.now(), visible = false;
  const readout = () => {
    const a = 1 - s, d = disp(N - 1), m = Math.hypot(a * d[0], a * d[1]);
    out.value = Math.abs(a) < 0.005 ? `s = 1.00, no drift` : `s = ${s.toFixed(2)}, drift ${m.toFixed(1)} m`;
    says.textContent =
      Math.abs(a) < 0.005 ? "Correct scale. The meshes see the same camera motion as the camera does, so performers who stand still stay on their marks."
        : s < -0.005 ? "Below 0 is not a scale error. A scale can stretch the camera's path but not reverse it, so one of the two estimates is broken."
          : s < 0.005 ? "The limit of too little scale. The meshes see no camera motion, so performers ride along with the camera."
            : s < 1 ? "Too little scale. The meshes see less camera motion than there was, so performers trail the camera."
              : "Too much scale. The meshes see more camera motion than there was, so performers slide against it, with no limit.";
  };

  function draw() {
    if (!W) return;
    const { k, P } = view(), f = Math.min(N - 1, Math.floor(t)), a = 1 - s;
    const DRIFT = s < 0 ? "#a3a8b0" : DRIFT_C;  // grey below 0: not a scale, so not a drift the correction could remove
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    // 1 m grid
    ctx.strokeStyle = "rgba(20,24,30,.06)"; ctx.lineWidth = 1;
    for (let x = Math.ceil(box.x0); x <= box.x1; x++) { const [px] = P([x, 0]); ctx.beginPath(); ctx.moveTo(px, 0); ctx.lineTo(px, H); ctx.stroke(); }
    for (let z = Math.ceil(box.z0); z <= box.z1; z++) { const [, pz] = P([0, z]); ctx.beginPath(); ctx.moveTo(0, pz); ctx.lineTo(W, pz); ctx.stroke(); }
    // camera path: whole path faint, travelled part solid
    const path = (n, style, width, dash) => {
      ctx.setLineDash(dash); ctx.strokeStyle = style; ctx.lineWidth = width; ctx.beginPath();
      for (let i = 0; i <= n; i++) { const [px, pz] = P(cam[i]); i ? ctx.lineTo(px, pz) : ctx.moveTo(px, pz); }
      ctx.stroke(); ctx.setLineDash([]);
    };
    path(N - 1, "rgba(20,24,30,.18)", 1.5, [4, 4]);
    path(f, INK, 2, []);
    // performers: true trail (dancing only), drift trail, composed position, true position
    const trail = (pos, style, width) => {
      ctx.strokeStyle = style; ctx.lineWidth = width; ctx.globalAlpha = .35; ctx.beginPath();
      for (let i = 0; i <= f; i++) { const [px, pz] = P(pos(i)); i ? ctx.lineTo(px, pz) : ctx.moveTo(px, pz); }
      ctx.stroke(); ctx.globalAlpha = 1;
    };
    for (const p of paths) {
      if (dancing) trail(i => p[i], INK, 1.5);
      trail(i => composed(truth(p, i), i, a), DRIFT, 2);
      const [mx, mz] = P(truth(p, f));
      const [cx, cz] = P(composed(truth(p, f), f, a));
      ctx.fillStyle = DRIFT; ctx.beginPath(); ctx.arc(cx, cz, 5.5, 0, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(mx, mz, 7, 0, 2 * Math.PI); ctx.stroke();
    }
    // camera: a frustum opening along its heading, apex at the camera centre
    const [px, pz] = P(cam[f]), h = heading[f], r = 22;
    ctx.fillStyle = "rgba(20,24,30,.12)"; ctx.strokeStyle = INK; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(px, pz);
    ctx.lineTo(px + r * Math.cos(h - .4), pz + r * Math.sin(h - .4));
    ctx.lineTo(px + r * Math.cos(h + .4), pz + r * Math.sin(h + .4));
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = INK; ctx.beginPath(); ctx.arc(px, pz, 3.5, 0, 2 * Math.PI); ctx.fill();
  }

  const tick = now => {
    requestAnimationFrame(tick);
    const dt = Math.min(.05, (now - last) / 1000); last = now;
    if (!visible) return;
    if (Math.abs(target - s) > 1e-3) { s += (target - s) * Math.min(1, dt * 6); slider.value = s; readout(); }
    else s = target;
    const goal = frameFor(1 - s), ease = still ? 1 : Math.min(1, dt * 5);
    for (const key in box) box[key] += (goal[key] - box[key]) * ease;
    if (!still) t = (t + dt * fps) % (N + HOLD);
    draw();
  };

  slider.addEventListener("input", () => { s = target = +slider.value; readout(); draw(); });
  document.getElementById("drift-fix").addEventListener("click", () => { target = 1; });
  const modes = [...document.querySelectorAll("#drift-mode .chip")];
  for (const b of modes) b.addEventListener("click", () => {
    dancing = b.dataset.mode === "dance";
    modes.forEach(x => x.setAttribute("aria-pressed", x === b));
    markLabel.textContent = dancing ? "where performers are" : "where performers stand";
    t = still ? N - 1 : 0;  // replay from the start so both trails build up together
    draw();
  });
  fitCanvas(canvas, (w, h, ratio) => { W = w; H = h; dpr = ratio; draw(); });
  whileInView(canvas, inView => { visible = inView; });
  readout();
  requestAnimationFrame(tick);
})();
