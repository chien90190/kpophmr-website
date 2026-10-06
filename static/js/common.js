// Helpers shared by the page's scripts. The plain scripts load in order (data, common, players, explainer, page) and
// share globals; viewer3d.js is a module and loads last.

// A labelled box in place of a missing video, showing the path it expects.
function placeholder(path, aspect) {
  const div = document.createElement("div");
  div.className = "placeholder";
  div.style.setProperty("--ar", aspect);
  div.innerHTML = `<b>Video placeholder</b><code>${path}</code>`;
  return div;
}

// fn(true / false) whenever el enters or leaves the viewport (grown by rootMargin).
function whileInView(el, fn, rootMargin = "0px") {
  new IntersectionObserver(([e]) => fn(e.isIntersecting), { rootMargin }).observe(el);
}

// fn(el) once, the first time each element comes into view.
function onceInView(els, fn, rootMargin = "0px") {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); fn(e.target); }
  }, { rootMargin });
  for (const el of els.length === undefined ? [els] : els) io.observe(el);
}

// Canvases are sized by CSS and drawn at the screen's pixel ratio, capped at 2x. fitCanvas keeps a canvas's buffer
// at its CSS size times that ratio and calls onResize(w, h, ratio) with the CSS size.
const pixelRatio = () => Math.min(devicePixelRatio, 2);
function fitCanvas(canvas, onResize) {
  new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight, ratio = pixelRatio();
    if (!w || !h) return;
    canvas.width = Math.round(w * ratio);
    canvas.height = Math.round(h * ratio);
    if (onResize) onResize(w, h, ratio);
  }).observe(canvas);
}
