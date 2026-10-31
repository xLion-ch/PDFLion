/** The list of trials, what the device is, and whether the service worker keeps everything. */
import { TRIALS, device, element, start, workerBuild } from "./trials.js";

const registration = await start();

const list = /** @type {HTMLElement} */ (document.getElementById("trials"));
for (const { name, title, answers, about } of TRIALS) {
  list.append(
    element("li", {}, [
      element("a", { href: `trial.html?name=${name}`, textContent: title }),
      element("p", { textContent: about }),
      element("p", { className: "answers", textContent: `Answers: ${answers}` }),
    ]),
  );
}

const details = /** @type {HTMLElement} */ (document.getElementById("device"));
async function showDevice() {
  const build = await workerBuild();
  const entries = {
    ...device(),
    "service worker": registration
      ? build
        ? `build ${build.id}, ${build.kept} of ${build.files} files kept`
        : "installing"
      : "none",
    online: navigator.onLine,
  };
  details.replaceChildren(
    ...Object.entries(entries).flatMap(([key, value]) => [
      element("dt", { textContent: key }),
      element("dd", { textContent: String(value) }),
    ]),
  );
}
await showDevice();
navigator.serviceWorker?.addEventListener("controllerchange", showDevice);
