/**
 * What a Home Screen app gets that the web app would rely on: which of its
 * shortcuts and pdf.js's reach the page, which then stops them, whether
 * window.print() and element full screen work, and whether stopping
 * gesturestart keeps a pinch from zooming the page.
 */
import { device, element, report } from "./trials.js";

/**
 * @param {KeyboardEvent} event
 * @param {{ meta?: boolean, shift?: boolean, alt?: boolean, ctrl?: boolean }} modifiers
 *   those that must be down, while the others must be up
 */
function modifiers(event, { meta = false, shift = false, alt = false, ctrl = false }) {
  return (
    event.metaKey === meta &&
    event.shiftKey === shift &&
    event.altKey === alt &&
    event.ctrlKey === ctrl
  );
}

/**
 * ⌘ with a letter, by `event.key`, since on other layouts than US, such as
 * QWERTZ, `event.code` names another key.
 *
 * @param {string} letter
 * @param {boolean} [shift]
 * @returns {(event: KeyboardEvent) => boolean}
 */
const command = (letter, shift = false) => (event) =>
  modifiers(event, { meta: true, shift }) && event.key.toLowerCase() === letter;

/**
 * ⌘ with a key, whatever the layout needs Shift for, as pdf.js takes them.
 *
 * @param {string[]} keys
 * @returns {(event: KeyboardEvent) => boolean}
 */
const commandAnyShift = (keys) => (event) =>
  event.metaKey && !event.altKey && !event.ctrlKey && keys.includes(event.key);

/** @type {{ keys: string, does: string, matches: (event: KeyboardEvent) => boolean }[]} */
const SHORTCUTS = [
  { keys: "⌘O", does: "Open", matches: command("o") },
  { keys: "⌘N", does: "New", matches: command("n") },
  { keys: "⌘W", does: "Close Tab", matches: command("w") },
  { keys: "⌘S", does: "Save now", matches: command("s") },
  { keys: "⇧⌘S", does: "Share", matches: command("s", true) },
  { keys: "⇧⌘N", does: "Insert Blank Page", matches: command("n", true) },
  {
    keys: "⌥⌘6",
    does: "Page Overview",
    // ⌥ changes event.key, and digits are in the same place on every layout.
    matches: (event) => modifiers(event, { meta: true, alt: true }) && event.code === "Digit6",
  },
  { keys: "⇧⌘E", does: "Eraser", matches: command("e", true) },
  { keys: "⇧⌘H", does: "Home", matches: command("h", true) },
  {
    keys: "⌃Tab",
    does: "Next tab",
    matches: (event) => modifiers(event, { ctrl: true }) && event.key === "Tab",
  },
  {
    keys: "⌃⇧Tab",
    does: "Previous tab",
    matches: (event) => modifiers(event, { ctrl: true, shift: true }) && event.key === "Tab",
  },
  { keys: "⌘Z", does: "Undo", matches: command("z") },
  { keys: "⇧⌘Z", does: "Redo", matches: command("z", true) },
  { keys: "⌘P", does: "Print (pdf.js)", matches: command("p") },
  { keys: "⌘F", does: "Find (pdf.js)", matches: command("f") },
  { keys: "⌘+", does: "Zoom in (pdf.js)", matches: commandAnyShift(["+", "="]) },
  { keys: "⌘−", does: "Zoom out (pdf.js)", matches: commandAnyShift(["-"]) },
  { keys: "⌘0", does: "Actual size (pdf.js)", matches: commandAnyShift(["0"]) },
];

/** @param {HTMLElement} main */
export async function run(main) {
  const mode = device().standalone ? "a Home Screen app" : "a Safari tab, not a Home Screen app";
  const rows = SHORTCUTS.map((shortcut) => {
    const state = element("td", { textContent: "not yet" });
    const row = element("tr", {}, [
      element("td", { textContent: shortcut.keys }),
      element("td", { textContent: shortcut.does }),
      state,
    ]);
    return { shortcut, state, row };
  });
  const keyLog = element("pre");
  const printResult = element("p");
  const fullscreenResult = element("p");
  const gestureLog = element("pre");
  const target = element("div", {
    id: "fullscreenTarget",
    textContent: "This box goes full screen.",
  });

  main.append(
    element("p", { className: "status", textContent: `Running as ${mode}.` }),
    element("h2", { textContent: "Shortcuts" }),
    element("p", {
      textContent:
        "With a hardware keyboard, press each. The page stops every one it gets. Note any " +
        "that iPadOS or Safari still acted on, such as closing the app, then press Send.",
    }),
    element("table", {}, rows.map(({ row }) => row)),
    element("button", {
      textContent: "Send",
      onclick: () => {
        const reached = rows.filter(({ state }) => state.textContent !== "not yet");
        report("keys", {
          mode,
          reached: reached.map(({ shortcut }) => shortcut.keys),
          missed: rows.filter((row) => !reached.includes(row)).map(({ shortcut }) => shortcut.keys),
        });
      },
    }),
    keyLog,
    element("h2", { textContent: "Printing" }),
    element("button", { textContent: "window.print()", onclick: () => tryPrint(printResult) }),
    printResult,
    element("h2", { textContent: "Full screen" }),
    target,
    element("button", {
      textContent: "Box full screen",
      onclick: () => tryFullscreen(target, fullscreenResult),
    }),
    element("button", {
      textContent: "Page full screen",
      onclick: () => tryFullscreen(document.documentElement, fullscreenResult),
    }),
    fullscreenResult,
    element("h2", { textContent: "Pinching" }),
    element("p", {
      textContent:
        "Pinch in each box, then double-tap it. The dashed box stops gesturestart, as the " +
        "web app would outside the pages. The solid one doesn't.",
    }),
    element("div", {
      className: "zone",
      textContent: "Stopped: gesturestart gets preventDefault()",
    }),
    element("div", { className: "zone allowed", textContent: "Allowed" }),
    gestureLog,
  );

  window.addEventListener(
    "keydown",
    (event) => {
      const match = rows.find(({ shortcut }) => shortcut.matches(event));
      if (match) {
        event.preventDefault();
        match.state.textContent = "reached the page";
        match.state.className = "reached";
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        const held = [
          event.ctrlKey ? "⌃" : "",
          event.altKey ? "⌥" : "",
          event.shiftKey ? "⇧" : "",
          event.metaKey ? "⌘" : "",
        ].join("");
        const line = `${held}${event.code} (key "${event.key}")${match ? ", stopped" : ""}`;
        keyLog.textContent = `${line}\n${keyLog.textContent}`;
      }
    },
    true,
  );

  /** @type {{ zone: string, prevented: boolean, scaleBefore: number } | null} */
  let gesture = null;
  document.addEventListener("gesturestart", (event) => {
    const zone = /** @type {Element} */ (event.target).closest?.(".zone");
    const allowed = !zone || zone.classList.contains("allowed");
    if (!allowed) event.preventDefault();
    gesture = {
      zone: zone ? (allowed ? "allowed" : "stopped") : "outside",
      prevented: !allowed,
      scaleBefore: visualViewport?.scale ?? 1,
    };
  });
  document.addEventListener("gestureend", () => {
    if (!gesture) return;
    const result = { ...gesture, scaleAfter: round(visualViewport?.scale ?? 1) };
    gestureLog.textContent = `${JSON.stringify(result)}\n${gestureLog.textContent}`;
    report("keys-pinch", result);
    gesture = null;
  });
}

/** @param {HTMLElement} result */
function tryPrint(result) {
  let afterprint = false;
  window.addEventListener("afterprint", () => (afterprint = true), { once: true });
  const started = performance.now();
  try {
    window.print();
    const outcome = { returned: true, afterprint, ms: Math.round(performance.now() - started) };
    result.textContent = `${JSON.stringify(outcome)}. Did a print sheet show?`;
    report("keys-print", { ...outcome, standalone: device().standalone });
  } catch (error) {
    result.textContent = String(error);
    report("keys-print", { error: String(error), standalone: device().standalone });
  }
}

/**
 * @param {Element} target
 * @param {HTMLElement} result
 */
async function tryFullscreen(target, result) {
  const node = /** @type {any} */ (target);
  const request = node.requestFullscreen ?? node.webkitRequestFullscreen;
  const outcome = {
    target: target === document.documentElement ? "page" : "box",
    standalone: device().standalone,
  };
  if (typeof request !== "function") {
    result.textContent = "No requestFullscreen()";
    report("keys-fullscreen", { ...outcome, error: "no requestFullscreen" });
    return;
  }
  const changed = new Promise((resolve) => {
    for (const type of ["fullscreenchange", "webkitfullscreenchange"]) {
      document.addEventListener(type, () => resolve(type), { once: true });
    }
    setTimeout(() => resolve(null), 3000);
  });
  try {
    await request.call(target);
    const event = await changed;
    const page = /** @type {any} */ (document);
    const fullscreen = page.fullscreenElement ?? page.webkitFullscreenElement;
    result.textContent = `Entered: ${!!fullscreen} (${event})`;
    report("keys-fullscreen", { ...outcome, entered: !!fullscreen, event });
  } catch (error) {
    result.textContent = String(error);
    report("keys-fullscreen", { ...outcome, error: String(error) });
  }
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
