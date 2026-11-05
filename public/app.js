const TOKEN_KEY = "compteur-infini-token";

const BLOCKED = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
]);

const CODE_KEYS = new Set([
  "Space",
  "Enter",
  "Tab",
  "Escape",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
  "Pause",
]);

const CODE_LABELS = {
  Space: "espace",
  Enter: "entrée",
  Tab: "tab",
  Escape: "échap",
  Backspace: "retour",
  Delete: "suppr",
  Insert: "inser",
  Home: "début",
  End: "fin",
  PageUp: "page haut",
  PageDown: "page bas",
  ArrowUp: "haut",
  ArrowDown: "bas",
  ArrowLeft: "gauche",
  ArrowRight: "droite",
  CapsLock: "verr maj",
  NumLock: "verr num",
  ScrollLock: "arrêt défil",
  PrintScreen: "impr écran",
  Pause: "pause",
};

const numberFormat = new Intl.NumberFormat("fr-FR");

const gate = document.querySelector("#gate");
const app = document.querySelector("#app");
const joinForm = document.querySelector("#join-form");
const pseudoInput = document.querySelector("#pseudo");
const joinError = document.querySelector("#join-error");
const who = document.querySelector("#who");
const renameForm = document.querySelector("#rename-form");
const renameInput = document.querySelector("#rename");
const totalEl = document.querySelector("#total");
const mineEl = document.querySelector("#mine");
const lastEl = document.querySelector("#last");
const keyLabel = document.querySelector("#key-label");
const bindButton = document.querySelector("#bind");
const bindHint = document.querySelector("#bind-hint");
const agentStatus = document.querySelector("#agent-status");
const agentCmd = document.querySelector("#agent-cmd");
const copyCmd = document.querySelector("#copy-cmd");
const copyToken = document.querySelector("#copy-token");
const downloadBat = document.querySelector("#download-bat");
const playersEl = document.querySelector("#players");
const onlineEl = document.querySelector("#online");
const share = document.querySelector("#share");
const lanEl = document.querySelector("#lan");

let token = localStorage.getItem(TOKEN_KEY) || "";
let me = null;
let view = null;
let bindMode = false;
let saving = false;
let shownTotal = null;
let stream = null;
let rosterSig = "";

function format(n) {
  return numberFormat.format(n);
}

function bindingLabel(binding) {
  if (!binding) return "aucune";
  if (binding.kind === "mouse") {
    const names = {
      Left: "clic gauche",
      Right: "clic droit",
      Middle: "clic molette",
      X1: "souris latérale 1",
      X2: "souris latérale 2",
    };
    return names[binding.value] || binding.value;
  }
  if (binding.kind === "char") {
    return binding.value === " " ? "espace" : binding.value.toUpperCase();
  }
  if (binding.value.startsWith("Numpad")) return binding.value.replace("Numpad", "pavé ");
  if (/^F\d+$/.test(binding.value)) return binding.value;
  return CODE_LABELS[binding.value] || binding.value;
}

function toBinding(event) {
  if (event.code === "NumpadEnter") return { kind: "code", value: "Enter" };
  if (
    event.code.startsWith("Numpad") ||
    /^F\d{1,2}$/.test(event.code) ||
    CODE_KEYS.has(event.code)
  ) {
    return { kind: "code", value: event.code };
  }
  if (event.key && [...event.key].length === 1) {
    return { kind: "char", value: event.key.toLowerCase() };
  }
  return { kind: "code", value: event.code };
}

function eventMatches(event, binding) {
  if (!binding || binding.kind === "mouse") return false;
  if (binding.kind === "code") return event.code === binding.value;
  return (
    event.key.toLowerCase() === binding.value &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Le serveur n'a pas répondu.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function showError(node, message) {
  node.hidden = !message;
  node.textContent = message || "";
}

function showGate() {
  gate.hidden = false;
  app.hidden = true;
  document.title = "Compteur infini";
}

function showApp() {
  gate.hidden = true;
  app.hidden = false;
  render();
}

function applySession(data) {
  view = data;
  if (data.you) {
    me = data.you;
    if (document.activeElement !== renameInput) renameInput.value = data.you.pseudo;
  }
  render();
}

function render() {
  if (!me || !view) return;
  who.textContent = me.pseudo;
  const formatted = format(view.total);
  if (shownTotal !== null && view.total !== shownTotal) {
    totalEl.classList.remove("bump");
    void totalEl.offsetWidth;
    totalEl.classList.add("bump");
  }
  shownTotal = view.total;
  totalEl.textContent = formatted;
  document.title = `${formatted} · Compteur infini`;
  mineEl.textContent = `tes appuis ${format(me.taps)}`;
  lastEl.textContent = view.last
    ? `dernier +1 · ${view.last.pseudo}`
    : "En attente du premier appui.";

  const self = view.players.find((player) => player.pseudo === me.pseudo);
  const agentOnline = Boolean(self?.inGame);

  keyLabel.textContent = bindMode ? "appuie…" : bindingLabel(me.binding);
  keyLabel.classList.toggle("listening", bindMode);
  bindButton.textContent = bindMode ? "Annuler" : "Choisir";
  if (bindMode) {
    bindHint.textContent = "Appuie sur une touche ou un bouton de la souris. Échap annule.";
  } else if (!me.binding) {
    bindHint.textContent = "Touche, clic gauche, droit, molette ou bouton latéral. Un appui, un point.";
  } else if (agentOnline) {
    bindHint.textContent = "L'agent écoute. Tu peux aller dans le jeu.";
  } else if (me.binding.kind === "mouse") {
    bindHint.textContent = "Ce clic compte dès que l'agent est lancé, dans le jeu comme sur le bureau.";
  } else {
    bindHint.textContent = "Sur cette page, la touche marche tout de suite. Pour un jeu, lance l'agent.";
  }

  agentStatus.textContent = agentOnline ? "écoute en jeu" : "agent arrêté";
  agentStatus.classList.toggle("on", agentOnline);
  agentStatus.classList.toggle("off", !agentOnline);
  agentCmd.textContent = `py -3 agent\\agent.py --server ${location.origin} --token ${token}`;

  const online = view.players.filter((player) => player.onSite || player.inGame).length;
  onlineEl.textContent = online ? `${format(online)} connecté${online > 1 ? "s" : ""}` : "";

  const nextRoster = JSON.stringify(view.players.map((player) => [
    player.pseudo,
    player.taps,
    player.onSite,
    player.inGame,
    player.pseudo === me.pseudo,
  ]));
  if (nextRoster === rosterSig) {
    updateShare();
    return;
  }
  rosterSig = nextRoster;

  playersEl.replaceChildren();
  if (view.players.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Personne pour l'instant.";
    playersEl.append(empty);
  } else {
    for (const player of view.players) {
      const row = document.createElement("li");
      const active = player.onSite || player.inGame;
      if (!active) row.className = "offline";
      const name = document.createElement("span");
      name.className = "player-name";
      name.textContent = player.pseudo === me.pseudo ? `${player.pseudo} · toi` : player.pseudo;
      const taps = document.createElement("span");
      taps.className = "player-taps";
      taps.textContent = format(player.taps);
      const status = document.createElement("span");
      status.className = "player-status";
      status.textContent = player.inGame ? "en jeu" : player.onSite ? "sur le site" : "hors ligne";
      row.append(name, taps, status);
      playersEl.append(row);
    }
  }

  updateShare();
}

function updateShare() {
  const lines = [`Tout le monde ouvre : ${location.origin}`];
  for (const url of view.lan || []) {
    let host = "";
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (host !== location.hostname && !host.startsWith("10.") && !host.startsWith("172.")) {
      lines.push(`Sur le même Wi-Fi : ${url}`);
    }
  }
  share.hidden = false;
  lanEl.textContent = lines.join("\n");
}

async function saveBinding(binding) {
  if (saving) return;
  saving = true;
  try {
    applySession(await api("/api/bind", { method: "POST", body: { binding } }));
    bindMode = false;
    render();
  } catch (error) {
    bindHint.textContent = error.message;
  } finally {
    saving = false;
  }
}

async function copyText(button, text) {
  const initial = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copié";
  } catch {
    button.textContent = "Copie impossible";
  }
  setTimeout(() => {
    button.textContent = initial;
  }, 1400);
}

joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError(joinError, "");
  try {
    const data = await api("/api/join", {
      method: "POST",
      body: { pseudo: pseudoInput.value },
    });
    token = data.token;
    localStorage.setItem(TOKEN_KEY, token);
    applySession(data);
    showApp();
    connectStream();
    beat();
  } catch (error) {
    showError(joinError, error.message);
  }
});

renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    applySession(await api("/api/pseudo", {
      method: "POST",
      body: { pseudo: renameInput.value },
    }));
  } catch (error) {
    lastEl.textContent = error.message;
  }
});

bindButton.addEventListener("click", () => {
  bindButton.blur();
  bindMode = !bindMode;
  render();
});

const MOUSE_BY_BUTTON = {
  0: "Left",
  1: "Middle",
  2: "Right",
  3: "X1",
  4: "X2",
};

window.addEventListener("mousedown", (event) => {
  if (event.button === 3 || event.button === 4) event.preventDefault();
  if (!bindMode || !me || gate.hidden === false) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.target instanceof Element && event.target.closest("#bind")) return;
  const value = MOUSE_BY_BUTTON[event.button];
  if (!value) return;
  event.preventDefault();
  event.stopPropagation();
  saveBinding({ kind: "mouse", value });
}, true);

window.addEventListener("click", (event) => {
  if (!bindMode && !saving) return;
  if (event.target instanceof Element && event.target.closest("#bind")) return;
  event.preventDefault();
  event.stopPropagation();
}, true);

window.addEventListener("contextmenu", (event) => {
  if (bindMode) event.preventDefault();
}, true);

window.addEventListener("auxclick", (event) => {
  if (bindMode || event.button === 3 || event.button === 4) event.preventDefault();
}, true);

copyCmd.addEventListener("click", () => {
  copyText(copyCmd, agentCmd.textContent);
});

copyToken.addEventListener("click", () => {
  copyText(copyToken, token);
});

document.querySelector("#reset").addEventListener("click", async () => {
  if (!window.confirm("Remettre le compteur de tout le monde à zéro ?")) return;
  try {
    applySession(await api("/api/reset", { method: "POST", body: {} }));
  } catch (error) {
    lastEl.textContent = error.message;
  }
});

downloadBat.addEventListener("click", () => {
  const bat = [
    "@echo off",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    'set "RUN="',
    'where py >nul 2>&1 && set "RUN=py -3"',
    'if not defined RUN where python >nul 2>&1 && set "RUN=python"',
    "if not defined RUN (",
    "  echo Installe Python 3 : https://www.python.org/downloads/",
    "  pause",
    "  exit /b 1",
    ")",
    '%RUN% -c "import pynput" 1>nul 2>nul || %RUN% -m pip install pynput',
    `%RUN% "%~dp0agent.py" --server ${location.origin} --token ${token}`,
    "echo.",
    "pause",
    "",
  ].join("\r\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([bat], { type: "application/octet-stream" }));
  link.download = "lancer-agent.bat";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1500);
});

window.addEventListener("keydown", async (event) => {
  if (!me || gate.hidden === false) return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;

  if (bindMode) {
    event.preventDefault();
    if (event.repeat || event.code === "Escape") {
      if (event.code === "Escape") {
        bindMode = false;
        render();
      }
      return;
    }
    if (BLOCKED.has(event.code)) return;
    await saveBinding(toBinding(event));
    return;
  }

  if (event.repeat || !me.binding) return;
  const self = view?.players?.find((player) => player.pseudo === me.pseudo);
  if (self?.inGame) return;
  if (!eventMatches(event, me.binding)) return;
  event.preventDefault();
  try {
    applySession(await api("/api/tap", { method: "POST", body: { source: "site" } }));
  } catch (error) {
    bindHint.textContent = error.message;
  }
});

function forgetSession() {
  localStorage.removeItem(TOKEN_KEY);
  token = "";
  me = null;
  view = null;
  if (stream) {
    stream.close();
    stream = null;
  }
  showGate();
}

function connectStream() {
  if (stream) stream.close();
  stream = new EventSource("/api/events");
  stream.onmessage = (event) => {
    const data = JSON.parse(event.data);
    view = { ...data, you: me };
    if (me) {
      const self = data.players.find((player) => player.pseudo === me.pseudo);
      if (self) me = { ...me, taps: self.taps };
    }
    render();
  };
}

async function beat() {
  if (!token) return;
  try {
    const data = await api("/api/heartbeat", { method: "POST", body: { source: "site" } });
    applySession(data);
  } catch (error) {
    if (error.status === 401) forgetSession();
  }
}

async function boot() {
  if (!token) {
    showGate();
    return;
  }
  try {
    applySession(await api("/api/me"));
    showApp();
    connectStream();
    beat();
  } catch (error) {
    if (error.status === 401) localStorage.removeItem(TOKEN_KEY);
    token = error.status === 401 ? "" : token;
    showGate();
  }
}

boot();
setInterval(() => {
  if (token && me) beat();
}, 4000);
