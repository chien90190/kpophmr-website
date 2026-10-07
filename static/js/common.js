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

// A clip is settled once it has all it will fetch for now: buffered and the browser no longer downloading (it is
// done, or it stopped because it has enough), or it failed. whenSettled(v) resolves then, or when v is emptied.
const settled = v => !!v.error || (v.readyState >= 3 && v.networkState !== HTMLMediaElement.NETWORK_LOADING);
function whenSettled(v) {
  return new Promise(res => {
    const events = ["suspend", "progress", "canplaythrough", "error", "emptied"];
    const check = e => {
      if (!(e && e.type === "emptied") && !settled(v)) return;
      for (const name of events) v.removeEventListener(name, check);
      res();
    };
    for (const name of events) v.addEventListener(name, check);
    check();
  });
}

// Downloads fetched ahead of the reader, one at a time and in order, once the first screen is in (ahead.start(); never
// with data saver on):
// add(task, first) queues task, a function returning a promise that settles when its download is done (first: ahead
// of the rest, for the reader's likely next pick), and returns a promise that settles after it ran. A task that hangs
// frees the queue after 30 s.
const ahead = (() => {
  const tasks = [];
  let open = false, running = false;
  const next = () => {
    if (!open || running || !tasks.length) return;
    running = true;
    const { task, done } = tasks.shift();
    Promise.race([Promise.resolve().then(task).catch(() => { }), new Promise(r => setTimeout(r, 30000))])
      .then(() => { running = false; done(); next(); });
  };
  return {
    add(task, first = false) {
      return new Promise(done => {
        tasks[first ? "unshift" : "push"]({ task, done });
        next();
      });
    },
    start() { open = !navigator.connection?.saveData; next(); },  // data saver: nothing ahead
  };
})();
