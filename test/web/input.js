/**
 * Touch and pen input for the web app's tests, which Playwright doesn't
 * give as an iPad and an Apple Pencil would.
 *
 * - In any browser, the page's own events: Pointer Events with a pen's or a
 *   finger's `pointerType`, and for fingers Touch Events too, as Safari sends
 *   them. They're not trusted, so they don't scroll or zoom, but they show
 *   what PDFLion and pdf.js do with them: what's drawn, which events reach
 *   pdf.js, and which are cancelled.
 * - In Chromium, trusted touches through the DevTools protocol
 *   (`Input.dispatchTouchEvent`), which really scroll and pinch.
 *
 * Places are given as shares of the part of an element in view, such as the
 * first page's, so that they're the same at any size.
 */

/** @typedef {import("@playwright/test").Page} Page */
/** @typedef {import("@playwright/test").Frame} Frame */

/** The first page of the document, as pdf.js shows it. */
export const FIRST_PAGE = '#viewerContainer .page[data-page-number="1"]';

/**
 * @typedef {object} Step one event of a sequence, at a place in an element
 * @property {string} type such as `pointerdown` or `touchmove`
 * @property {[number, number]} at shares of the width and height of the
 *   part of the element in view
 * @property {"pen" | "touch" | "mouse"} [pointerType]
 * @property {number} [pointerId]
 * @property {number} [button] 0 for a press, -1 for a move
 * @property {number} [buttons] 1 while pressed, 0 while hovering
 * @property {number} [pressure]
 * @property {number} [tiltX]
 * @property {number} [tiltY]
 * @property {number} [identifier] a touch's, for Touch Events
 * @property {number} [wait] ms to wait before it
 */

/**
 * @typedef {object} Dispatched what became of an event of a sequence
 * @property {string} type
 * @property {string} target the element it went to, by its id or classes
 * @property {boolean} cancelled whether a listener prevented its default
 */

/**
 * Dispatches a sequence of events in a frame, each at the element under its
 * place, as a browser would. Touch Events list every finger down.
 *
 * @param {Frame} frame
 * @param {string} selector the element whose box the places are in
 * @param {Step[]} steps
 * @returns {Promise<Dispatched[]>}
 */
export function dispatch(frame, selector, steps) {
  return frame.evaluate(async ([selector, steps]) => {
    // The part of the element in view, in the viewer's container if it's in it.
    const element = /** @type {Element} */ (document.querySelector(selector));
    const view =
      element.closest("#viewerContainer")?.getBoundingClientRect() ??
      new DOMRect(0, 0, innerWidth, innerHeight);
    const all = element.getBoundingClientRect();
    const left = Math.max(all.left, view.left, 0);
    const top = Math.max(all.top, view.top, 0);
    const box = new DOMRect(
      left,
      top,
      Math.min(all.right, view.right, innerWidth) - left,
      Math.min(all.bottom, view.bottom, innerHeight) - top,
    );
    /** @type {Map<number, Touch>} the fingers down */
    const down = new Map();
    /**
     * Where each pen or finger pressed, which gets its events until it
     * lifts, as browsers capture them.
     * @type {Map<number, Element>}
     */
    const pressedOn = new Map();
    /**
     * @param {number} identifier
     * @param {Element} target
     * @param {number} x
     * @param {number} y
     * @returns {Touch}
     */
    const touch = (identifier, target, x, y) => {
      // WebKit's Touch has no constructor, Chromium's has.
      if ("createTouch" in document) {
        return /** @type {any} */ (document).createTouch(window, target, identifier, x, y, x, y);
      }
      return new Touch({ identifier, target, clientX: x, clientY: y, pageX: x, pageY: y });
    };
    /** @param {Touch[]} touches */
    const touchList = (touches) =>
      "createTouchList" in document
        ? /** @type {any} */ (document).createTouchList(...touches)
        : touches;
    const results = [];
    for (const step of steps) {
      if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait));
      const x = box.left + box.width * step.at[0];
      const y = box.top + box.height * step.at[1];
      const pointerId = step.pointerId ?? 1;
      const under = document.elementFromPoint(x, y) ?? document.body;
      /** @type {Event} */
      let event;
      let target = under;
      if (step.type.startsWith("touch")) {
        // A touch's events go where it started.
        const identifier = step.identifier ?? pointerId;
        const started = /** @type {Element | undefined} */ (down.get(identifier)?.target);
        const changed = touch(identifier, started ?? under, x, y);
        if (step.type === "touchstart" || step.type === "touchmove") down.set(identifier, changed);
        else down.delete(identifier);
        target = /** @type {Element} */ (changed.target);
        const touches = [...down.values()];
        event = new TouchEvent(step.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          touches: touchList(touches),
          targetTouches: touchList(touches.filter((other) => other.target === target)),
          changedTouches: touchList([changed]),
        });
      } else {
        if (step.type === "pointerdown" && step.pointerType !== "mouse")
          pressedOn.set(pointerId, under);
        target = pressedOn.get(pointerId) ?? under;
        const pressing = step.type === "pointerdown" || step.type === "pointermove";
        event = new PointerEvent(step.type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          pointerId,
          pointerType: step.pointerType ?? "pen",
          isPrimary: true,
          button: step.button ?? (step.type === "pointermove" ? -1 : 0),
          buttons: step.buttons ?? (pressing ? 1 : 0),
          pressure: step.pressure ?? (pressing && (step.buttons ?? 1) ? 0.5 : 0),
          tiltX: step.tiltX ?? 0,
          tiltY: step.tiltY ?? 0,
          width: step.pointerType === "touch" ? 20 : 1,
          height: step.pointerType === "touch" ? 20 : 1,
        });
        if (step.type === "pointerup" || step.type === "pointercancel") pressedOn.delete(pointerId);
      }
      const notCancelled = target.dispatchEvent(event);
      results.push({
        type: step.type,
        target: target.id || target.className?.toString?.() || target.tagName,
        cancelled: !notCancelled,
      });
    }
    return results;
  }, /** @type {[string, Step[]]} */ ([selector, steps]));
}

/**
 * @param {[number, number][]} points
 * @param {Partial<Step>} pointer
 * @returns {Step[]} a press at the first point, moves along the rest, and a
 *   lift at the last
 */
export function strokeSteps(points, pointer) {
  const last = /** @type {[number, number]} */ (points.at(-1));
  return [
    { ...pointer, type: "pointerdown", at: points[0] },
    ...points.slice(1).map((at) => ({ ...pointer, type: "pointermove", at })),
    { ...pointer, type: "pointerup", at: last },
  ];
}

/**
 * @param {[number, number]} from
 * @param {[number, number]} to
 * @param {number} [count] how many steps
 * @returns {[number, number][]} points along a line, both ends included
 */
export function line(from, to, count = 10) {
  return Array.from({ length: count + 1 }, (_, i) => [
    from[0] + ((to[0] - from[0]) * i) / count,
    from[1] + ((to[1] - from[1]) * i) / count,
  ]);
}

/**
 * Draws a stroke with an Apple Pencil, as Pointer Events of a pen, which
 * also hover there first and lift away after.
 *
 * @param {Frame} frame
 * @param {[number, number][]} points on the first page
 * @param {{ pressure?: number, tiltX?: number, tiltY?: number, pointerId?: number, selector?: string }} [options]
 */
export function pencilStroke(frame, points, { selector = FIRST_PAGE, ...pen } = {}) {
  return dispatch(
    frame,
    selector,
    strokeSteps(points, { pointerType: "pen", pointerId: 2, ...pen }),
  );
}

/**
 * Hovers a pen over the page, as Pencils do over iPads that have hover.
 *
 * @param {Frame} frame
 * @param {[number, number][]} points on the first page
 */
export function pencilHover(frame, points) {
  return dispatch(
    frame,
    FIRST_PAGE,
    points.map((at) => ({ type: "pointermove", at, pointerType: "pen", pointerId: 2, buttons: 0 })),
  );
}

/**
 * Drags a finger, as Safari sends it: Pointer Events and Touch Events
 * together.
 *
 * @param {Frame} frame
 * @param {[number, number][]} points on the first page
 * @param {number} [identifier]
 * @returns {Promise<Dispatched[]>}
 */
export function fingerDrag(frame, points, identifier = 11) {
  const finger = { pointerType: /** @type {const} */ ("touch"), pointerId: identifier, identifier };
  const last = /** @type {[number, number]} */ (points.at(-1));
  return dispatch(frame, FIRST_PAGE, [
    { ...finger, type: "pointerdown", at: points[0] },
    { ...finger, type: "touchstart", at: points[0] },
    ...points.slice(1).flatMap((at) => [
      { ...finger, type: "pointermove", at },
      { ...finger, type: "touchmove", at },
    ]),
    { ...finger, type: "pointerup", at: last },
    { ...finger, type: "touchend", at: last },
  ]);
}

/**
 * Presses an element with a finger, as long as a long press takes, and
 * lifts it, as Pointer Events, at its centre.
 *
 * @param {Frame} frame
 * @param {string} selector
 * @param {number} [time] in ms
 */
export function longPress(frame, selector, time = 700) {
  const finger = { pointerType: /** @type {const} */ ("touch"), pointerId: 21 };
  return dispatch(frame, selector, [
    { ...finger, type: "pointerdown", at: [0.5, 0.5] },
    { ...finger, type: "pointerup", at: [0.5, 0.5], wait: time },
  ]);
}

/**
 * Trusted touches in Chromium, through the DevTools protocol, at places in
 * the page, which really scroll and pinch.
 *
 * @param {Page} page
 */
export async function touchscreen(page) {
  const session = await page.context().newCDPSession(page);
  /**
   * @param {"touchStart" | "touchMove" | "touchEnd"} type
   * @param {{ x: number, y: number, id: number }[]} touchPoints
   */
  const send = (type, touchPoints) =>
    session.send("Input.dispatchTouchEvent", { type, touchPoints });
  return {
    /**
     * Swipes one finger along points, in the page's CSS pixels.
     *
     * @param {{ x: number, y: number }[]} points
     */
    async swipe(points) {
      await send("touchStart", [{ ...points[0], id: 1 }]);
      for (const point of points.slice(1)) await send("touchMove", [{ ...point, id: 1 }]);
      await send("touchEnd", []);
    },
    /**
     * Pinches with two fingers around a point, from one distance between
     * them to another, in steps.
     *
     * @param {{ x: number, y: number }} center
     * @param {number} from
     * @param {number} to
     * @param {{ steps?: number, firstAlone?: boolean }} [options] firstAlone:
     *   the first finger moves alone first, as when it was drawing
     */
    async pinch(center, from, to, { steps = 10, firstAlone = false } = {}) {
      /** @param {number} distance */
      const fingers = (distance) => [
        { x: center.x - distance / 2, y: center.y, id: 1 },
        { x: center.x + distance / 2, y: center.y, id: 2 },
      ];
      const [first] = fingers(from);
      await send("touchStart", [first]);
      if (firstAlone) {
        for (let i = 1; i <= 5; i++) await send("touchMove", [{ ...first, y: first.y + i * 4 }]);
        first.y += 20;
      }
      await send("touchStart", [first, fingers(from)[1]]);
      for (let i = 1; i <= steps; i++) {
        const both = fingers(from + ((to - from) * i) / steps);
        both[0].y = first.y;
        both[1].y = first.y;
        await send("touchMove", both);
      }
      await send("touchEnd", []);
    },
    /**
     * Drags a pen, as Chromium has it from a pen tablet: trusted Pointer
     * Events with `pointerType: "pen"`.
     *
     * @param {{ x: number, y: number }[]} points
     */
    async pen(points) {
      const pen = { button: "left", pointerType: "pen", force: 0.5 };
      await session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        ...points[0],
        ...pen,
        buttons: 1,
        clickCount: 1,
      });
      for (const point of points.slice(1)) {
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          ...point,
          ...pen,
          buttons: 1,
        });
      }
      const last = /** @type {{ x: number, y: number }} */ (points.at(-1));
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        ...last,
        ...pen,
        buttons: 0,
        clickCount: 1,
      });
    },
  };
}

/**
 * @param {Frame} frame
 * @param {[number, number]} at shares of the width and height of the
 *   viewer's container, which shows the pages
 * @returns {Promise<{ x: number, y: number }>} that place in the page
 */
export async function inViewer(frame, [x, y]) {
  // Playwright gives a frame's elements' boxes in the page's viewport.
  const box = /** @type {{ x: number, y: number, width: number, height: number }} */ (
    await frame.locator("#viewerContainer").boundingBox()
  );
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}
