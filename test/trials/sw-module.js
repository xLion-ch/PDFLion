/**
 * Whether the browser takes a module service worker, which could import the
 * modules main uses, such as ranges.js. features.js registers it at a scope
 * of its own, asks it once, and unregisters it.
 */
import { answerRange } from "./ranges.js";

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("message", (event) => {
  event.ports[0]?.postMessage({ imported: typeof answerRange === "function" });
});
