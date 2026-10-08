# -*- coding: utf-8 -*-
"""
局域网快传 (LAN Share)  v1.0
================================
本地局域网文件夹共享工具：选定文件夹 -> 共享 -> 局域网用户实时发现并拉取。

特性
----
* 多共享目录，每目录独立权限：公开 / 密码保护 / 仅自己可见
* UDP 组播广播：同一局域网内所有运行本程序的主机自动互相发现（实时在线列表）
* SSE 实时推送：任何页面上的共享列表、设备列表变更即时刷新，无需手动刷新
* 断点续传下载（HTTP Range）、目录打包 ZIP、图片/视频在线预览
* 纯 Python 标准库实现，零第三方依赖；管理操作仅限本机（localhost）

用法
----
    python server.py [--port 8765] [--no-browser] [--discovery-off]

可选 HTTPS：把自签名证书命名为 cert.pem / key.pem 放到本目录即可自动启用。
"""

import argparse
import hashlib
import json
import mimetypes
import os
import queue
import re
import secrets
import socket
import ssl
import struct
import string
import sys
import tempfile
import threading
import time
import urllib.parse
import uuid
import webbrowser
import zipfile
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

VERSION = "1.0.0"
APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
# 数据目录：源码运行=项目目录；打包为 exe 后=exe 所在目录（配置可持久化）
DATA_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else APP_DIR
CONFIG_FILE = DATA_DIR / "config.json"
DOWNLOAD_FILE = DATA_DIR / "downloads.json"   # 下载统计持久化（谁下载过、几次、何时）

DEFAULT_PORT = 8765
MCAST_GROUP = "239.255.77.77"      # 组播地址（局域网广播发现）
MCAST_PORT = 9877                  # 组播端口
ANN_INTERVAL = 3.0                 # 广播间隔（秒）
PEER_TTL = 12.0                    # 设备离线判定（秒）
TOKEN_TTL = 24 * 3600              # 密码会话有效期
LOGIN_LIMIT = 10                   # 登录尝试上限（窗口内）
LOGIN_WINDOW = 300                 # 登录限流窗口（秒）
CHUNK = 64 * 1024                  # 文件发送分块

# 在线预览允许的 MIME 前缀/类型（/api/raw 白名单）
INLINE_TYPES = ("image/", "video/", "audio/", "text/", "application/pdf", "application/x-pdf")
# 补 Windows mimetypes 缺失的常见扩展
for _ext, _mime in {
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".md": "text/markdown",
    ".markdown": "text/markdown",
    ".log": "text/plain",
    ".mkv": "video/x-matroska",
    ".webm": "video/webm",
    ".m4a": "audio/mp4",
}.items():
    mimetypes.add_type(_mime, _ext)

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


# --------------------------------------------------------------------------- #
# 配置读写
# --------------------------------------------------------------------------- #

def load_config():
    if CONFIG_FILE.exists():
        try:
            data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                data.setdefault("server_name", socket.gethostname() or "局域网快传")
                data.setdefault("shares", [])
                data.setdefault("speed_limit_kb", 0)
                data.setdefault("download_dir", "")  # 本机桌面版下载保存位置（空=未设置）
                for s in data["shares"]:
                    s.setdefault("writable", False)
                return data
        except Exception:
            pass
    return {"server_name": socket.gethostname() or "局域网快传", "shares": []}


def save_config(cfg):
    tmp = CONFIG_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, CONFIG_FILE)


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(8)
    digest = hashlib.sha256((salt + ":" + password).encode("utf-8")).hexdigest()
    return salt, digest


def get_local_ips():
    ips = set()
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            ips.add(s.getsockname()[0])
        finally:
            s.close()
    except Exception:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except Exception:
        pass
    return sorted(ips - {"127.0.0.1"})


# --------------------------------------------------------------------------- #
# 应用状态
# --------------------------------------------------------------------------- #

class RateLimiter:
    """令牌桶限速器：cap_kb <= 0 表示不限速。上行/下行共用。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.cap = 0.0            # bytes/s
        self.tokens = 0.0
        self.last = time.time()

    def set_cap_kb(self, kb):
        with self.lock:
            self.cap = max(0, kb) * 1024.0
            self.tokens = self.cap   # 允许突发一个桶
            self.last = time.time()

    def pace(self, n):
        """为传输 n 字节做节流等待（若启用限速）。"""
        with self.lock:
            if self.cap <= 0:
                return
            now = time.time()
            dt = now - self.last
            self.last = now
            self.tokens = min(self.cap, self.tokens + dt * self.cap)
            self.tokens -= n
            if self.tokens >= 0:
                return
            wait = (-self.tokens) / self.cap
        if wait > 0:
            time.sleep(wait)


class Stats:
    """传输统计：总量 + 1s 窗口速率 + 活跃连接数。"""

    def __init__(self):
        self.lock = threading.Lock()
        self.out_total = 0
        self.in_total = 0
        self.out_speed = 0.0
        self.in_speed = 0.0
        self.active_down = 0
        self.active_up = 0
        self._out_win = 0
        self._in_win = 0
        self._sample_ts = time.time()

    def note_out(self, n):
        with self.lock:
            self.out_total += n
            self._out_win += n

    def note_in(self, n):
        with self.lock:
            self.in_total += n
            self._in_win += n

    def enter(self, direction):
        with self.lock:
            if direction == "down":
                self.active_down += 1
            else:
                self.active_up += 1

    def leave(self, direction):
        with self.lock:
            if direction == "down":
                self.active_down = max(0, self.active_down - 1)
            else:
                self.active_up = max(0, self.active_up - 1)

    def sample(self):
        with self.lock:
            now = time.time()
            dt = max(now - self._sample_ts, 0.05)
            self._sample_ts = now
            self.out_speed = self._out_win / dt
            self.in_speed = self._in_win / dt
            self._out_win = 0
            self._in_win = 0
            return (self.out_speed, self.in_speed,
                    self.active_down, self.active_up)

    def snapshot(self):
        with self.lock:
            return {
                "down": {"speed": round(self.out_speed, 1), "total": self.out_total},
                "up": {"speed": round(self.in_speed, 1), "total": self.in_total},
                "active": {"down": self.active_down, "up": self.active_up},
            }


class App:
    def __init__(self):
        self.cfg = load_config()
        self.lock = threading.RLock()
        self.http_port = DEFAULT_PORT
        self.sessions = {}              # token -> {"share": id, "exp": ts}
        self.login_attempts = {}         # ip -> deque[ts]
        self.peers = {}                  # "ip:port" -> info
        self.sse_clients = set()         # set[queue.Queue]
        self.limiter = RateLimiter()
        self.stats = Stats()
        self.start_ts = time.time()
        self.limiter.set_cap_kb(self.cfg.get("speed_limit_kb", 0))
        # 下载统计：key=(share_id, rel_path, 来源IP) -> 记录
        self.downloads = {}
        self._load_downloads()

    # ---- 共享查询 ----
    def get_share(self, share_id):
        for s in self.cfg["shares"]:
            if s["id"] == share_id:
                return s
        return None

    def public_share_count(self):
        return sum(1 for s in self.cfg["shares"] if s["perm"] != "private")

    # ---- 持久化 + 广播 ----
    def save(self):
        with self.lock:
            save_config(self.cfg)
        self.broadcast("config")

    def broadcast(self, event, payload=None):
        with self.lock:
            clients = list(self.sse_clients)
        data = json.dumps(payload) if payload is not None else None
        for q in clients:
            try:
                q.put_nowait((event, data))
            except Exception:
                pass

    # ---- 下载统计（谁下载过、几次、何时）----
    def record_download(self, share, rel, full, ip, name=None):
        now = time.time()
        key = (share["id"], rel, ip)
        peer = ip
        with self.lock:
            for v in self.peers.values():
                if v["host"] == ip and v.get("name"):
                    peer = v["name"]
                    break
            cur = self.downloads.get(key)
            if cur is None:
                self.downloads[key] = {
                    "share_id": share["id"], "share_name": share["name"],
                    "path": rel, "name": name or os.path.basename(full),
                    "size": os.path.getsize(full) if os.path.isfile(full) else 0,
                    "ip": ip, "peer": peer, "count": 1,
                    "first_ts": now, "last_ts": now,
                }
            else:
                # 距上次超过 5 分钟视为新的下载会话（续传/分块不重复计数）
                if now - cur["last_ts"] > 300:
                    cur["count"] += 1
                cur["last_ts"] = now
                cur["peer"] = peer
            self._save_downloads()
        self.broadcast("downloads")

    def _save_downloads(self):
        try:
            data = {"v": 1, "items": [dict(v, key="%s|%s|%s" % k)
                                      for k, v in self.downloads.items()]}
            DOWNLOAD_FILE.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def _load_downloads(self):
        try:
            if not DOWNLOAD_FILE.exists():
                return
            data = json.loads(DOWNLOAD_FILE.read_text(encoding="utf-8"))
            for it in data.get("items", []):
                k = it.pop("key", "").split("|")
                if len(k) == 3:
                    self.downloads[(k[0], k[1], k[2])] = it
        except Exception:
            pass

    # ---- SSE 客户端管理 ----
    def add_sse(self, q):
        with self.lock:
            self.sse_clients.add(q)

    def drop_sse(self, q):
        with self.lock:
            self.sse_clients.discard(q)

    # ---- 设备发现 ----
    def upsert_peer(self, ip, port, name, shares):
        key = "%s:%s" % (ip, port)
        with self.lock:
            old = self.peers.get(key)
            now = time.time()
            if old is None or old["name"] != name or old["shares"] != shares:
                self.peers[key] = {"host": ip, "port": port, "name": name,
                                   "shares": shares, "last_seen": now}
                return True
            old["last_seen"] = now
            return False

    def prune_peers(self):
        changed = False
        now = time.time()
        with self.lock:
            dead = [k for k, v in self.peers.items() if now - v["last_seen"] > PEER_TTL]
            for k in dead:
                del self.peers[k]
                changed = True
        if changed:
            self.broadcast("peers")


app = App()


# --------------------------------------------------------------------------- #
# 路径安全
# --------------------------------------------------------------------------- #

def resolve_share_path(share, rel):
    """把共享内的相对路径解析为绝对路径；越出根目录返回 None。"""
    root = os.path.realpath(share["path"])
    rel = rel.replace("\\", "/").lstrip("/")
    if rel:
        full = os.path.realpath(os.path.join(root, *rel.split("/")))
    else:
        full = root
    rn = os.path.normcase(root)
    fn = os.path.normcase(full)
    if fn != rn and not fn.startswith(rn + os.sep):
        return None
    return full


# --------------------------------------------------------------------------- #
# UDP 组播广播发现
# --------------------------------------------------------------------------- #

def _announce_payload():
    return json.dumps({
        "t": "lanshare", "v": 1,
        "name": app.cfg["server_name"],
        "port": app.http_port,
        "shares": app.public_share_count(),
    }, ensure_ascii=False).encode("utf-8")


def udp_announcer(stop):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_MULTICAST_TTL, 2)
    except Exception:
        pass
    targets = [(MCAST_GROUP, MCAST_PORT), ("255.255.255.255", MCAST_PORT)]
    while not stop.is_set():
        payload = _announce_payload()
        for t in targets:
            try:
                sock.sendto(payload, t)
            except Exception:
                pass
        stop.wait(ANN_INTERVAL)


def udp_listener(stop):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
        sock.bind(("", MCAST_PORT))
        mreq = struct.pack("4sl", socket.inet_aton(MCAST_GROUP), socket.INADDR_ANY)
        sock.setsockopt(socket.IPPROTO_IP, socket.IP_ADD_MEMBERSHIP, mreq)
    except OSError as e:
        print("[发现] UDP 监听失败（可能是防火墙或端口占用）：%s" % e)
        return
    local_ips = set(get_local_ips()) | {"127.0.0.1"}
    sock.settimeout(0.5)
    while not stop.is_set():
        try:
            data, addr = sock.recvfrom(2048)
        except socket.timeout:
            continue
        except OSError:
            break
        try:
            msg = json.loads(data.decode("utf-8"))
        except Exception:
            continue
        if not isinstance(msg, dict) or msg.get("t") != "lanshare":
            continue
        ip = addr[0]
        if ip in local_ips:
            continue
        if app.upsert_peer(ip, int(msg.get("port", 0)), str(msg.get("name", "?")),
                           int(msg.get("shares", 0))):
            app.broadcast("peers")


def peer_pruner(stop):
    while not stop.is_set():
        stop.wait(3.0)
        app.prune_peers()


# --------------------------------------------------------------------------- #
# HTTP 处理器
# --------------------------------------------------------------------------- #

class QuietServer(ThreadingHTTPServer):
    """静默处理客户端强制断开等常规网络异常，避免向控制台打印 traceback。"""
    # ThreadingHTTPServer 默认 allow_reuse_address=1（SO_REUSEADDR）：
    # 在 Windows 上会允许两个 socket 绑同一端口（新实例与已运行实例抢端口，
    # 请求可能全部打到旧实例）。这里显式关闭，保证端口独占、新实例直接报错。
    allow_reuse_address = 0

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, TimeoutError)):
            return
        super().handle_error(request, client_address)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    app = app
    server_version = "LANShare/" + VERSION

    # ---- 基础工具 ----

    def log_message(self, fmt, *args):
        pass  # 静默默认访问日志，由 _log 按需输出

    def _log(self, msg):
        try:
            sys.stdout.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), msg))
        except Exception:
            pass

    def _is_local(self):
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _cookie(self, name):
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            part = part.strip()
            if part.startswith(name + "="):
                return part[len(name) + 1:]
        return None

    def _read_json(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > 1 << 20:
            return None
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _share_visible(self, share):
        return share["perm"] != "private" or self._is_local()

    def _authorized(self, share):
        if share["perm"] == "public":
            return True
        if self._is_local():
            return True
        tok = self._cookie("ls_" + share["id"])
        if not tok:
            return False
        sess = self.app.sessions.get(tok)
        return bool(sess and sess["share"] == share["id"] and sess["exp"] > time.time())

    def _require_share(self, qs):
        share = self.app.get_share(qs.get("share", [""])[0])
        if not share:
            self._json(404, {"error": "共享不存在或已被移除"})
            return None
        if not self._share_visible(share):
            self._json(404, {"error": "共享不存在或已被移除"})
            return None
        return share

    def _require_access(self, share):
        if not self._authorized(share):
            self._json(401, {"error": "locked", "share": share["id"]})
            return False
        return True

    # ---- 静态与入口 ----

    def _serve_index(self):
        data = (STATIC_DIR / "index.html").read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _serve_static(self, url_path):
        name = url_path[len("/static/"):]
        target = (STATIC_DIR / name).resolve()
        if not str(target).startswith(str(STATIC_DIR.resolve())) or not target.is_file():
            self._json(404, {"error": "not found"})
            return
        data = target.read_bytes()
        ctype, _ = mimetypes.guess_type(str(target))
        ctype = ctype or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(data)

    # ---- API ----

    def _api_config(self):
        local = self._is_local()
        shares = []
        for s in self.app.cfg["shares"]:
            if s["perm"] == "private" and not local:
                continue
            info = {"id": s["id"], "name": s["name"], "perm": s["perm"],
                    "writable": bool(s.get("writable"))}
            if s["perm"] == "password":
                info["locked"] = True
            if local:
                info["path"] = s["path"]
                # 明文密码仅回显给本机管理页（编辑时可见），绝不发给局域网设备
                if s["perm"] == "password":
                    info["pwd"] = s.get("pwd", "")
            shares.append(info)
        resp = {
            "server_name": self.app.cfg["server_name"],
            "port": self.app.http_port,
            "is_local": local,
            "addresses": get_local_ips(),
            "version": VERSION,
            "speed_limit_kb": int(self.app.cfg.get("speed_limit_kb", 0)),
            "shares": shares,
        }
        if local:
            resp["data_dir"] = str(DATA_DIR)  # 配置文件/下载记录存放位置，仅本机可见
            resp["download_dir"] = self.app.cfg.get("download_dir", "")  # 本机下载保存位置，仅本机可见
        self._json(200, resp)

    def _api_peers(self):
        with self.app.lock:
            peers = sorted(self.app.peers.values(),
                           key=lambda p: (p["name"].lower(), p["host"]))
        self._json(200, {"peers": peers})

    def _api_drives(self):
        if not self._is_local():
            self._json(403, {"error": "仅本机可管理"})
            return
        drives = []
        for c in string.ascii_uppercase:
            p = c + ":\\"
            if os.path.exists(p):
                drives.append({"name": c + ":\\", "path": p})
        self._json(200, {"drives": drives})

    def _api_browse(self, qs):
        if not self._is_local():
            self._json(403, {"error": "仅本机可管理"})
            return
        path = qs.get("path", [""])[0]
        if not path:
            return self._api_drives()
        if not os.path.isdir(path):
            self._json(400, {"error": "路径不是文件夹"})
            return
        parent = os.path.dirname(os.path.abspath(path))
        entries = []
        try:
            with os.scandir(path) as it:
                for e in it:
                    if e.is_dir() and not e.name.startswith("."):
                        entries.append({"name": e.name, "path": os.path.join(path, e.name)})
        except OSError as ex:
            self._json(403, {"error": "无法读取：%s" % ex})
            return
        entries.sort(key=lambda x: x["name"].lower())
        self._json(200, {"current": os.path.abspath(path), "parent": parent,
                         "entries": entries[:500]})

    def _api_list(self, qs):
        share = self._require_share(qs)
        if not share:
            return
        if not self._require_access(share):
            return
        rel = qs.get("path", ["/"])[0] or "/"
        full = resolve_share_path(share, rel)
        if full is None:
            self._json(403, {"error": "路径越界"})
            return
        if not os.path.exists(full):
            self._json(404, {"error": "路径不存在"})
            return
        if os.path.isfile(full):
            entries = []
        else:
            entries = []
            try:
                with os.scandir(full) as it:
                    for e in it:
                        try:
                            st = e.stat()
                            is_dir = e.is_dir()
                        except OSError:
                            continue
                        entries.append({
                            "name": e.name,
                            "type": "dir" if is_dir else "file",
                            "size": 0 if is_dir else st.st_size,
                            "mtime": int(st.st_mtime),
                        })
            except OSError:
                pass
            entries.sort(key=lambda x: (x["type"] != "dir", x["name"].lower()))
        parent = None
        if rel and rel != "/":
            parent = "/".join(rel.rstrip("/").split("/")[:-1]) or "/"
        self._json(200, {"share": {"id": share["id"], "name": share["name"],
                                   "perm": share["perm"],
                                   "writable": bool(share.get("writable"))},
                         "path": rel or "/", "parent": parent, "entries": entries})

    # ---- 文件传输 ----

    def _send_file(self, full, download_name=None, inline=False, ctype=None):
        size = os.path.getsize(full)
        etag = '"%x-%x"' % (size, int(os.path.getmtime(full)))
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return

        start, end, status = 0, size - 1, 200
        rng = self.headers.get("Range")
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)$", rng.strip())
            if m:
                a, b = m.groups()
                try:
                    if a == "" and b == "":
                        raise ValueError
                    if a == "":
                        n = int(b)
                        if n <= 0:
                            raise ValueError
                        start, end = max(0, size - n), size - 1
                    else:
                        start = int(a)
                        if start >= size:
                            raise ValueError
                        end = int(b) if b else size - 1
                        end = min(end, size - 1)
                    status = 206
                except ValueError:
                    self.send_response(416)
                    self.send_header("Content-Range", "bytes */%d" % size)
                    self.end_headers()
                    return

        if ctype is None:
            ctype, _ = mimetypes.guess_type(full)
            ctype = ctype or "application/octet-stream"
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", self.date_time_string(os.path.getmtime(full)))
        self.send_header("Cache-Control", "no-cache")
        if download_name:
            ascii_name = download_name.encode("ascii", "replace").decode()
            quoted = urllib.parse.quote(download_name)
            disp = ("inline" if inline else "attachment")
            self.send_header("Content-Disposition",
                             "%s; filename=\"%s\"; filename*=UTF-8''%s"
                             % (disp, ascii_name, quoted))
        if status == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        self.end_headers()
        self.app.stats.enter("down")
        try:
            with open(full, "rb") as f:
                f.seek(start)
                remaining = end - start + 1
                while remaining > 0:
                    chunk = f.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    self.app.limiter.pace(len(chunk))
                    self.wfile.write(chunk)
                    self.app.stats.note_out(len(chunk))
                    remaining -= len(chunk)
        finally:
            self.app.stats.leave("down")

    def _api_raw(self, qs):
        share = self._require_share(qs)
        if not share:
            return
        if not self._require_access(share):
            return
        rel = qs.get("path", [""])[0]
        full = resolve_share_path(share, rel)
        if full is None or not os.path.isfile(full):
            self._json(404, {"error": "文件不存在"})
            return
        ctype, _ = mimetypes.guess_type(full)
        ctype = ctype or "application/octet-stream"
        if not ctype.startswith(INLINE_TYPES):
            self._json(415, {"error": "该类型不支持在线预览，请下载"})
            return
        self._send_file(full, download_name=os.path.basename(full), inline=True)

    def _api_download(self, qs):
        share = self._require_share(qs)
        if not share:
            return
        if not self._require_access(share):
            return
        rel = qs.get("path", [""])[0]
        full = resolve_share_path(share, rel)
        if full is None or not os.path.isfile(full):
            self._json(404, {"error": "文件不存在"})
            return
        self.app.record_download(share, rel, full, self.client_address[0])
        self._send_file(full, download_name=os.path.basename(full), inline=False)

    def _api_downloads(self):
        """下载统计：仅本机可查（谁下载过、几次、何时），供管理页防误删判断。"""
        if not self._is_local():
            self._json(403, {"error": "仅本机可查看下载记录"})
            return
        with self.app.lock:
            items = [dict(v) for v in self.app.downloads.values()]
        items.sort(key=lambda x: x["last_ts"], reverse=True)
        self._json(200, {"list": items, "count": len(items)})

    def _api_downloads_clear(self):
        """清空下载记录（仅本机）。只清统计，不影响已下载的文件。"""
        if not self._is_local():
            self._json(403, {"error": "仅本机可操作下载记录"})
            return
        with self.app.lock:
            self.app.downloads = {}
            self.app._save_downloads()
        self.app.broadcast("downloads")
        self._json(200, {"ok": True})

    def _api_zip(self, qs):
        share = self._require_share(qs)
        if not share:
            return
        if not self._require_access(share):
            return
        rel = qs.get("path", ["/"])[0] or "/"
        full = resolve_share_path(share, rel)
        if full is None or not os.path.isdir(full):
            self._json(404, {"error": "文件夹不存在"})
            return
        fd, tmp = tempfile.mkstemp(suffix=".zip")
        os.close(fd)
        try:
            with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
                for root, _dirs, files in os.walk(full):
                    for name in files:
                        fp = os.path.join(root, name)
                        arc = os.path.relpath(fp, full)
                        try:
                            zf.write(fp, arc)
                        except OSError:
                            continue
            self.app.record_download(share, rel, full, self.client_address[0],
                                     name=os.path.basename(full) + ".zip")
            self._send_file(tmp, download_name=os.path.basename(full) + ".zip",
                            inline=False, ctype="application/zip")
        finally:
            try:
                os.unlink(tmp)
            except OSError:
                pass

    # ---- 上传 / 统计 / 限速 ----

    def _api_upload(self, qs):
        share = self._require_share(qs)
        if not share:
            return
        if not self._require_access(share):
            return
        if not share.get("writable"):
            self._json(403, {"error": "该共享为只读，不允许上传"})
            return
        rel = qs.get("path", ["/"])[0] or "/"
        full_dir = resolve_share_path(share, rel)
        if full_dir is None or not os.path.isdir(full_dir):
            self._json(404, {"error": "目标文件夹不存在"})
            return
        name = qs.get("name", [""])[0]
        name = os.path.basename(name.replace("\\", "/")).strip()
        if not name or name in (".", "..") or len(name) > 200:
            self._json(400, {"error": "文件名无效"})
            return
        try:
            total = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            total = 0
        if total <= 0:
            self._json(400, {"error": "请求体为空"})
            return
        target = self._unique_target(full_dir, name)
        fd, tmp = tempfile.mkstemp(dir=str(full_dir), suffix=".part")
        os.close(fd)
        received = 0
        self.app.stats.enter("up")
        try:
            with open(tmp, "wb") as f:
                while received < total:
                    chunk = self.rfile.read(min(CHUNK, total - received))
                    if not chunk:
                        break
                    self.app.limiter.pace(len(chunk))
                    f.write(chunk)
                    self.app.stats.note_in(len(chunk))
                    received += len(chunk)
            if received != total:
                raise IOError("传输中断：%d/%d 字节" % (received, total))
            os.replace(tmp, target)
        except Exception as e:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            self._json(400, {"error": "上传失败：%s" % e})
            return
        finally:
            self.app.stats.leave("up")
        self._log("收到上传：%s (%d 字节)" % (target, received))
        self._json(200, {"ok": True, "name": os.path.basename(target), "size": received})

    @staticmethod
    def _unique_target(full_dir, name):
        candidate = os.path.join(full_dir, name)
        if not os.path.exists(candidate):
            return candidate
        stem, ext = os.path.splitext(name)
        i = 1
        while True:
            candidate = os.path.join(full_dir, "%s (%d)%s" % (stem, i, ext))
            if not os.path.exists(candidate):
                return candidate
            i += 1

    def _api_stats(self):
        self._json(200, self.app.stats.snapshot())

    def _api_limits(self, body):
        if not self._is_local():
            self._json(403, {"error": "仅本机可管理"})
            return
        try:
            kb = int((body or {}).get("speed_limit_kb", 0))
        except (TypeError, ValueError):
            kb = -1
        if kb < 0 or kb > 1000000:
            self._json(400, {"error": "限速值无效（0 = 不限速）"})
            return
        self.app.cfg["speed_limit_kb"] = kb
        self.app.limiter.set_cap_kb(kb)
        self.app.save()
        self._log("限速已更新：%d KB/s" % kb)
        self._json(200, {"ok": True, "speed_limit_kb": kb})

    # ---- 登录 / 会话 ----

    def _api_login(self, body):
        share_id = (body or {}).get("share_id", "")
        password = (body or {}).get("password", "")
        share = self.app.get_share(share_id)
        if not share or share["perm"] != "password" or self._is_local():
            self._json(404, {"error": "该共享无需密码或不存在"})
            return
        ip = self.client_address[0]
        now = time.time()
        dq = self.app.login_attempts.setdefault(ip, deque())
        while dq and now - dq[0] > LOGIN_WINDOW:
            dq.popleft()
        if len(dq) >= LOGIN_LIMIT:
            self._json(429, {"error": "尝试次数过多，请稍后再试"})
            return
        dq.append(now)
        salt = share["pwd_salt"]
        digest = hash_password(password, salt)[1]
        if digest != share["pwd_hash"]:
            self._json(401, {"error": "密码错误"})
            return
        token = secrets.token_hex(16)
        self.app.sessions[token] = {"share": share["id"], "exp": time.time() + TOKEN_TTL}
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie",
                         "ls_%s=%s; Path=/; HttpOnly; SameSite=Lax; Max-Age=%d"
                         % (share["id"], token, TOKEN_TTL))
        self.send_header("Content-Length", str(len(b'{"ok":true}')))
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def _api_logout(self, body):
        share_id = (body or {}).get("share_id", "")
        tok = self._cookie("ls_" + share_id)
        if tok:
            self.app.sessions.pop(tok, None)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Set-Cookie",
                         "ls_%s=; Path=/; HttpOnly; Max-Age=0" % share_id)
        self.send_header("Content-Length", str(len(b'{"ok":true}')))
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    # ---- 管理（仅本机） ----

    def _api_shares_add(self, body):
        if not self._is_local():
            self._json(403, {"error": "仅本机可管理共享"})
            return
        body = body or {}
        name = str(body.get("name", "")).strip()
        path = str(body.get("path", "")).strip()
        perm = str(body.get("perm", "public"))
        password = str(body.get("password", ""))
        writable = bool(body.get("writable"))
        if not name:
            self._json(400, {"error": "请填写共享名称"})
            return
        if not path or not os.path.isdir(path):
            self._json(400, {"error": "文件夹路径无效或不存在"})
            return
        if perm not in ("public", "password", "private"):
            self._json(400, {"error": "权限类型无效"})
            return
        if perm == "password" and len(password) < 4:
            self._json(400, {"error": "密码保护至少需要 4 位密码"})
            return
        share_id = str(body.get("id") or "")
        with self.app.lock:
            if share_id:
                share = self.app.get_share(share_id)
                if not share:
                    self._json(404, {"error": "共享不存在"})
                    return
                share["name"] = name
                share["path"] = os.path.abspath(path)
                share["perm"] = perm
                share["writable"] = writable
                if perm == "password":
                    share["pwd_salt"], share["pwd_hash"] = hash_password(password)
                    share["pwd"] = password   # 明文仅供本机管理页回显
                else:
                    share.pop("pwd_salt", None)
                    share.pop("pwd_hash", None)
                    share.pop("pwd", None)
            else:
                share = {
                    "id": uuid.uuid4().hex[:12],
                    "name": name,
                    "path": os.path.abspath(path),
                    "perm": perm,
                    "writable": writable,
                }
                if perm == "password":
                    share["pwd_salt"], share["pwd_hash"] = hash_password(password)
                    share["pwd"] = password   # 明文仅供本机管理页回显
                self.app.cfg["shares"].append(share)
        self.app.save()
        self._log("共享已更新：%s -> %s (%s)" % (name, path, perm))
        self._json(200, {"ok": True, "share": {"id": share["id"], "name": share["name"],
                                               "perm": share["perm"]}})

    def _api_shares_delete(self, share_id):
        if not self._is_local():
            self._json(403, {"error": "仅本机可管理共享"})
            return
        with self.app.lock:
            self.app.cfg["shares"] = [s for s in self.app.cfg["shares"] if s["id"] != share_id]
        self.app.save()
        self._log("已删除共享：%s" % share_id)
        self._json(200, {"ok": True})

    def _api_config_update(self, body):
        if not self._is_local():
            self._json(403, {"error": "仅本机可管理"})
            return
        body = body or {}
        changed = []
        if "server_name" in body:
            name = str(body.get("server_name", "")).strip()
            if not name or len(name) > 40:
                self._json(400, {"error": "设备名称需为 1-40 个字符"})
                return
            self.app.cfg["server_name"] = name
            changed.append("server_name")
        if "download_dir" in body:
            dl = str(body.get("download_dir", "")).strip()
            if dl and not os.path.isdir(dl):
                self._json(400, {"error": "下载目录不存在或无效"})
                return
            self.app.cfg["download_dir"] = dl
            changed.append("download_dir")
        if not changed:
            self._json(400, {"error": "没有可更新的配置项"})
            return
        self.app.save()
        self._log("配置已更新：%s" % ", ".join(changed))
        self._json(200, {"ok": True, "download_dir": self.app.cfg.get("download_dir", "")})

    # ---- SSE ----

    def _api_events(self):
        q = queue.Queue()
        self.app.add_sse(q)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            while True:
                try:
                    ev, data = q.get(timeout=15)
                    payload = data if data is not None else "{}"
                    self.wfile.write(("event: %s\ndata: %s\n\n" % (ev, payload)).encode("utf-8"))
                except queue.Empty:
                    self.wfile.write(b": hb\n\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self.app.drop_sse(q)

    # ---- 路由 ----

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        qs = urllib.parse.parse_qs(url.query, keep_blank_values=True)
        p = urllib.parse.unquote(url.path)
        try:
            if p in ("/", "/index.html"):
                return self._serve_index()
            if p.startswith("/static/"):
                return self._serve_static(p)
            if p == "/api/config":
                return self._api_config()
            if p == "/api/peers":
                return self._api_peers()
            if p == "/api/stats":
                return self._api_stats()
            if p == "/api/drives":
                return self._api_drives()
            if p == "/api/browse":
                return self._api_browse(qs)
            if p == "/api/list":
                return self._api_list(qs)
            if p == "/api/raw":
                return self._api_raw(qs)
            if p == "/api/download":
                return self._api_download(qs)
            if p == "/api/downloads":
                return self._api_downloads()
            if p == "/api/zip":
                return self._api_zip(qs)
            if p == "/api/events":
                return self._api_events()
            self._json(404, {"error": "接口不存在"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._json(500, {"error": "服务器内部错误：%s" % e})

    def do_POST(self):
        url = urllib.parse.urlsplit(self.path)
        qs = urllib.parse.parse_qs(url.query, keep_blank_values=True)
        p = urllib.parse.unquote(url.path)
        # 仅 JSON 请求才预读请求体；上传等二进制请求由端点直接读 rfile
        ctype = (self.headers.get("Content-Type") or "").lower()
        body = self._read_json() if "json" in ctype else None
        try:
            if p == "/api/shares":
                return self._api_shares_add(body)
            if p == "/api/login":
                return self._api_login(body)
            if p == "/api/logout":
                return self._api_logout(body)
            if p == "/api/config":
                return self._api_config_update(body)
            if p == "/api/upload":
                return self._api_upload(qs)
            if p == "/api/limits":
                return self._api_limits(body)
            if p == "/api/downloads":
                return self._api_downloads_clear()
            m = re.match(r"^/api/shares/([0-9a-f]{12})$", p)
            if m:
                return self._api_shares_delete(m.group(1))
            self._json(404, {"error": "接口不存在"})
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            self._json(500, {"error": "服务器内部错误：%s" % e})

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

def stats_sampler(stop):
    while not stop.is_set():
        stop.wait(1.0)
        out_speed, in_speed, active_down, active_up = app.stats.sample()
        if active_down > 0 or active_up > 0 or out_speed > 0 or in_speed > 0:
            app.broadcast("stats", app.stats.snapshot())


def start_service(port, discovery_on=True):
    """启动 HTTP + 发现 + 统计，供 CLI 与桌面壳嵌入。返回句柄。"""
    app.http_port = port
    stop = threading.Event()
    threads = []
    if discovery_on:
        threads.append(threading.Thread(target=udp_announcer, args=(stop,), daemon=True))
        threads.append(threading.Thread(target=udp_listener, args=(stop,), daemon=True))
        threads.append(threading.Thread(target=peer_pruner, args=(stop,), daemon=True))
    threads.append(threading.Thread(target=stats_sampler, args=(stop,), daemon=True))
    for t in threads:
        t.start()

    Handler.app = app
    httpd = QuietServer(("0.0.0.0", port), Handler)
    httpd.daemon_threads = True

    use_https = (DATA_DIR / "cert.pem").exists() and (DATA_DIR / "key.pem").exists()
    if use_https:
        try:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(str(DATA_DIR / "cert.pem"), str(DATA_DIR / "key.pem"))
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        except Exception as e:
            print("HTTPS 证书加载失败，已回退 HTTP：%s" % e)
            use_https = False

    def _serve():
        try:
            httpd.serve_forever()
        finally:
            stop.set()

    threading.Thread(target=_serve, daemon=True).start()
    return {"httpd": httpd, "stop": stop, "use_https": use_https}


def main():
    parser = argparse.ArgumentParser(description="局域网快传 (LAN Share)")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="HTTP 端口（默认 %d）" % DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="启动后不自动打开浏览器")
    parser.add_argument("--discovery-off", action="store_true", help="关闭 UDP 广播发现")
    args = parser.parse_args()

    try:
        svc = start_service(args.port, discovery_on=not args.discovery_off)
    except OSError as e:
        print("启动失败：%s" % e)
        print("端口 %d 可能被占用，请用 --port 指定其他端口。" % args.port)
        sys.exit(1)

    scheme = "https" if svc["use_https"] else "http"
    ips = get_local_ips()
    print("=" * 56)
    print("  局域网快传 LAN Share  v%s" % VERSION)
    print("  设备名称：%s" % app.cfg["server_name"])
    print("=" * 56)
    print("  本机访问：  %s://127.0.0.1:%d/" % (scheme, args.port))
    for ip in ips:
        print("  局域网访问：%s://%s:%d/   (手机扫码即可)" % (scheme, ip, args.port))
    print("  共享数量：  %d 个（局域网可见 %d 个）" %
          (len(app.cfg["shares"]), app.public_share_count()))
    if args.discovery_off:
        print("  设备发现：  已关闭")
    else:
        print("  设备发现：  组播 %s:%d 实时广播中" % (MCAST_GROUP, MCAST_PORT))
    print("  按 Ctrl+C 停止服务")
    print("=" * 56)

    if not args.no_browser:
        threading.Timer(0.6, lambda: webbrowser.open("%s://127.0.0.1:%d/" % (scheme, args.port))).start()

    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\n正在停止…")
    finally:
        svc["stop"].set()
        svc["httpd"].server_close()


if __name__ == "__main__":
    main()
