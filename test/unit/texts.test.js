import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import "../../src/shared/texts.js";
import { language, list, setLanguage, t } from "../../src/shared/i18n.js";
import { CANCEL, SAVE, importSettingsPrompt, savePrompt } from "../../src/shared/wording.js";

const { TEXTS, pick, namesIn, translator } = /** @type {any} */ (globalThis).PDFLionTexts;

describe("texts", () => {
  afterEach(() => setLanguage([]));

  it("has every text in every language, naming the same values", () => {
    const ids = Object.keys(TEXTS.en).sort();
    for (const [language, texts] of Object.entries(TEXTS)) {
      assert.deepEqual(Object.keys(texts).sort(), ids, language);
      for (const id of ids) {
        assert.deepEqual(namesIn(texts[id]), namesIn(TEXTS.en[id]), `${language} ${id}`);
        assert.ok(texts[id].trim() !== "", `${language} ${id}`);
      }
    }
  });

  it("keeps an access key in every menu label, and one only", () => {
    for (const [language, texts] of Object.entries(TEXTS)) {
      for (const id of ["menuFile", "menuEdit", "menuView", "menuHelp", "menuOpen", "menuSave"]) {
        assert.equal(texts[id].replaceAll("&&", "").split("&").length, 2, `${language} ${id}`);
      }
    }
  });

  it("picks the first language it has, by region first, and English otherwise", () => {
    assert.equal(pick(["de-DE", "en"]), "de");
    assert.equal(pick(["de-CH"]), "de-ch");
    assert.equal(pick(["gsw", "fr_CH", "de"]), "fr");
    assert.equal(pick(["it-IT"]), "it");
    assert.equal(pick(["es", "ja"]), "en");
    assert.equal(pick([]), "en");
    assert.equal(pick([null, 3, "it"]), "it");
  });

  it("writes Swiss German with ss for ß", () => {
    const swiss = translator(["de-CH"]);
    assert.equal(swiss("close"), "Schliessen");
    assert.equal(translator(["de-AT"])("close"), "Schließen");
    assert.equal(swiss.locale, "de-CH");
  });

  it("fills in the values it names, and leaves others as they are", () => {
    const english = translator(["en-GB"]);
    assert.equal(english("closeNamed", { name: "a {b}.pdf" }), "Close a {b}.pdf");
    assert.equal(english("closeNamed"), "Close {name}");
    assert.throws(() => english("noSuchText"), /no text noSuchText/);
  });

  it("gives wording.js's texts and buttons in the language set", () => {
    setLanguage(["fr-FR"]);
    assert.equal(language(), "fr");
    assert.equal(SAVE, "Enregistrer");
    assert.equal(CANCEL, "Annuler");
    assert.equal(
      savePrompt("a.pdf").message,
      "Voulez-vous enregistrer les modifications apportées au document « a.pdf » ?",
    );
    setLanguage(["de"]);
    assert.equal(SAVE, "Speichern");
    assert.equal(list(["a", "b", "c"]), "a, b und c");
    assert.equal(
      importSettingsPrompt("x.json", { replaced: ["eraser", "penOnly"], added: 2 }).detail,
      "Ihre Einstellungen für Radierer und Stift werden ersetzt, und ihre 2 Favoriten, die Sie noch nicht haben, werden nach Ihren hinzugefügt.",
    );
    setLanguage(["it"]);
    assert.equal(t("menuFile"), "&File");
  });
});
