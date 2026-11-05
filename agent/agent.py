"""Écoute une seule touche et ajoute 1 au compteur partagé.

Aucune autre frappe n'est enregistrée ni envoyée.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from ctypes import wintypes
from pathlib import Path

try:
    from pynput import keyboard
except ImportError:
    print("Installe la dépendance : py -3 -m pip install pynput")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent
CONFIG = ROOT / "config.json"

NUMPAD = {
    0x60: "Numpad0",
    0x61: "Numpad1",
    0x62: "Numpad2",
    0x63: "Numpad3",
    0x64: "Numpad4",
    0x65: "Numpad5",
    0x66: "Numpad6",
    0x67: "Numpad7",
    0x68: "Numpad8",
    0x69: "Numpad9",
    0x6A: "NumpadMultiply",
    0x6B: "NumpadAdd",
    0x6C: "NumpadSeparator",
    0x6D: "NumpadSubtract",
    0x6E: "NumpadDecimal",
    0x6F: "NumpadDivide",
}

CODE_BY_NAME = {
    "space": "Space",
    "enter": "Enter",
    "tab": "Tab",
    "esc": "Escape",
    "backspace": "Backspace",
    "delete": "Delete",
    "insert": "Insert",
    "home": "Home",
    "end": "End",
    "page_up": "PageUp",
    "page_down": "PageDown",
    "up": "ArrowUp",
    "down": "ArrowDown",
    "left": "ArrowLeft",
    "right": "ArrowRight",
    "caps_lock": "CapsLock",
    "num_lock": "NumLock",
    "scroll_lock": "ScrollLock",
    "print_screen": "PrintScreen",
    "pause": "Pause",
}

LABELS = {
    "Space": "espace",
    "Enter": "entrée",
    "Tab": "tab",
    "Escape": "échap",
    "Backspace": "retour",
    "Delete": "suppr",
    "ArrowUp": "haut",
    "ArrowDown": "bas",
    "ArrowLeft": "gauche",
    "ArrowRight": "droite",
}

def classify_mouse(message, mouse_data=0):
    down = {0x0201: "Left", 0x0204: "Right", 0x0207: "Middle"}
    up = {0x0202: "Left", 0x0205: "Right", 0x0208: "Middle"}
    if message in down:
        return down[message], True
    if message in up:
        return up[message], False
    if message in (0x020B, 0x020C):
        which = (mouse_data >> 16) & 0xFFFF
        if which == 1:
            return "X1", message == 0x020B
        if which == 2:
            return "X2", message == 0x020B
    return None


class MouseButtons:
    """Button hook only, and only while a mouse button is the binding.

    Mouse movement returns immediately. Nothing here talks to the network.
    """

    def __init__(self, on_button):
        self._on_button = on_button
        self._events = deque()
        self._ready = threading.Event()
        self._installed = threading.Event()
        self._error = 0
        self._hook = None
        self._thread_id = 0
        self.running = False
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        result = ctypes.c_ssize_t
        self._hookproc = ctypes.WINFUNCTYPE(result, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
        self._user32.SetWindowsHookExW.argtypes = (ctypes.c_int, self._hookproc, wintypes.HINSTANCE, wintypes.DWORD)
        self._user32.SetWindowsHookExW.restype = wintypes.HHOOK
        self._user32.CallNextHookEx.argtypes = (wintypes.HHOOK, ctypes.c_int, wintypes.WPARAM, wintypes.LPARAM)
        self._user32.CallNextHookEx.restype = result
        self._user32.UnhookWindowsHookEx.argtypes = (wintypes.HHOOK,)
        self._user32.UnhookWindowsHookEx.restype = wintypes.BOOL
        self._user32.GetMessageW.argtypes = (ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT, wintypes.UINT)
        self._user32.GetMessageW.restype = ctypes.c_int
        self._user32.TranslateMessage.argtypes = (ctypes.POINTER(wintypes.MSG),)
        self._user32.DispatchMessageW.argtypes = (ctypes.POINTER(wintypes.MSG),)
        self._user32.PostThreadMessageW.argtypes = (wintypes.DWORD, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM)
        self._user32.PostThreadMessageW.restype = wintypes.BOOL
        self._kernel32.GetCurrentThreadId.restype = wintypes.DWORD

        class MSLLHOOKSTRUCT(ctypes.Structure):
            _fields_ = [
                ("x", ctypes.c_long),
                ("y", ctypes.c_long),
                ("mouseData", wintypes.DWORD),
                ("flags", wintypes.DWORD),
                ("time", wintypes.DWORD),
                ("dwExtraInfo", ctypes.c_size_t),
            ]

        self._struct = MSLLHOOKSTRUCT
        self._callback = self._hookproc(self._proc)
        threading.Thread(target=self._consume, name="mouse-buttons", daemon=True).start()

    def _proc(self, nCode, wParam, lParam):
        message = int(wParam)
        if nCode == 0 and message not in (0x0200, 0x020A, 0x020E):
            info = 0
            if message in (0x020B, 0x020C):
                info = ctypes.cast(lParam, ctypes.POINTER(self._struct)).contents.mouseData
            found = classify_mouse(message, info)
            if found:
                self._events.append(found)
                self._ready.set()
        return self._user32.CallNextHookEx(None, nCode, wParam, lParam)

    def _consume(self):
        while True:
            self._ready.wait(0.05)
            self._ready.clear()
            while self._events:
                try:
                    name, pressed = self._events.popleft()
                except IndexError:
                    break
                self._on_button(name, pressed)

    def _pump(self):
        self._thread_id = self._kernel32.GetCurrentThreadId()
        hook = self._user32.SetWindowsHookExW(14, self._callback, None, 0)
        if not hook:
            self._error = ctypes.get_last_error() or 1
            self._installed.set()
            return
        self._hook = hook
        self.running = True
        self._installed.set()
        message = wintypes.MSG()
        while self._user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
            self._user32.TranslateMessage(ctypes.byref(message))
            self._user32.DispatchMessageW(ctypes.byref(message))
        if self._hook:
            self._user32.UnhookWindowsHookEx(self._hook)
            self._hook = None
        self.running = False

    def start(self):
        if self.running:
            return 0
        self._installed.clear()
        self._error = 0
        threading.Thread(target=self._pump, name="mouse-hook", daemon=True).start()
        self._installed.wait(2)
        return self._error

    def stop(self):
        if not self.running:
            return
        self.running = False
        if self._hook:
            self._user32.UnhookWindowsHookEx(self._hook)
            self._hook = None
        if self._thread_id:
            self._user32.PostThreadMessageW(self._thread_id, 0x0012, 0, 0)


def claim_single_instance():
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = (ctypes.c_void_p, wintypes.BOOL, wintypes.LPCWSTR)
    kernel32.CreateMutexW.restype = wintypes.HANDLE
    handle = kernel32.CreateMutexW(None, False, "Local\\CompteurInfiniAgent")
    exists = ctypes.get_last_error() == 183
    claim_single_instance.handle = handle
    return not exists


class ApiError(Exception):
    def __init__(self, status, payload):
        super().__init__(payload.get("error") or f"HTTP {status}")
        self.status = status
        self.payload = payload


def label(binding):
    names = {
        "Left": "clic gauche",
        "Right": "clic droit",
        "Middle": "clic molette",
        "X1": "souris latérale 1",
        "X2": "souris latérale 2",
    }
    if not binding:
        return "aucune — choisis-la sur le site"
    if binding.get("kind") == "mouse":
        return names.get(binding.get("value"), binding.get("value"))
    if binding.get("kind") == "char":
        value = binding.get("value") or ""
        return "espace" if value == " " else value.upper()
    value = binding.get("value") or ""
    if value.startswith("Numpad"):
        return value.replace("Numpad", "pavé ")
    return LABELS.get(value, value)


def code_of(key):
    if isinstance(key, keyboard.KeyCode) and key.vk in NUMPAD:
        return NUMPAD[key.vk]
    if isinstance(key, keyboard.Key):
        name = key.name or ""
        if name in CODE_BY_NAME:
            return CODE_BY_NAME[name]
        if name.startswith("f") and name[1:].isdigit():
            return "F" + name[1:]
    return None


def is_bound(key, binding):
    if not binding:
        return False
    kind = binding.get("kind")
    value = binding.get("value")
    if kind == "code":
        return code_of(key) == value
    if kind == "char":
        if isinstance(key, keyboard.KeyCode) and key.vk in NUMPAD:
            return False
        char = getattr(key, "char", None)
        return bool(char) and char.lower() == str(value).lower()
    return False


def identity(key):
    if isinstance(key, keyboard.Key):
        vk = getattr(getattr(key, "value", None), "vk", None)
        if vk is not None:
            return ("vk", vk)
        return ("name", key.name)
    if isinstance(key, keyboard.KeyCode):
        if key.vk is not None:
            return ("vk", key.vk)
        if key.char:
            return ("char", key.char.lower())
    return ("other", repr(key))


def load_config():
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def save_config(server, token):
    CONFIG.write_text(
        json.dumps({"server": server, "token": token}, indent=2),
        encoding="utf-8",
    )


def self_test():
    assert code_of(keyboard.Key.f8) == "F8"
    assert code_of(keyboard.Key.space) == "Space"
    assert code_of(keyboard.Key.enter) == "Enter"
    assert code_of(keyboard.Key.up) == "ArrowUp"
    assert is_bound(keyboard.Key.f8, {"kind": "code", "value": "F8"})
    assert not is_bound(keyboard.Key.f8, {"kind": "code", "value": "F7"})
    assert is_bound(keyboard.KeyCode.from_char("a"), {"kind": "char", "value": "a"})
    assert is_bound(keyboard.KeyCode.from_char("A"), {"kind": "char", "value": "a"})
    assert not is_bound(keyboard.KeyCode.from_char("b"), {"kind": "char", "value": "a"})
    numpad5 = keyboard.KeyCode.from_vk(0x65)
    assert code_of(numpad5) == "Numpad5"
    assert is_bound(numpad5, {"kind": "code", "value": "Numpad5"})
    assert not is_bound(numpad5, {"kind": "char", "value": "5"})
    assert classify_mouse(0x0201) == ("Left", True)
    assert classify_mouse(0x0205) == ("Right", False)
    assert classify_mouse(0x020B, 1 << 16) == ("X1", True)
    assert classify_mouse(0x020C, 2 << 16) == ("X2", False)
    assert classify_mouse(0x0200) is None
    print("agent ok")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", line_buffering=True)
    except Exception:
        pass

    parser = argparse.ArgumentParser(description="Agent du compteur infini")
    parser.add_argument("--server", default="")
    parser.add_argument("--token", default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        self_test()
        return 0

    saved = load_config()
    server = (args.server or saved.get("server") or "http://127.0.0.1:3780").rstrip("/")
    token = args.token or saved.get("token") or ""
    if not token:
        print("Colle le jeton affiché sur le site.")
        token = input("Jeton : ").strip()
    if not token:
        print("Jeton manquant.")
        return 1

    session = {"server": server, "token": token, "binding": None}
    held = set()
    held_lock = threading.Lock()
    bind_lock = threading.Lock()

    def request(method, path, body=None):
        data = None if body is None else json.dumps(body).encode("utf-8")
        req = urllib.request.Request(session["server"] + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {session['token']}")
        req.add_header("Accept", "application/json")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=1.2) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", "replace")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = {}
            raise ApiError(err.code, payload) from None

    def current_binding():
        with bind_lock:
            return session["binding"]

    def set_binding(binding):
        with bind_lock:
            session["binding"] = binding

    pending = {"n": 0}
    pending_lock = threading.Lock()
    pending_ready = threading.Event()

    def enqueue_tap():
        with pending_lock:
            pending["n"] += 1
        pending_ready.set()

    def tap_worker():
        while True:
            pending_ready.wait()
            pending_ready.clear()
            with pending_lock:
                count = pending["n"]
                pending["n"] = 0
            if not count:
                continue
            try:
                data = request("POST", "/api/tap", {"source": "agent", "count": count})
            except Exception as exc:
                print(f"Échec du +{count} ({exc})")
                with pending_lock:
                    pending["n"] += count
                time.sleep(0.15)
                pending_ready.set()
                continue
            print(f"+{count}   total {data.get('total')}")
            with pending_lock:
                if pending["n"]:
                    pending_ready.set()

    threading.Thread(target=tap_worker, name="taps", daemon=True).start()

    def on_press(key):
        try:
            ident = identity(key)
            with held_lock:
                if ident in held:
                    return
                held.add(ident)
            if is_bound(key, current_binding()):
                enqueue_tap()
        except Exception:
            pass

    def on_release(key):
        try:
            with held_lock:
                held.discard(identity(key))
        except Exception:
            pass

    def on_button(name, pressed):
        try:
            if pressed:
                with held_lock:
                    if name in held:
                        return
                    held.add(name)
                binding = current_binding()
                if binding and binding.get("kind") == "mouse" and binding.get("value") == name:
                    enqueue_tap()
            else:
                with held_lock:
                    held.discard(name)
        except Exception:
            pass

    try:
        hello = request("POST", "/api/heartbeat", {"source": "agent"})
    except ApiError as err:
        if err.status == 401:
            print("Jeton refusé. Copie celui qui est affiché sur le site.")
        else:
            print(f"Le serveur a répondu : {err}")
        return 1
    except urllib.error.URLError:
        print("Serveur injoignable. Lance d'abord lancer.bat, puis réessaie.")
        return 1

    save_config(server, token)
    you = hello["you"]
    set_binding(you.get("binding"))
    print(f"Connecté en tant que {you['pseudo']}.")
    print("Laisse cette fenêtre ouverte. Tu peux la réduire et ouvrir le jeu.")
    print("Touche :", label(you.get("binding")))
    print("Seule cette touche est observée.")

    if not claim_single_instance():
        print("L'agent tourne déjà. Ferme l'autre fenêtre noire, puis relance celui-ci.")
        return 1

    key_listener = keyboard.Listener(on_press=on_press, on_release=on_release)
    key_listener.daemon = True
    try:
        key_listener.start()
    except Exception as exc:
        print("Impossible d'écouter le clavier.", exc)
        print("Si le jeu est lancé en administrateur, relance cet agent en administrateur.")
        return 1

    mouse_buttons = MouseButtons(on_button)

    def sync_mouse(binding):
        wants = bool(binding and binding.get("kind") == "mouse")
        if wants and not mouse_buttons.running:
            if mouse_buttons.start():
                print("Les boutons de la souris ne sont pas disponibles pour le moment.")
        elif not wants and mouse_buttons.running:
            mouse_buttons.stop()

    sync_mouse(you.get("binding"))
    last_sig = json.dumps(you.get("binding"), sort_keys=True)
    offline = False
    try:
        while True:
            time.sleep(1.5)
            try:
                data = request("POST", "/api/heartbeat", {"source": "agent"})
            except Exception:
                if not offline:
                    print("Serveur injoignable, nouvel essai…")
                    offline = True
                continue
            if offline:
                print("Reconnecté.")
                offline = False
            binding = data["you"].get("binding")
            set_binding(binding)
            sync_mouse(binding)
            sig = json.dumps(binding, sort_keys=True)
            if sig != last_sig:
                last_sig = sig
                print("Nouvelle touche :", label(binding))
    except KeyboardInterrupt:
        print("\nAgent arrêté. La touche ne compte plus tant qu'il n'est pas relancé.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
