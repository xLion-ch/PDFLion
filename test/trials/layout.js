/**
 * Safe areas: shows env(safe-area-inset-*) as red bands at the edges, and
 * the rest outlined, so that one can see whether the window controls of an
 * iPadOS 26 window, or anything else, cover what the insets leave. It
 * reports the insets with the window's size whenever they change.
 */
import { element, report } from "./trials.js";

const SIDES = ["top", "right", "bottom", "left"];

/** @param {HTMLElement} main */
export async function run(main) {
  // Padding of env() is the only way to read the insets.
  const probe = element("div", {});
  probe.style.cssText =
    "position: fixed; visibility: hidden; padding: env(safe-area-inset-top) " +
    "env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
  const bands = Object.fromEntries(
    SIDES.map((side) => [side, element("div", { className: "inset" })]),
  );
  const values = element("pre");
  main.append(
    element("p", {
      textContent:
        "Resize the window to its smallest, move it, rotate the iPad, and try Split View and " +
        "Slide Over. Nothing that matters should sit under the window controls outside the red " +
        "bands.",
    }),
    values,
    probe,
    element("div", { className: "safe" }),
    ...Object.values(bands),
  );

  let last = "";
  let timer = 0;
  const update = () => {
    const style = getComputedStyle(probe);
    /** @type {Record<string, number>} */
    const insets = Object.fromEntries(
      SIDES.map((side) => [side, parseFloat(style.getPropertyValue(`padding-${side}`))]),
    );
    for (const side of SIDES) {
      const band = bands[side];
      const vertical = side === "top" || side === "bottom";
      band.style.cssText = vertical
        ? `${side}: 0; left: 0; right: 0; height: ${insets[side]}px`
        : `${side}: 0; top: 0; bottom: 0; width: ${insets[side]}px`;
    }
    const result = {
      insets,
      window: `${innerWidth}×${innerHeight}`,
      visualViewport: visualViewport
        ? `${Math.round(visualViewport.width)}×${Math.round(visualViewport.height)}`
        : null,
      screen: `${screen.width}×${screen.height}`,
      orientation: screen.orientation?.type ?? null,
    };
    values.textContent = JSON.stringify(result, null, 1);
    const key = JSON.stringify(result);
    if (key === last) return;
    last = key;
    clearTimeout(timer);
    timer = setTimeout(() => report("layout", result), 1000);
  };
  update();
  window.addEventListener("resize", update);
  visualViewport?.addEventListener("resize", update);
  screen.orientation?.addEventListener("change", update);
}
