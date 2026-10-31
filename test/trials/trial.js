/** One trial's page: trial.html?name=<name> runs <name>.js. */
import { TRIALS, start } from "./trials.js";

const name = new URLSearchParams(location.search).get("name");
const trial = TRIALS.find((candidate) => candidate.name === name);
if (!trial) {
  location.replace("./");
} else {
  document.title = `${trial.title} – PDFLion trials`;
  document.body.classList.add(`trial-${trial.name}`);
  /** @type {HTMLElement} */ (document.getElementById("title")).textContent = trial.title;
  /** @type {HTMLElement} */ (document.getElementById("about")).textContent = trial.about;
  await start();
  const { run } = await import(`./${trial.name}.js`);
  await run(/** @type {HTMLElement} */ (document.getElementById("trial")));
}
