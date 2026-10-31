#!/usr/bin/env node
/**
 * Serves a folder at /PDFLion/ the way GitHub Pages serves the web app at
 * https://xlion-ch.github.io/PDFLion/: below the same path, with its caching
 * (`max-age=600` and validators), byte ranges, redirects and 404 page, and
 * none of the app's own headers, since Pages sends none. Unlike Pages, it
 * doesn't compress. For the web app's tests, and for trying it in the iOS
 * Simulator, which reaches the Mac at localhost, or on an iPad, which needs
 * --https for its service worker. Plain Node, like the other scripts.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { answerRange } from "../src/main/ranges.js";
import { resolveInside } from "../src/main/routes.js";

const USAGE = `Usage:
  node scripts/serve-web.js [options] [folder]   (npm run web:serve -- [options] [folder])

Serves folder, dist/web by default, at http://localhost:8080/PDFLion/, as
GitHub Pages serves the web app.

  --port <n>         another port than 8080
  --host <address>   listen there rather than on localhost, such as 0.0.0.0
                     for every network interface
  --https            HTTPS, for an iPad, on every network interface unless
                     --host says otherwise. The certificate is made with
                     openssl the first time and whenever the Mac's name
                     changes, and kept in ~/.pdflion-web-server/. The iPad
                     downloads it from /certificate.crt (see README).
  --report <file>    take results, which the trials POST to /PDFLion/report,
                     and add each to file as a line of JSON`;

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");

/** Where the web app is, below the server's root, as on GitHub Pages. */
export const BASE = "/PDFLion/";

/** GitHub Pages' caching, for every file. */
const CACHE_CONTROL = "max-age=600";

/** The most a trial's report may hold. */
const MAX_REPORT_SIZE = 1024 * 1024;

/**
 * What GitHub Pages sends the app's files as, by extension. Anything else
 * goes as `application/octet-stream`, as Pages sends pdf.js's `.bcmap` files.
 * @type {Record<string, string>}
 */
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".ftl": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".pfb": "application/x-font-type1",
  ".icc": "application/vnd.iccprofile",
};

/** Where --https keeps its key and certificate. */
const CERTIFICATE_DIR = path.join(os.homedir(), ".pdflion-web-server");

/**
 * What the certificate may vouch for: its own names and the addresses of
 * home and office networks. It's a root an iPad trusts, so these name
 * constraints keep its key from vouching for any other site, should it leak.
 */
const PERMITTED_NAMES = [
  "DNS:localhost",
  "DNS:local",
  "IP:127.0.0.0/255.0.0.0",
  "IP:10.0.0.0/255.0.0.0",
  "IP:172.16.0.0/255.240.0.0",
  "IP:192.168.0.0/255.255.0.0",
];

/**
 * @typedef {object} ServeOptions
 * @property {string} root the folder to serve at /PDFLion/
 * @property {number} [port] 0 for any free port
 * @property {string} [host]
 * @property {boolean} [https]
 * @property {string | null} [report] the file to add the trials' results to
 */

/**
 * Starts serving.
 *
 * @param {ServeOptions} options
 * @returns {Promise<{ server: http.Server, urls: string[], certificate: string | null }>}
 *   the URLs of /PDFLion/, and with --https the certificate's file, for the iPad
 */
export async function serve({ root, port = 8080, host, https: secure = false, report = null }) {
  const handler = requestHandler(path.resolve(root), report);
  const certificate = secure ? ensureCertificate() : null;
  const server = certificate
    ? https.createServer({ key: certificate.key, cert: certificate.cert }, (request, response) =>
        request.url === "/certificate.crt"
          ? sendCertificate(response, certificate.der)
          : handler(request, response),
      )
    : http.createServer(handler);

  const address = host ?? (secure ? "0.0.0.0" : "localhost");
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, address, () => resolve(undefined));
  });
  const { port: actualPort } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const scheme = secure ? "https" : "http";
  const hosts = address === "0.0.0.0" || address === "::" ? [...networkNames()] : [address];
  return {
    server,
    urls: hosts.map((name) => `${scheme}://${name}:${actualPort}${BASE}`),
    certificate: certificate ? path.join(CERTIFICATE_DIR, "certificate.crt") : null,
  };
}

/**
 * @param {string} root absolute
 * @param {string | null} report
 * @returns {http.RequestListener}
 */
function requestHandler(root, report) {
  return (request, response) => {
    respond(root, report, request, response).catch((error) => {
      console.error(error);
      if (response.headersSent) response.destroy();
      else send(response, 500, "Internal server error");
    });
  };
}

/**
 * @param {string} root
 * @param {string | null} report
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 */
async function respond(root, report, request, response) {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (report && url.pathname === `${BASE}report`) {
    await takeReport(request, response, report);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    send(response, 405, "Method not allowed");
    return;
  }
  if (url.pathname === BASE.slice(0, -1)) {
    redirect(response, `${BASE}${url.search}`);
    return;
  }
  if (!url.pathname.startsWith(BASE)) {
    await notFound(root, request, response);
    return;
  }

  const rest = url.pathname.slice(BASE.length);
  const file = resolveInside(root, rest.endsWith("/") || rest === "" ? `${rest}index.html` : rest);
  const stats = file ? await fsp.stat(file).catch(() => null) : null;
  if (stats?.isDirectory()) {
    redirect(response, `${url.pathname}/${url.search}`);
    return;
  }
  if (!file || !stats?.isFile()) {
    await notFound(root, request, response);
    return;
  }
  sendFile(request, response, file, stats, 200);
}

/**
 * Sends a file, whole or a byte range of it, or 304 if the browser has it.
 *
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {string} file
 * @param {fs.Stats} stats
 * @param {number} status 200, or 404 for the 404 page
 */
function sendFile(request, response, file, stats, status) {
  const etag = `"${Math.trunc(stats.mtimeMs).toString(16)}-${stats.size.toString(16)}"`;
  response.setHeader(
    "Content-Type",
    CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
  );
  response.setHeader("Cache-Control", CACHE_CONTROL);
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (status === 200) {
    response.setHeader("ETag", etag);
    response.setHeader("Last-Modified", stats.mtime.toUTCString());
    response.setHeader("Accept-Ranges", "bytes");
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304).end();
      return;
    }
  }

  const range =
    status === 200 ? answerRange(request.headers.range ?? null, stats.size) : { status: 200 };
  if (range.status === 416) {
    response.setHeader("Content-Range", `bytes */${stats.size}`);
    send(response, 416, "Range not satisfiable");
    return;
  }
  const { start, end } = range.status === 206 ? range : { start: 0, end: stats.size - 1 };
  if (range.status === 206) {
    response.setHeader("Content-Range", `bytes ${start}-${end}/${stats.size}`);
  }
  response.setHeader("Content-Length", String(end - start + 1));
  response.writeHead(range.status === 206 ? 206 : status);
  if (request.method === "HEAD" || stats.size === 0) {
    response.end();
    return;
  }
  fs.createReadStream(file, { start, end })
    .on("error", () => response.destroy())
    .pipe(response);
}

/**
 * Sends the folder's 404.html, as Pages does, or a plain 404.
 *
 * @param {string} root
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 */
async function notFound(root, request, response) {
  const page = path.join(root, "404.html");
  const stats = await fsp.stat(page).catch(() => null);
  if (stats?.isFile()) sendFile(request, response, page, stats, 404);
  else send(response, 404, "Not found");
}

/**
 * @param {http.ServerResponse} response
 * @param {string} location
 */
function redirect(response, location) {
  response.setHeader("Location", location);
  response.setHeader("Cache-Control", CACHE_CONTROL);
  send(response, 301, "Moved permanently");
}

/**
 * @param {http.ServerResponse} response
 * @param {number} status
 * @param {string} text
 */
function send(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" }).end(`${text}\n`);
}

/**
 * Adds a trial's result to the report file. Each is a JSON object, which the
 * file gets with the time and the sender's address.
 *
 * @param {http.IncomingMessage} request
 * @param {http.ServerResponse} response
 * @param {string} file
 */
async function takeReport(request, response, file) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    send(response, 405, "Method not allowed");
    return;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REPORT_SIZE) {
      send(response, 413, "Too large");
      return;
    }
    chunks.push(chunk);
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    result = null;
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    send(response, 400, "Not a JSON object");
    return;
  }
  const line = {
    received: new Date().toISOString(),
    from: request.socket.remoteAddress,
    ...result,
  };
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.appendFile(file, `${JSON.stringify(line)}\n`);
  console.log(`${line.received}  ${line.from}  ${result.trial ?? "?"}: ${summary(result.data)}`);
  response.writeHead(204).end();
}

/**
 * @param {unknown} data
 * @returns {string} the start of it, for the console
 */
function summary(data) {
  const text = JSON.stringify(data) ?? "";
  return text.length > 160 ? `${text.slice(0, 159)}…` : text;
}

/**
 * @param {http.ServerResponse} response
 * @param {Buffer} der
 */
function sendCertificate(response, der) {
  // The type that has Safari offer to install it as a profile.
  response.writeHead(200, {
    "Content-Type": "application/x-x509-ca-cert",
    "Content-Disposition": 'attachment; filename="PDFLion web server.crt"',
    "Content-Length": String(der.length),
  });
  response.end(der);
}

/**
 * @returns {Set<string>} the names an iPad on the same network can reach this
 *   Mac at: its Bonjour name, then its IPv4 addresses
 */
function networkNames() {
  const names = new Set([localHostName()]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const { family, internal, address } of addresses ?? []) {
      if (family === "IPv4" && !internal) names.add(address);
    }
  }
  return names;
}

/** @returns {string} such as `Claudios-MacBook-Air.local` */
function localHostName() {
  if (process.platform === "darwin") {
    const name = execFileSync("scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim();
    return `${name}.local`;
  }
  const name = os.hostname();
  return name.endsWith(".local") ? name : `${name}.local`;
}

/**
 * The key and certificate for --https, made with openssl unless one covering
 * this Mac's name is there already. The certificate is its own root, which
 * an iPad trusts once it's installed as a profile and fully trusted. Apple's
 * rules for TLS certificates ask for at most 825 days, a SAN, and serverAuth.
 *
 * @returns {{ key: Buffer, cert: Buffer, der: Buffer }}
 */
function ensureCertificate() {
  const keyFile = path.join(CERTIFICATE_DIR, "key.pem");
  const certFile = path.join(CERTIFICATE_DIR, "certificate.pem");
  const derFile = path.join(CERTIFICATE_DIR, "certificate.crt");
  const namesFile = path.join(CERTIFICATE_DIR, "names.json");
  const hostName = localHostName();

  /** @type {string[]} */
  let names = [];
  try {
    names = JSON.parse(fs.readFileSync(namesFile, "utf8"));
  } catch {
    // none yet
  }
  if (!names.includes(`DNS:${hostName}`) || !fs.existsSync(derFile)) {
    names = [
      "DNS:localhost",
      `DNS:${hostName}`,
      "IP:127.0.0.1",
      ...[...networkNames()].filter((name) => name !== hostName).map((ip) => `IP:${ip}`),
    ];
    fs.mkdirSync(CERTIFICATE_DIR, { recursive: true, mode: 0o700 });
    const config = path.join(CERTIFICATE_DIR, "openssl.cnf");
    const constraints = PERMITTED_NAMES.map((name) => `permitted;${name}`).join(", ");
    fs.writeFileSync(
      config,
      [
        "[req]",
        "distinguished_name = dn",
        "prompt = no",
        "[dn]",
        `CN = PDFLion web server on ${hostName}`,
        "[ext]",
        "basicConstraints = critical, CA:TRUE, pathlen:0",
        "keyUsage = critical, digitalSignature, keyEncipherment, keyCertSign",
        "extendedKeyUsage = serverAuth",
        `subjectAltName = ${names.join(", ")}`,
        `nameConstraints = critical, ${constraints}`,
        "subjectKeyIdentifier = hash",
        "",
      ].join("\n"),
    );
    // A new key, which only this user can read.
    fs.rmSync(keyFile, { force: true });
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825"],
        ...["-config", config, "-extensions", "ext", "-keyout", keyFile, "-out", certFile],
      ],
      // Its progress dots, which an error shows anyway.
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    fs.chmodSync(keyFile, 0o600);
    execFileSync("openssl", ["x509", "-in", certFile, "-outform", "der", "-out", derFile]);
    fs.writeFileSync(namesFile, `${JSON.stringify(names)}\n`);
    console.log(`Made a new certificate for ${names.join(", ")}. An iPad must trust it again.`);
  }
  return {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
    der: fs.readFileSync(derFile),
  };
}

/** @param {string[]} args the command line, without node and the script */
async function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      https: { type: "boolean" },
      report: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return;
  }
  if (positionals.length > 1) throw new Error(`one folder at most\n\n${USAGE}`);
  const port = values.port === undefined ? 8080 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${values.port} isn't a port`);
  }
  const root = path.resolve(positionals[0] ?? path.join(ROOT, "dist", "web"));
  if (!fs.existsSync(path.join(root, "index.html"))) {
    throw new Error(`${root} has no index.html to serve`);
  }

  const { urls, certificate } = await serve({
    root,
    port,
    host: values.host,
    https: values.https ?? false,
    report: values.report ? path.resolve(values.report) : null,
  });
  console.log(`Serving ${path.relative(process.cwd(), root) || "."} at`);
  for (const url of urls) console.log(`  ${url}`);
  if (certificate) {
    console.log(`An iPad gets the certificate from ${new URL("/certificate.crt", urls[0])}`);
    console.log(`(or AirDrop ${certificate}), then trusts it in Settings (see README).`);
  }
  if (values.report) console.log(`Results go to ${path.relative(process.cwd(), values.report)}.`);
  console.log("Ctrl+C stops.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`error: ${/** @type {Error} */ (error).message}`);
    process.exit(1);
  });
}
