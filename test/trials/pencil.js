/**
 * What the Apple Pencil and fingers send. It draws every pointer's events,
 * the Pencil's hovering as dots, and sums up each stroke: pressure, tilt,
 * how often events and coalesced events come, predicted events, hovering
 * before it, and the touches and presses of other fingers while the Pencil
 * is down, such as a resting palm's.
 */
import { element, report } from "./trials.js";

/** Strokes reported at most, per visit. */
const MAX_REPORTS = 100;

const COLORS = { pen: "#0a66d8", touch: "#d86a0a", mouse: "#808080" };

/**
 * @typedef {object} Stroke
 * @property {string} pointerType
 * @property {boolean} isPrimary
 * @property {number} startedAt
 * @property {number} lastAt
 * @property {number} moves pointermove events
 * @property {number} coalesced events within them
 * @property {number[]} coalescedTimes for the rate
 * @property {number} predicted moves that had predicted events
 * @property {Record<string, [number, number]>} ranges min and max of each value
 * @property {number} hoverBefore the pen's hovering moves since the last stroke
 * @property {Record<string, number>} touchesDuring touchstart events by touchType
 * @property {string[]} pressesDuring other pointers' pointerdowns, by type
 * @property {number} maxTouchRadius of the touches during the stroke
 * @property {{ x: number, y: number }} last
 */

/** @param {HTMLElement} main */
export async function run(main) {
  const canvas = /** @type {HTMLCanvasElement} */ (element("canvas"));
  const summary = element("pre", {
    textContent: "Draw with the Pencil, rest a hand on the screen, hover the Pencil, use a finger.",
  });
  main.append(
    element("p", {}, [
      element("button", {
        textContent: "Clear",
        onclick: () => context.clearRect(0, 0, canvas.width, canvas.height),
      }),
    ]),
    canvas,
    summary,
  );
  const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext("2d"));
  const resize = () => {
    canvas.width = canvas.clientWidth * devicePixelRatio;
    canvas.height = canvas.clientHeight * devicePixelRatio;
    context.scale(devicePixelRatio, devicePixelRatio);
  };
  resize();
  window.addEventListener("resize", resize);

  /** @type {Map<number, Stroke>} */
  const strokes = new Map();
  let hovering = 0;
  let reports = 0;

  /** @param {PointerEvent} event */
  const at = (event) => {
    const box = canvas.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  canvas.addEventListener("pointerdown", (event) => {
    for (const other of strokes.values()) other.pressesDuring.push(event.pointerType);
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // WebKit has no pointer to capture for an event a script made.
    }
    strokes.set(event.pointerId, {
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      startedAt: event.timeStamp,
      lastAt: event.timeStamp,
      moves: 0,
      coalesced: 0,
      coalescedTimes: [],
      predicted: 0,
      ranges: {},
      hoverBefore: event.pointerType === "pen" ? hovering : 0,
      touchesDuring: {},
      pressesDuring: [],
      maxTouchRadius: 0,
      last: at(event),
    });
    if (event.pointerType === "pen") hovering = 0;
    note(/** @type {Stroke} */ (strokes.get(event.pointerId)), event);
  });

  canvas.addEventListener("pointermove", (event) => {
    const stroke = strokes.get(event.pointerId);
    if (!stroke) {
      // The Pencil hovering, on iPads that have hover.
      if (event.pointerType === "pen" && event.buttons === 0) {
        hovering++;
        const { x, y } = at(event);
        context.fillStyle = "rgb(10 102 216 / 0.25)";
        context.fillRect(x - 1, y - 1, 2, 2);
      }
      return;
    }
    stroke.moves++;
    stroke.lastAt = event.timeStamp;
    const events = event.getCoalescedEvents?.() ?? [];
    stroke.coalesced += events.length;
    for (const coalesced of events) stroke.coalescedTimes.push(coalesced.timeStamp);
    if ((event.getPredictedEvents?.() ?? []).length > 0) stroke.predicted++;
    note(stroke, event);

    context.strokeStyle = COLORS[/** @type {keyof COLORS} */ (event.pointerType)] ?? "#808080";
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(stroke.last.x, stroke.last.y);
    for (const point of events.length > 0 ? events : [event]) {
      context.lineWidth = event.pointerType === "pen" ? 0.5 + 4 * point.pressure : 2;
      const { x, y } = at(point);
      context.lineTo(x, y);
      stroke.last = { x, y };
    }
    context.stroke();
  });

  /** @param {PointerEvent} event */
  const end = (event) => {
    const stroke = strokes.get(event.pointerId);
    if (!stroke) return;
    strokes.delete(event.pointerId);
    const result = summarize(stroke, event.type);
    summary.textContent = JSON.stringify(result, null, 1);
    if (reports++ < MAX_REPORTS) report("pencil", result);
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);

  // Touch events say whether a touch is the Pencil's (`stylus`) or a
  // finger's (`direct`), and how large it is, as a palm's would be.
  canvas.addEventListener(
    "touchstart",
    (event) => {
      for (const stroke of strokes.values()) {
        if (stroke.pointerType !== "pen") continue;
        for (const touch of event.changedTouches) {
          const type = /** @type {any} */ (touch).touchType ?? "unknown";
          stroke.touchesDuring[type] = (stroke.touchesDuring[type] ?? 0) + 1;
          stroke.maxTouchRadius = Math.max(stroke.maxTouchRadius, touch.radiusX, touch.radiusY);
        }
      }
    },
    { passive: true },
  );
}

/**
 * Widens the stroke's ranges by an event's values.
 *
 * @param {Stroke} stroke
 * @param {PointerEvent} event
 */
function note(stroke, event) {
  const values = {
    pressure: event.pressure,
    tangentialPressure: event.tangentialPressure,
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    altitudeAngle: /** @type {any} */ (event).altitudeAngle,
    azimuthAngle: /** @type {any} */ (event).azimuthAngle,
    twist: event.twist,
    width: event.width,
    height: event.height,
  };
  for (const [name, value] of Object.entries(values)) {
    if (typeof value !== "number") continue;
    const range = stroke.ranges[name];
    stroke.ranges[name] = range
      ? [Math.min(range[0], value), Math.max(range[1], value)]
      : [value, value];
  }
}

/**
 * @param {Stroke} stroke
 * @param {string} endedWith `pointerup` or `pointercancel`
 */
function summarize(stroke, endedWith) {
  const seconds = (stroke.lastAt - stroke.startedAt) / 1000;
  const times = stroke.coalescedTimes;
  const coalescedSeconds = times.length > 1 ? (times[times.length - 1] - times[0]) / 1000 : 0;
  const rounded = Object.fromEntries(
    Object.entries(stroke.ranges).map(([name, [min, max]]) => [name, [round(min), round(max)]]),
  );
  return {
    pointerType: stroke.pointerType,
    isPrimary: stroke.isPrimary,
    endedWith,
    seconds: round(seconds),
    moves: stroke.moves,
    movesPerSecond: seconds > 0 ? Math.round(stroke.moves / seconds) : null,
    coalesced: stroke.coalesced,
    coalescedPerSecond:
      coalescedSeconds > 0 ? Math.round((times.length - 1) / coalescedSeconds) : null,
    movesWithPredicted: stroke.predicted,
    hoverBefore: stroke.hoverBefore,
    touchesDuring: stroke.touchesDuring,
    pressesDuring: stroke.pressesDuring,
    maxTouchRadius: round(stroke.maxTouchRadius),
    ...rounded,
  };
}

/** @param {number} value */
function round(value) {
  return Math.round(value * 100) / 100;
}
