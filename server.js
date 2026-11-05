import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3780;
const publicDir = path.resolve(__dirname, "public");
const dataDir = process.env.DATA_DIR || path.join(__dirname, "data");
const stateFile = path.join(dataDir, "state.json");

const SITE_TTL_MS = 12_000;
const AGENT_TTL_MS = 10_000;
const MOUSE_BUTTONS = new Set(["Left", "Right", "Middle", "X1", "X2"]);

const BLOCKED_CODES = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

let state = { total: 0, last: null, users: {} };
const clients = new Set();

function load() {
  fs.mkdirSync(dataDir, { recursive: true });
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (!data || typeof data.users !== "object" || data.users === null) {
      throw new Error("bad");
    }
    state = {
      total: 0,
      last: data.last || null,
      users: data.users,
    };
    recompute();
  } catch (err) {
    if (err.code !== "ENOENT") {
      try {
        fs.copyFileSync(stateFile, stateFile + ".bak");
      } catch {
        // nothing readable to keep
      }
      console.error("État illisible. Une copie .bak a été gardée, le compteur repart de zéro.");
    }
    state = { total: 0, last: null, users: {} };
  }
}

function recompute() {
  let total = 0;
  for (const user of Object.values(state.users)) {
    user.taps = Number(user.taps) || 0;
    user.lastSeen = Number(user.lastSeen) || 0;
    user.agentSeen = Number(user.agentSeen) || 0;
    user.lastTapAt = Number(user.lastTapAt) || 0;
    total += user.taps;
  }
  state.total = total;
}

let saveTimer = null;

function save() {
  fs.mkdirSync(dataDir, { recursive: true });
  const json = JSON.stringify(state);
  const tmp = stateFile + ".tmp";
  try {
    fs.writeFileSync(tmp, json);
    fs.rmSync(stateFile, { force: true });
    fs.renameSync(tmp, stateFile);
  } catch (err) {
    try {
      fs.writeFileSync(stateFile, json);
    } catch {
      console.error("Sauvegarde impossible:", err.message);
    }
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, 40);
  saveTimer.unref?.();
}

function pseudoKey(pseudo) {
  return pseudo.toLocaleLowerCase("fr");
}

function cleanPseudo(raw) {
  if (typeof raw !== "string") return null;
  const pseudo = raw.trim().replace(/\s+/g, " ");
  if (pseudo.length < 2 || pseudo.length > 16) return null;
  if (!/^[\p{L}\p{N} _-]+$/u.test(pseudo)) return null;
  return pseudo;
}

function findByPseudo(pseudo) {
  const key = pseudoKey(pseudo);
  return Object.entries(state.users).find(([, user]) => user.pseudoKey === key) || null;
}

function cleanBinding(input) {
  if (!input || typeof input !== "object") return null;
  const kind = input.kind;
  const value = input.value;
  if (typeof value !== "string" || value.length < 1 || value.length > 24) return null;
  if (kind === "mouse") {
    if (!MOUSE_BUTTONS.has(value)) return null;
    return { kind, value };
  }
  if (kind === "char") {
    if ([...value].length !== 1) return null;
    return { kind, value: value.toLowerCase() };
  }
  if (kind === "code") {
    if (!/^[A-Za-z0-9]+$/.test(value) || BLOCKED_CODES.has(value)) return null;
    return { kind, value };
  }
  return null;
}

function lanUrls() {
  const urls = [];
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const net of list || []) {
        if (net.family === "IPv4" && !net.internal) {
          urls.push(`http://${net.address}:${PORT}`);
        }
      }
    }
  } catch {
    // no network info
  }
  return urls;
}

function publicState() {
  const now = Date.now();
  const players = Object.values(state.users).map((user) => ({
    pseudo: user.pseudo,
    taps: user.taps,
    onSite: now - user.lastSeen < SITE_TTL_MS,
    inGame: now - user.agentSeen < AGENT_TTL_MS,
  }));
  players.sort((a, b) => {
    const aOn = a.inGame || a.onSite ? 1 : 0;
    const bOn = b.inGame || b.onSite ? 1 : 0;
    if (aOn !== bOn) return bOn - aOn;
    if (a.taps !== b.taps) return b.taps - a.taps;
    return a.pseudo.localeCompare(b.pseudo, "fr");
  });
  return {
    total: state.total,
    last: state.last ? { pseudo: state.last.pseudo, at: state.last.at } : null,
    players,
    lan: lanUrls(),
  };
}

function payload(user) {
  return {
    ...publicState(),
    you: {
      pseudo: user.pseudo,
      taps: user.taps,
      binding: user.binding || null,
    },
  };
}

function broadcast(view = publicState()) {
  const chunk = `data: ${JSON.stringify(view)}\n\n`;
  for (const res of clients) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 100_000) {
        reject(new Error("json"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("json"));
      }
    });
    req.on("error", () => reject(new Error("json")));
  });
}

function tokenFrom(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+([A-Za-z0-9_-]+)$/.exec(header);
  if (!match) return null;
  return state.users[match[1]] ? match[1] : null;
}

function requireUser(req, res) {
  const token = tokenFrom(req);
  if (!token) {
    send(res, 401, { error: "Entre ton pseudo pour continuer." });
    return null;
  }
  return { token, user: state.users[token] };
}

async function handleApi(req, res, pathname) {
  if (req.method === "GET" && pathname === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    res.write(`data: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    send(res, 200, publicState());
    return;
  }

  if (req.method === "GET" && pathname === "/api/me") {
    const session = requireUser(req, res);
    if (!session) return;
    send(res, 200, payload(session.user));
    return;
  }

  if (req.method !== "POST") {
    send(res, 404, { error: "Introuvable." });
    return;
  }

  const body = await readBody(req);

  if (pathname === "/api/join") {
    const pseudo = cleanPseudo(body.pseudo);
    if (!pseudo) {
      send(res, 400, { error: "Choisis un pseudo de 2 à 16 caractères." });
      return;
    }
    if (findByPseudo(pseudo)) {
      send(res, 409, { error: "Ce pseudo est déjà pris." });
      return;
    }
    const token = crypto.randomBytes(18).toString("base64url");
    const now = Date.now();
    state.users[token] = {
      pseudo,
      pseudoKey: pseudoKey(pseudo),
      taps: 0,
      binding: null,
      lastSeen: now,
      agentSeen: 0,
      lastTapAt: 0,
    };
    save();
    broadcast();
    send(res, 200, { token, ...payload(state.users[token]) });
    return;
  }

  const session = requireUser(req, res);
  if (!session) return;
  const { user } = session;

  if (pathname === "/api/pseudo") {
    const pseudo = cleanPseudo(body.pseudo);
    if (!pseudo) {
      send(res, 400, { error: "Choisis un pseudo de 2 à 16 caractères." });
      return;
    }
    const taken = findByPseudo(pseudo);
    if (taken && taken[0] !== session.token) {
      send(res, 409, { error: "Ce pseudo est déjà pris." });
      return;
    }
    if (state.last && state.last.pseudo === user.pseudo) {
      state.last.pseudo = pseudo;
    }
    user.pseudo = pseudo;
    user.pseudoKey = pseudoKey(pseudo);
    user.lastSeen = Date.now();
    save();
    broadcast();
    send(res, 200, payload(user));
    return;
  }

  if (pathname === "/api/bind") {
    const binding = cleanBinding(body.binding);
    if (!binding) {
      send(res, 400, { error: "Cette touche ne peut pas être utilisée." });
      return;
    }
    user.binding = binding;
    user.lastSeen = Date.now();
    save();
    broadcast();
    send(res, 200, payload(user));
    return;
  }

  if (pathname === "/api/reset") {
    for (const player of Object.values(state.users)) player.taps = 0;
    state.total = 0;
    state.last = null;
    user.lastSeen = Date.now();
    const view = publicState();
    broadcast(view);
    send(res, 200, {
      ...view,
      you: {
        pseudo: user.pseudo,
        taps: user.taps,
        binding: user.binding || null,
      },
    });
    scheduleSave();
    return;
  }

  if (pathname === "/api/heartbeat") {
    const now = Date.now();
    user.lastSeen = now;
    if (body.source === "agent") user.agentSeen = now;
    send(res, 200, payload(user));
    return;
  }

  if (pathname === "/api/tap") {
    if (!user.binding) {
      send(res, 400, { error: "Choisis d'abord une touche." });
      return;
    }
    let count = Number(body.count);
    if (!Number.isInteger(count) || count < 1) count = 1;
    if (count > 100) count = 100;
    const now = Date.now();
    user.taps += count;
    user.lastTapAt = now;
    user.lastSeen = now;
    if (body.source === "agent") user.agentSeen = now;
    state.total += count;
    state.last = { pseudo: user.pseudo, at: now };
    const view = publicState();
    broadcast(view);
    send(res, 200, {
      ...view,
      you: {
        pseudo: user.pseudo,
        taps: user.taps,
        binding: user.binding || null,
      },
    });
    scheduleSave();
    return;
  }

  send(res, 404, { error: "Introuvable." });
}

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const file = path.resolve(publicDir, "." + decoded);
  if (file !== publicDir && !file.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end("Introuvable");
      return;
    }
    const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": type,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

function openBrowser(url) {
  if (process.env.NO_OPEN === "1" || process.env.RENDER === "true" || process.platform !== "win32") return;
  try {
    spawn("cmd", ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch {
    // the address is already printed in the console
  }
}

load();

let presenceSig = "";
setInterval(() => {
  const view = publicState();
  const sig = view.players.map((player) => `${player.pseudo}:${player.onSite}:${player.inGame}`).join("|");
  if (sig === presenceSig) return;
  presenceSig = sig;
  broadcast(view);
}, 3000).unref?.();

const server = http.createServer((req, res) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url, "http://localhost").pathname;
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  if (pathname === "/download/agent.py" && req.method === "GET") {
    fs.readFile(path.join(__dirname, "agent", "agent.py"), (err, data) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="agent.py"',
      });
      res.end(data);
    });
    return;
  }
  if (pathname.startsWith("/api/")) {
    handleApi(req, res, pathname).catch((err) => {
      if (res.headersSent) return;
      if (err.message === "json") send(res, 400, { error: "Message illisible." });
      else send(res, 500, { error: "Erreur serveur." });
    });
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  serveStatic(req, res, pathname);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Le port ${PORT} est déjà utilisé. Le compteur tourne peut-être déjà.`);
  } else {
    console.error(err.message);
  }
  process.exit(1);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("");
  console.log("Compteur infini");
  console.log(`Cet ordinateur : http://localhost:${PORT}`);
  for (const url of lanUrls()) console.log(`Les autres      : ${url}`);
  console.log("Laisse cette fenêtre ouverte.");
  console.log("");
  openBrowser(`http://localhost:${PORT}`);
});
