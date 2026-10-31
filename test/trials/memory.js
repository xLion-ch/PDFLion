/**
 * How many viewer frames an iPad keeps loaded: opens today's viewer in one
 * frame after another, each like a tab, shown while it loads and renders a
 * few pages, then hidden under the next. The run is kept in localStorage
 * before each frame, so that a reload, which iPadOS does when a page uses
 * too much memory, is reported by whichever trial page loads next
 * (trials.js).
 */
import { MEMORY_RUN, element, finish, report, sleep } from "./trials.js";

/** @type {Record<string, { label: string, pages: number }>} in dist/trials/docs/ */
const DOCUMENTS = {
  "scans.pdf": { label: "Large scans: 10 pages of 2480 × 3508 pixels", pages: 10 },
  "tracemonkey.pdf": { label: "pdf.js's demo: 14 pages of text", pages: 14 },
};

/** How long a frame may take to show its first page. */
const RENDER_TIMEOUT = 60_000;

let stopped = false;

// pdf.js dispatches webviewerloaded at the document of the page that embeds
// it, when it can reach it, as it can from these same-origin frames
// (web/viewer.js). bridge.js listens at its own document, so this hands it
// the event there, at once, before the viewer initialises.
document.addEventListener("webviewerloaded", (event) => {
  const source = /** @type {CustomEvent} */ (event).detail?.source;
  if (!source || source === window) return;
  source.document.dispatchEvent(new source.CustomEvent("webviewerloaded", { detail: { source } }));
});

/** @param {HTMLElement} main */
export async function run(main) {
  const params = new URLSearchParams(location.search);
  const documentSelect = /** @type {HTMLSelectElement} */ (
    element(
      "select",
      {},
      Object.entries(DOCUMENTS).map(([file, { label }]) =>
        element("option", { value: file, textContent: label }),
      ),
    )
  );
  documentSelect.value = params.get("document") ?? "scans.pdf";
  const maxInput = /** @type {HTMLInputElement} */ (
    element("input", { type: "number", min: "1", max: "40", value: params.get("frames") ?? "12" })
  );
  const status = element("p", { className: "status" });
  const frames = element("div", { className: "frames" });

  const last = JSON.parse(localStorage.getItem(MEMORY_RUN) ?? "null");
  if (last) {
    status.textContent = last.reloaded
      ? `The last run reloaded while opening frame ${last.loaded + 1} of ${last.document}.`
      : `The last run kept all ${last.loaded} frames of ${last.document}.`;
  }

  const start = async () => {
    stopped = false;
    frames.replaceChildren();
    return openFrames(frames, documentSelect.value, Number(maxInput.value), status);
  };
  main.append(
    element("p", {}, [documentSelect]),
    element("p", {}, ["Frames ", maxInput]),
    element("p", {}, [
      element("button", { textContent: "Start", onclick: start }),
      element("button", { textContent: "Stop", onclick: () => (stopped = true) }),
      element("button", {
        textContent: "Close the frames",
        onclick: () => {
          stopped = true;
          frames.replaceChildren();
        },
      }),
    ]),
    status,
    frames,
  );

  if (params.has("auto")) finish(await start());
}

/**
 * @param {HTMLElement} container
 * @param {string} file in docs/
 * @param {number} max
 * @param {HTMLElement} status
 */
async function openFrames(container, file, max, status) {
  const run = { running: true, document: file, loaded: 0, max, startedAt: Date.now(), seconds: [] };
  const keep = () => localStorage.setItem(MEMORY_RUN, JSON.stringify(run));
  keep();
  // Leaving the page ends the run. When iPadOS ends the page for its memory,
  // nothing runs, and the run stays marked running.
  const leave = () => {
    stopped = true;
    run.running = false;
    keep();
  };
  window.addEventListener("pagehide", leave, { once: true });
  const { pages } = DOCUMENTS[file];
  for (let n = 1; n <= max && !stopped; n++) {
    status.textContent = `Opening frame ${n}…`;
    const query = encodeURIComponent(`../../docs/${file}`);
    const page = 1 + ((3 * (n - 1)) % pages);
    const frame = /** @type {HTMLIFrameElement} */ (
      element("iframe", { src: `viewer/web/viewer.html?file=${query}#page=${page}` })
    );
    container.querySelector(".shown")?.classList.remove("shown");
    frame.classList.add("shown");
    container.append(frame);
    const started = performance.now();
    await rendered(frame);
    await browse(frame);
    run.loaded = n;
    run.seconds.push(Math.round((performance.now() - started) / 100) / 10);
    keep();
    status.textContent = `${n} frames loaded`;
  }
  run.running = false;
  keep();
  const result = {
    reloaded: false,
    loadedFrames: run.loaded,
    document: file,
    secondsEach: run.seconds,
    // Chromium only.
    heapMB: /** @type {any} */ (performance).memory
      ? Math.round(/** @type {any} */ (performance).memory.usedJSHeapSize / 1e6)
      : null,
  };
  report("memory", result);
  return result;
}

/**
 * Waits until the frame's viewer shows a page.
 *
 * @param {HTMLIFrameElement} frame
 */
async function rendered(frame) {
  const deadline = performance.now() + RENDER_TIMEOUT;
  while (!frame.contentDocument?.querySelector("#viewer .page canvas")) {
    if (performance.now() > deadline) throw new Error("the viewer showed no page");
    await sleep(250);
  }
}

/**
 * Scrolls down three screens, as someone reading would, so that pdf.js
 * renders and keeps more pages.
 *
 * @param {HTMLIFrameElement} frame
 */
async function browse(frame) {
  const viewer = frame.contentDocument?.getElementById("viewerContainer");
  for (let i = 0; i < 3 && viewer; i++) {
    await sleep(1000);
    viewer.scrollBy(0, viewer.clientHeight);
  }
  await sleep(1000);
}
