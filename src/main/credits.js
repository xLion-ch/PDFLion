/**
 * The third-party projects PDFLion is made of and made with, for the About
 * panel. README.md lists the same ones under Credits, and credits.test.js
 * checks that both name the same links. A new dependency goes into both.
 * Kept free of Electron imports so the unit tests can run it under plain Node.
 */

/**
 * @typedef {object} Component
 * @property {string} name
 * @property {string} [by] who makes it
 * @property {string} [license] SPDX identifier where there is one; none for design guidelines
 * @property {string} url the project's home page or repository
 */

/** @type {{ heading: string, components: Component[] }[]} */
export const CREDITS = [
  {
    heading: "Built on",
    components: [
      {
        name: "pdf.js",
        by: "Mozilla",
        license: "Apache-2.0",
        url: "https://github.com/mozilla/pdf.js",
      },
      { name: "Electron", license: "MIT", url: "https://www.electronjs.org" },
      {
        name: "@cantoo/pdf-lib",
        by: "Cantoo",
        license: "MIT",
        url: "https://github.com/cantoo-scribe/pdf-lib",
      },
      {
        name: "Material Symbols",
        by: "Google",
        license: "Apache-2.0",
        url: "https://github.com/google/material-design-icons",
      },
      // The app icon, resources/icon.svg.
      {
        name: "Lion icon",
        by: "SVG Repo",
        license: "public domain",
        url: "https://www.svgrepo.com/svg/484717/lion",
      },
      { name: "Material Design 3", by: "Google", url: "https://m3.material.io" },
      // Its paper size data: which regions get Letter for File > New (blank.js).
      {
        name: "Unicode CLDR",
        by: "Unicode",
        license: "Unicode-3.0",
        url: "https://cldr.unicode.org",
      },
    ],
  },
  {
    // In the pdf.js build: Fluent in web/viewer.mjs, the translations in
    // web/locale/, and the rest as named by the license files in web/wasm/,
    // web/standard_fonts/, web/cmaps/ and web/iccs/.
    heading: "pdf.js includes",
    components: [
      {
        name: "Fluent",
        by: "Mozilla",
        license: "Apache-2.0",
        url: "https://github.com/projectfluent/fluent.js",
      },
      {
        name: "Firefox translations",
        by: "Mozilla's localizers",
        license: "MPL-2.0",
        url: "https://github.com/mozilla-l10n/firefox-l10n",
      },
      { name: "OpenJPEG", license: "BSD-2-Clause", url: "https://github.com/uclouvain/openjpeg" },
      {
        name: "PDFium's JBIG2 decoder and Foxit fonts",
        license: "BSD-3-Clause",
        url: "https://pdfium.googlesource.com/pdfium/",
      },
      {
        name: "qcms",
        by: "Mozilla",
        license: "MIT",
        url: "https://github.com/FirefoxGraphics/qcms",
      },
      {
        name: "QuickJS",
        by: "Fabrice Bellard and Charlie Gordon",
        license: "MIT",
        url: "https://bellard.org/quickjs/",
      },
      {
        name: "Liberation Sans",
        by: "Red Hat",
        license: "GPL-2.0 with font exception",
        url: "https://github.com/liberationfonts/liberation-fonts",
      },
      {
        name: "Adobe CMaps",
        license: "BSD-3-Clause",
        url: "https://github.com/adobe-type-tools/cmap-resources",
      },
      {
        name: "Compact ICC Profiles",
        license: "CC0-1.0",
        url: "https://github.com/saucecontrol/Compact-ICC-Profiles",
      },
    ],
  },
  {
    // Bundled in its browser build, dist/pdf-lib.min.js, as its package.json
    // and the notices in dist/pdf-lib.js name them. It also has code from
    // pdf.js, credited above.
    heading: "@cantoo/pdf-lib includes",
    components: [
      {
        name: "pdf-lib",
        by: "Andrew Dillon",
        license: "MIT",
        url: "https://github.com/Hopding/pdf-lib",
      },
      {
        name: "standard-fonts",
        by: "Andrew Dillon",
        license: "MIT",
        url: "https://github.com/Hopding/standard-fonts",
      },
      {
        name: "fflate",
        by: "Arjun Barrett",
        license: "MIT",
        url: "https://github.com/101arrowz/fflate",
      },
      {
        name: "culori",
        by: "Dan Burzo",
        license: "MIT",
        url: "https://github.com/Evercoder/culori",
      },
      {
        name: "node-html-better-parser",
        license: "MIT",
        url: "https://github.com/Sharcoux/node-html-parser",
      },
      {
        name: "html-entities",
        by: "Marat Dulin",
        license: "MIT",
        url: "https://github.com/mdevils/html-entities",
      },
      {
        name: "tslib",
        by: "Microsoft",
        license: "0BSD",
        url: "https://github.com/microsoft/tslib",
      },
      {
        name: "UPNG.js and UZIP.js",
        by: "Photopea",
        license: "MIT",
        url: "https://github.com/photopea/UPNG.js",
      },
      {
        name: "base64-arraybuffer",
        by: "Niklas von Hertzen",
        license: "MIT",
        url: "https://github.com/niklasvh/base64-arraybuffer",
      },
      {
        name: "PDFKit's path drawing",
        by: "Devon Govett",
        license: "MIT",
        url: "https://github.com/foliojs/pdfkit",
      },
    ],
  },
  {
    heading: "Electron includes",
    components: [
      { name: "Chromium", license: "BSD-3-Clause", url: "https://www.chromium.org" },
      { name: "Node.js", license: "MIT", url: "https://nodejs.org" },
    ],
  },
  {
    heading: "Built and tested with",
    components: [
      { name: "electron-builder", license: "MIT", url: "https://www.electron.build" },
      { name: "NSIS", license: "Zlib", url: "https://nsis.sourceforge.io" },
      {
        name: "fpm",
        by: "Jordan Sissel",
        license: "MIT",
        url: "https://github.com/jordansissel/fpm",
      },
      { name: "Playwright", by: "Microsoft", license: "Apache-2.0", url: "https://playwright.dev" },
      // The steps of .github/workflows/ci.yml that aren't commands.
      {
        name: "actions/checkout, setup-node, cache, upload-artifact and download-artifact",
        by: "GitHub",
        license: "MIT",
        url: "https://github.com/actions",
      },
      // The virtual display CI's Linux end-to-end tests run on.
      {
        name: "Xvfb",
        by: "X.Org",
        license: "MIT",
        url: "https://gitlab.freedesktop.org/xorg/xserver",
      },
    ],
  },
];

/**
 * The About panel's credits: a line with each component's name, maker and
 * license, then its link, grouped under headings.
 *
 * @param {Record<string, string | null>} versions versions to show, by component name
 * @returns {string}
 */
export function creditsText(versions) {
  return CREDITS.map(({ heading, components }) =>
    [
      `${heading}:`,
      ...components.flatMap(({ name, by, license, url }) => {
        const version = versions[name];
        const title = `${name}${version ? ` ${version}` : ""}${by ? ` by ${by}` : ""}`;
        return [license ? `${title} (${license})` : title, url];
      }),
    ].join("\n"),
  ).join("\n\n");
}
