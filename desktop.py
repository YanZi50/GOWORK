# -*- coding: utf-8 -*-
"""
局域网快传 LAN Share · 桌面版 v1.0
==================================
PySide6 / QtWebEngine 桌面壳：
* 原生窗口内嵌 Web UI（复用 static/ 前端）
* 系统托盘常驻（关闭窗口最小化到托盘，托盘可退出）
* 开机自启（注册表 HKCU Run）
* 真正的文件夹拖拽共享（Qt 层解析本地目录绝对路径）
* 原生文件夹选择对话框、窗口内浏览其他设备、单实例锁
* --selftest 离屏截图自检模式

用法：
    python desktop.py                # 启动桌面版
    python desktop.py --selftest     # 离屏渲染截图自检（不弹窗）
"""

import base64
import io
import json
import os
import queue
import struct
import sys
import threading
import time
import uuid

from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
# 打包为 exe 后：资源在 _MEIPASS 解包目录，可写数据（配置/图标/截图）放 exe 旁
RES_DIR = Path(getattr(sys, "_MEIPASS", APP_DIR))
DATA_DIR = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else APP_DIR

os.environ.setdefault("QT_ENABLE_HIGHDPI_SCALING", "1")

from PySide6.QtCore import QObject, QSize, QStandardPaths, QUrl, Qt, Signal, Slot, QTimer
from PySide6.QtGui import QAction, QColor, QIcon, QImage, QPixmap
from PySide6.QtWidgets import QApplication, QFileDialog, QMainWindow, QMenu, QMessageBox, QSystemTrayIcon
from PySide6.QtWebChannel import QWebChannel
from PySide6.QtWebEngineCore import QWebEngineScript
from PySide6.QtWebEngineWidgets import QWebEngineView

import server as S  # 复用服务内核（同进程）

try:
    import winreg
except ImportError:
    winreg = None

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_NAME = "LanShare"
DEFAULT_PORT_RANGE = range(8765, 8776)


# --------------------------------------------------------------------------- #
# 开机自启（注册表）
# --------------------------------------------------------------------------- #

def _autostart_cmd():
    if getattr(sys, "frozen", False):
        return '"%s"' % sys.executable
    exe = sys.executable
    if exe.lower().endswith("python.exe"):
        w = exe[:-4] + "w.exe"
        if os.path.exists(w):
            exe = w
    return '"%s" "%s"' % (exe, os.path.abspath(__file__))


def set_autostart(on):
    if winreg is None:
        return False
    try:
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE)
        try:
            if on:
                winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, _autostart_cmd())
            else:
                try:
                    winreg.DeleteValue(k, APP_NAME)
                except FileNotFoundError:
                    pass
        finally:
            winreg.CloseKey(k)
        return True
    except Exception:
        return False


def get_autostart():
    if winreg is None:
        return False
    try:
        k = winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_QUERY_VALUE)
        try:
            winreg.QueryValueEx(k, APP_NAME)
            return True
        except FileNotFoundError:
            return False
        finally:
            winreg.CloseKey(k)
    except Exception:
        return False


# --------------------------------------------------------------------------- #
# 图标生成（SVG -> PNG -> ICO）
# --------------------------------------------------------------------------- #

def _png_bytes(pixmap, size):
    # PySide6 6.11+ 的 save 只接受 QIODevice（BytesIO 已不被支持）
    from PySide6.QtCore import QBuffer, QIODevice
    img = pixmap.toImage()
    if img.size() != QSize(size, size):
        img = img.scaled(size, size, Qt.KeepAspectRatio, Qt.SmoothTransformation)
    buf = QBuffer()
    buf.open(QIODevice.WriteOnly)
    img.save(buf, "PNG")
    return bytes(buf.data())


def build_icons():
    """从 favicon.svg 渲染出窗口/托盘图标，并生成 icon.ico（供打包用）。"""
    svg = RES_DIR / "static" / "favicon.svg"
    icon = QIcon()
    try:
        for s in (16, 32, 48, 64, 128, 256):
            pix = QPixmap(str(svg))
            if pix.isNull():
                break
            icon.addPixmap(pix.scaled(s, s, Qt.KeepAspectRatio, Qt.SmoothTransformation))
    except Exception:
        icon = QIcon()
    # 写 icon.ico（PNG 内嵌格式）
    try:
        pngs = []
        for s in (16, 32, 48, 64, 128, 256):
            pix = QPixmap(str(svg))
            if pix.isNull():
                continue
            pngs.append((s, _png_bytes(pix, s)))
        if pngs:
            header = struct.pack("<HHH", 0, 1, len(pngs))
            entries = b""
            offset = 6 + 16 * len(pngs)
            for s, data in pngs:
                w = 0 if s >= 256 else s
                h = 0 if s >= 256 else s
                entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(data), offset)
                offset += len(data)
            ico = header + entries + b"".join(d for _, d in pngs)
            (DATA_DIR / "icon.ico").write_bytes(ico)
    except Exception:
        pass
    return icon


# --------------------------------------------------------------------------- #
# 原生桥（JS <-> Python）
# --------------------------------------------------------------------------- #

class NativeBridge(QObject):
    def __init__(self, window):
        super().__init__()
        self.window = window

    @Slot(result=str)
    def pickFolder(self):
        path = QFileDialog.getExistingDirectory(None, "选择要共享的文件夹")
        return path or ""

    @Slot(result=str)
    def pickDownloadDir(self):
        path = QFileDialog.getExistingDirectory(None, "选择下载保存位置")
        return path or ""

    @Slot(str, result=str)
    def addFolder(self, path):
        """桌面端拖拽/传入文件夹 -> 直接添加为公开共享。返回 JSON 字符串。"""
        if not path or not os.path.isdir(path):
            return json.dumps({"ok": False, "error": "文件夹路径无效"})
        real = os.path.realpath(path)
        name = os.path.basename(real.rstrip("\\/")) or "共享文件夹"
        with S.app.lock:
            for s in S.app.cfg["shares"]:
                if os.path.normcase(os.path.realpath(s["path"])) == os.path.normcase(real):
                    return json.dumps({"ok": True, "share": s["id"], "dup": True})
            share = {
                "id": uuid.uuid4().hex[:12],
                "name": name,
                "path": real,
                "perm": "public",
                "writable": False,
            }
            S.app.cfg["shares"].append(share)
        S.app.save()  # 触发 config 广播，所有页面实时刷新
        return json.dumps({"ok": True, "share": share["id"]})

    @Slot(bool)
    def setAutostart(self, on):
        set_autostart(bool(on))

    @Slot(result=bool)
    def getAutostart(self):
        return get_autostart()

    @Slot(str)
    def copyText(self, text):
        """写入系统剪贴板（网页 navigator.clipboard 在 QtWebEngine 里无权限，由桌面端代写）。"""
        from PySide6.QtWidgets import QApplication
        QApplication.clipboard().setText(text or "")

    # ---- 下载中心（本机下载历史，与共享下载统计完全独立） ----
    @Slot(result=str)
    def getLocalDownloads(self):
        items = self.window._load_local_downloads()
        # 历史记录里「未定位」的外部浏览器下载：尝试补一次定位（近 24 小时同名同大小）
        changed = False
        for it in items:
            if it.get("dir"):
                continue
            if not it.get("name"):
                continue
            ddir, dpath = _locate_browser_download(
                None, it.get("name"), it.get("size") or 0, age=86400)
            if dpath or ddir:
                it["dir"], it["path"] = ddir, dpath
                changed = True
        if changed:
            self.window._save_local_downloads(items[:200])
        # 每条记录标注文件/目录是否仍存在（用于前端显示「找不到」）
        for it in items:
            p = it.get("path") or ""
            d = it.get("dir") or ""
            if p and os.path.exists(p):
                it["exists"] = True
            elif d and os.path.isdir(d):
                it["exists"] = True
            else:
                it["exists"] = False
        return json.dumps(items)

    @Slot(str, result=bool)
    def removeLocalDownload(self, key):
        return self.window._remove_local_download(key)

    @Slot(result=bool)
    def clearLocalDownloads(self):
        return self.window._clear_local_downloads()

    @Slot(str, str)
    def openDownloadFolder(self, dir, path=""):
        """打开下载文件所在文件夹（Windows 资源管理器）；path 存在时选中该文件。"""
        try:
            if path and os.path.isfile(path):
                os.startfile(os.path.dirname(path))  # noqa
                return
            if dir and os.path.isdir(dir):
                os.startfile(dir)  # noqa
        except Exception:
            pass

    @Slot()
    def goHome(self):
        self.window.go_home()

    @Slot(str)
    def openPeer(self, addr):
        self.window.go_peer(addr)


# --------------------------------------------------------------------------- #
# 可拖拽 WebView（目录拖放 -> Qt 层拿到绝对路径）
# --------------------------------------------------------------------------- #

class DragWebView(QWebEngineView):
    droppedFolders = Signal(list)

    @staticmethod
    def _local_dirs(mime):
        if not mime.hasUrls():
            return []
        return [u.toLocalFile() for u in mime.urls()
                if u.isLocalFile() and os.path.isdir(u.toLocalFile())]

    def contextMenuEvent(self, e):
        # 去掉 QtWebEngine 默认的英文右键菜单（对小白无用）
        e.ignore()

    def dragEnterEvent(self, e):
        if self._local_dirs(e.mimeData()):
            e.acceptProposedAction()
        else:
            super().dragEnterEvent(e)

    def dragMoveEvent(self, e):
        if self._local_dirs(e.mimeData()):
            e.acceptProposedAction()
        else:
            super().dragMoveEvent(e)

    def dropEvent(self, e):
        dirs = self._local_dirs(e.mimeData())
        if dirs:
            self.droppedFolders.emit(dirs)
            e.acceptProposedAction()
        else:
            super().dropEvent(e)


# --------------------------------------------------------------------------- #
# 主窗口
# --------------------------------------------------------------------------- #

# ---------------- 浏览器下载目录探测（外部浏览器下载的保存位置） ----------------

def _browser_download_dirs():
    """探测 Chrome/Edge 下载目录与系统默认「下载」文件夹（Windows）。

    外部浏览器下载本机共享时，浏览器自行决定保存位置；软件无法接管，
    但可以读取浏览器配置定位其下载目录，让「下载中心」可跳转打开。
    """
    dirs = []
    try:
        base = os.environ.get("LOCALAPPDATA", "")
        for sub in ("Google\\Chrome\\User Data\\Default\\Preferences",
                    "Microsoft\\Edge\\User Data\\Default\\Preferences"):
            p = os.path.join(base, sub)
            if not os.path.isfile(p):
                continue
            try:
                data = json.loads(open(p, encoding="utf-8").read())
                d = (data.get("download") or {}).get("default_directory")
                if d:
                    d = os.path.expandvars(d)
                    if os.path.isdir(d):
                        dirs.append(d)
            except Exception:
                pass
    except Exception:
        pass
    try:
        import winreg
        with winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders") as k:
            v, _ = winreg.QueryValueEx(k, "{374DE290-123F-4565-9164-39C4925E467B}")
        d = os.path.expandvars(v)
        if os.path.isdir(d):
            dirs.append(d)
    except Exception:
        pass
    # 去重
    seen, out = set(), []
    for d in dirs:
        k = os.path.normcase(os.path.realpath(d))
        if k not in seen:
            seen.add(k)
            out.append(d)
    return out


def _locate_browser_download(src_path=None, name="", size=0, age=240):
    """在浏览器下载目录里找「最近下载的同名同大小」文件，返回 (目录, 文件路径)。

    浏览器重名时会自动改名如 “name (1).ext”，这里按 basename 前缀匹配。
    src_path 可空（历史记录补定位时无源文件）；size 直接传入。
    """
    try:
        if size <= 0 and src_path and os.path.isfile(src_path):
            size = os.path.getsize(src_path)
    except Exception:
        size = 0
    if not name:
        return "", ""
    stem = os.path.splitext(name)[0]
    now = time.time()
    for d in _browser_download_dirs():
        try:
            for f in os.listdir(d):
                p = os.path.join(d, f)
                if not os.path.isfile(p):
                    continue
                try:
                    if now - os.path.getmtime(p) > age:
                        continue
                except Exception:
                    continue
                # 目录下载（浏览器存为 <文件夹名>.zip）按 zip 名匹配；文件按原名/重名变体匹配
                zip_name = name + ".zip"
                if f != name and f != zip_name and not os.path.splitext(f)[0].startswith(stem + " ("):
                    continue
                try:
                    if size and abs(os.path.getsize(p) - size) > 16:
                        continue
                except Exception:
                    continue
                return d, p
        except Exception:
            continue
    return "", ""


# ---------------- 主窗口 ----------------

class MainWindow(QMainWindow):
    def __init__(self, local_url, icon):
        super().__init__()
        self.local_url = local_url
        self.quitting = False
        self.tray_announced = False

        self.setWindowTitle("局域网快传 LAN Share")
        self.setWindowIcon(icon)
        self.resize(1100, 720)
        self.setMinimumSize(900, 600)

        self.view = DragWebView(self)
        self.setCentralWidget(self.view)
        self.view.droppedFolders.connect(self.on_folders_dropped)

        # --- 注入：桌面标志 + 本地地址常量 + qwebchannel ---
        page = self.view.page()
        js = QWebEngineScript()
        js.setName("lanshare_globals")
        js.setInjectionPoint(QWebEngineScript.DocumentCreation)
        js.setWorldId(QWebEngineScript.MainWorld)
        js.setSourceCode(
            "window.LANSHARE_DESKTOP = true;\n"
            "window.LANSHARE_LOCAL_ORIGIN = %r;\n" % local_url
        )
        page.scripts().insert(js)

        qjs = self._find_qwebchannel_js()
        if qjs:
            js2 = QWebEngineScript()
            js2.setName("qwebchannel_loader")
            js2.setInjectionPoint(QWebEngineScript.DocumentCreation)
            js2.setWorldId(QWebEngineScript.MainWorld)
            js2.setSourceCode(qjs.read_text(encoding="utf-8"))
            page.scripts().insert(js2)

        # --- WebChannel 桥 ---
        self.bridge = NativeBridge(self)
        self.channel = QWebChannel(page)
        self.channel.registerObject("bridge", self.bridge)
        page.setWebChannel(self.channel)

        # server（HTTP 线程）回调的本机下载事件：入队后由主线程 QTimer 轮询处理
        self._dl_note_q = queue.Queue()
        self._note_timer = QTimer(self)
        self._note_timer.timeout.connect(self._drain_dl_notes)
        self._note_timer.start(120)

        self.view.load(QUrl(local_url))

    @staticmethod
    def _find_qwebchannel_js():
        local = RES_DIR / "static" / "qwebchannel.js"
        if local.exists():
            return local
        try:
            from PySide6 import QtWebChannel
            root = Path(QtWebChannel.__file__).resolve().parent
            for hit in root.rglob("qwebchannel.js"):
                return hit
        except Exception:
            pass
        return None

    def on_folders_dropped(self, paths):
        # 拖入目录 -> 不直接共享：把真实路径交给页面「添加共享」表单，
        # 由用户确认设置后点「保存共享」才生效（避免误拖即共享）。
        for p in paths:
            if os.path.isdir(p):
                real = os.path.realpath(p)
                self._run_js("window.__lanshareDropPath && window.__lanshareDropPath(%s)"
                             % json.dumps(real))
                return

    def _run_js(self, code):
        self.view.page().runJavaScript(code)

    def go_home(self):
        self.view.setUrl(QUrl(self.local_url))

    def go_peer(self, addr):
        self.view.setUrl(QUrl("http://%s/" % addr))

    # ---- 本机下载历史（下载中心），持久化到 data_dir/downloads_local.json ----
    def _drain_dl_notes(self):
        try:
            while True:
                share, rel, full, saved = self._dl_note_q.get_nowait()
                self._note_local_download(share, rel, full, saved)
        except queue.Empty:
            pass

    def _local_dl_file(self):
        # 跟随 server 数据目录：selftest 隔离时也隔离，不污染真实数据
        return Path(getattr(S, "DATA_DIR", DATA_DIR)) / "downloads_local.json"
    def _load_local_downloads(self):
        try:
            p = self._local_dl_file()
            if p.exists():
                data = json.loads(p.read_text(encoding="utf-8"))
                return data.get("items", [])
        except Exception:
            pass
        return []

    def _save_local_downloads(self, items):
        try:
            p = self._local_dl_file()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps({"v": 1, "items": items}, ensure_ascii=False),
                         encoding="utf-8")
            return True
        except Exception:
            return False

    def _remove_local_download(self, key):
        items = self._load_local_downloads()
        left = [it for it in items if it.get("key") != key]
        if len(left) != len(items):
            return self._save_local_downloads(left)
        return False

    def _clear_local_downloads(self):
        return self._save_local_downloads([])

    # 本机下载自己的共享（Qt 窗口或外部浏览器访问本机地址）：
    # server 在下载统计里识别本机来源，回调这里补充「下载中心」历史。
    # 注意在 handler 线程回调，切到主线程再写文件/推事件。
    def _note_local_download(self, share, rel, full, saved=""):
        try:
            items = self._load_local_downloads()
            name = (os.path.basename(full) or rel.rsplit("/", 1)[-1] or "下载文件")
            size = os.path.getsize(full) if os.path.isfile(full) else 0
            key = os.path.normcase(os.path.realpath(full)) if os.path.exists(full) \
                else "srv:%s:%s" % (share.get("id", ""), rel)
            # 已有同路径记录（Qt 下载已写）且保存位置已知：不覆盖。
            # 同一文件若已有近期（30 秒内）带真实路径的记录（Qt 窗口内下载），也不再补空记录。
            now = time.time()
            for it in items:
                if it.get("key") == key and it.get("dir"):
                    return
            for it in items:
                if it.get("name") == name and it.get("dir") and now - float(it.get("ts", 0)) < 30:
                    return
            # 保存位置：优先用 server 接管复制的真实路径（文件/目录都算）；否则探测浏览器下载目录
            ddir, dpath = "", ""
            if saved and os.path.exists(saved):
                if os.path.isfile(saved):
                    ddir, dpath = os.path.dirname(saved), saved
                else:
                    # 目录复制：保存位置就是该目录本身
                    ddir, dpath = saved, saved
            elif os.path.isfile(full):
                ddir, dpath = _locate_browser_download(full, name, size)
                if not dpath:
                    dirs = _browser_download_dirs()
                    if dirs:
                        ddir = dirs[0]
            elif os.path.isdir(full):
                # 外部浏览器下载的目录（ZIP）：按 <名字>.zip 在浏览器目录补定位
                ddir, dpath = _locate_browser_download(None, name, size)
            items = [it for it in items if it.get("key") != key]
            items.insert(0, {"key": key, "name": name, "size": size,
                             "dir": ddir, "path": dpath, "ts": now})
            self._save_local_downloads(items[:200])
            self.view.page().runJavaScript(
                "window.__lanshareDlEvent && window.__lanshareDlEvent(" +
                json.dumps({"type": "done", "id": key, "name": name,
                            "dir": ddir, "path": dpath, "size": size,
                            "ts": now}, ensure_ascii=False) + ")")
        except Exception:
            pass

    def closeEvent(self, e):
        if self.quitting:
            e.accept()
            return
        e.ignore()
        self.hide()
        if not self.tray_announced and self.tray.isVisible():
            self.tray_announced = True
            self.tray.showMessage(
                "局域网快传仍在运行",
                "已最小化到系统托盘，右键托盘图标可退出。",
                QSystemTrayIcon.Information, 2500)


# --------------------------------------------------------------------------- #
# 单实例锁
# --------------------------------------------------------------------------- #

class SingleInstance:
    def __init__(self, name):
        from PySide6.QtCore import QLockFile
        import tempfile
        self.lock = QLockFile(str(Path(tempfile.gettempdir()) / (name + ".lock")))
        self.lock.setStaleLockTime(0)

    def try_lock(self):
        return self.lock.tryLock(100)


# --------------------------------------------------------------------------- #
# 入口
# --------------------------------------------------------------------------- #

def run():
    import argparse
    parser = argparse.ArgumentParser(description="局域网快传 · 桌面版")
    parser.add_argument("--selftest", action="store_true", help="自检：真实窗口渲染 DOM 断言 + 截图（约 8 秒），不常驻")
    parser.add_argument("--port", type=int, default=0, help="指定端口（默认自动选 8765-8775）")
    args = parser.parse_args()

    if args.selftest:
        # 自检全程使用隔离数据目录，绝不读写用户真实配置 / 下载记录
        import tempfile as _tf
        _iso = Path(_tf.mkdtemp(prefix="lanshare_selftest_data_"))
        S.DATA_DIR = _iso
        S.CONFIG_FILE = _iso / "config.json"
        S.DOWNLOAD_FILE = _iso / "downloads.json"
        # server 模块在 import 时已实例化 App（模块级 app = App()），其内存里已加载
        # 旧数据目录的配置/下载记录，必须重建实例，否则自检会读到用户真实数据
        S.app = S.App()
    else:
        # 数据目录与桌面保持一致：源码运行 = 项目根；打包 exe = exe 所在目录。
        # 不重定向的话，PyInstaller 打包后 server 会写进临时解压目录，退出即丢配置。
        S.DATA_DIR = DATA_DIR
        S.CONFIG_FILE = DATA_DIR / "config.json"
        S.DOWNLOAD_FILE = DATA_DIR / "downloads.json"
        S.app = S.App()

    app = QApplication(sys.argv)
    app.setApplicationName("局域网快传")
    app.setQuitOnLastWindowClosed(False)

    if not args.selftest:
        guard = SingleInstance("lanshare")
        if not guard.try_lock():
            QMessageBox.information(None, "局域网快传", "程序已在运行，请在托盘图标处打开。")
            return 0

    # 启动服务内核（自动挑选可用端口）。自检强制用高位端口，
    # 彻底避开用户实际使用的 8765-8775，防止与正在运行的实例抢端口。
    if args.selftest:
        port = 19500 + (int.from_bytes(os.urandom(2), "big") % 400)
    else:
        port = args.port or next((p for p in DEFAULT_PORT_RANGE if not _port_busy(p)), 8765)
    try:
        svc = S.start_service(port, discovery_on=True)
    except OSError as e:
        QMessageBox.critical(None, "局域网快传", "服务启动失败：%s" % e)
        return 1

    scheme = "https" if svc["use_https"] else "http"
    local_url = "%s://127.0.0.1:%d/" % (scheme, port)

    icon = build_icons()
    win = MainWindow(local_url, icon)

    # server 识别到本机下载（自己的共享）时，回调桌面端补充「下载中心」历史。
    # 回调来自 HTTP 线程：仅入队，由主线程 QTimer 轮询处理（线程安全、事件循环无关）。
    try:
        S.app.on_local_download = lambda share, rel, full, saved="": win._dl_note_q.put((share, rel, full, saved))
    except Exception:
        pass

    # 下载位置：若已配置 download_dir 则静默存到该目录；未配置则弹窗让用户选择并自动记住
    try:
        from PySide6.QtWebEngineWidgets import QWebEngineProfile
        from PySide6.QtCore import QByteArray

        _dl_running = {}   # id -> {"name", "dir", "size"}

        def _push_dl(payload):
            try:
                win.view.page().runJavaScript(
                    "window.__lanshareDlEvent && window.__lanshareDlEvent(" +
                    json.dumps(payload, ensure_ascii=False) + ")")
            except Exception:
                pass

        def _on_download(item):
            from PySide6.QtWidgets import QFileDialog
            dl_dir = (S.app.cfg.get("download_dir") or "").strip()
            if not dl_dir:
                # 默认没有路径：提醒并让用户选择一次，之后固定保存到该目录
                dl_dir = QFileDialog.getExistingDirectory(win, "请选择下载保存位置（选一次后自动记住）")
                if not dl_dir:
                    item.cancel()
                    return
                with S.app.lock:
                    S.app.cfg["download_dir"] = dl_dir
                S.app.save()
            path = os.path.join(dl_dir, item.suggestedFileName() or "download")
            item.setPath(path)
            item.accept()

            # ---- 下载中心：进度实时推送 + 完成后写入本机历史 ----
            fname = item.suggestedFileName() or "download"
            item_id = str(time.time()).replace(".", "")[:14]
            _dl_running[item_id] = {"name": fname, "dir": dl_dir,
                                    "size": item.totalBytes() or 0}
            _push_dl({"type": "start", "id": item_id, "name": fname,
                      "dir": dl_dir, "size": item.totalBytes() or 0,
                      "ts": time.time()})

            def _on_progress(received, total):
                info = _dl_running.get(item_id)
                if not info:
                    return
                _push_dl({"type": "progress", "id": item_id,
                          "received": int(received), "total": int(total),
                          "ts": time.time()})

            def _on_finished():
                info = _dl_running.pop(item_id, None) or {}
                fname2 = info.get("name") or fname
                ddir = info.get("dir") or dl_dir
                size = info.get("size") or item.totalBytes() or 0
                full = item.path() or os.path.join(ddir, fname2)
                # 去重：同一路径只保留一条（更新时间）；同时合并 server 回调先写下的
                # 同名「浏览器下载」空记录（dir 为空）为真实路径，避免同一文件显示两条
                items = win._load_local_downloads()
                key = os.path.normcase(os.path.realpath(full))
                items = [it for it in items
                         if it.get("key") != key
                         and not (it.get("name") == fname2 and not it.get("dir"))]
                items.insert(0, {
                    "key": key, "name": fname2, "size": size,
                    "dir": ddir, "path": full, "ts": time.time(),
                })
                win._save_local_downloads(items[:200])
                _push_dl({"type": "done", "id": item_id, "name": fname2,
                          "dir": ddir, "path": full, "size": size,
                          "ts": time.time()})

            try:
                item.downloadProgress.connect(_on_progress)
                item.finished.connect(_on_finished)
            except Exception:
                pass

        QWebEngineProfile.defaultProfile().downloadRequested.connect(_on_download)
    except Exception:
        pass  # 极老版本降级：仍按默认目录下载

    # --- 托盘 ---
    tray = QSystemTrayIcon(icon, app)
    win.tray = tray
    tray.setToolTip("局域网快传 LAN Share")
    menu = QMenu()
    act_show = QAction("显示主界面", menu)
    act_show.triggered.connect(lambda: _show_window(win))
    act_quit = QAction("退出", menu)
    act_quit.triggered.connect(lambda: _quit(win, app))
    menu.addAction(act_show)
    menu.addSeparator()
    menu.addAction(act_quit)
    tray.setContextMenu(menu)
    tray.show()
    win.tray_menu = menu

    # 双击托盘图标 -> 唤出主界面
    tray.activated.connect(lambda reason: _show_window(win)
                           if reason == QSystemTrayIcon.DoubleClick else None)

    if args.selftest:
        return _selftest(app, win, svc)

    win.show()

    # 首次启动提示
    QTimer.singleShot(1200, lambda: (
        tray.showMessage("局域网快传已启动", "本机地址 %s\n手机扫码即可访问，窗口关闭后最小化到托盘。"
                         % local_url, QSystemTrayIcon.Information, 4000)))

    ret = app.exec()
    svc["stop"].set()
    svc["httpd"].server_close()
    return ret


def _port_busy(port):
    import socket as _s
    s = _s.socket(_s.AF_INET, _s.SOCK_STREAM)
    try:
        s.settimeout(0.6)
        s.connect(("127.0.0.1", port))
        return True  # 能连上 = 已有服务在听
    except OSError:
        return False
    finally:
        s.close()


def _show_window(win):
    win.go_home()
    win.show()
    win.raise_()
    win.activateWindow()


def _quit(win, app):
    win.quitting = True
    win.tray.hide()
    app.quit()


def _selftest(app, win, svc):
    """真实窗口渲染：DOM 断言 + 两张截图（共享视图 / 管理视图），随后自动退出。"""
    port = svc["httpd"].server_address[1]

    # 诊断：实例归属（隔离是否真正生效）
    try:
        _s_app = getattr(S, "app", None)
        _h_app = getattr(S, "Handler", None).app if getattr(S, "Handler", None) else None
        print("SELFTEST_APP_CHK port=%d S.app==Handler.app:%s S.app.shares:%d Handler.app.shares:%d"
              % (port, _s_app is _h_app,
                 len(_s_app.cfg["shares"]) if _s_app else -1,
                 len(_h_app.cfg["shares"]) if _h_app else -1))
    except Exception as _e:
        print("SELFTEST_APP_CHK_ERR", _e)

    # 隔离：清掉真实配置里的旧共享，只保留测试共享（避免自检点到真实目录）。
    # 注意 server 模块在 import 时已实例化 App（模块级 app = App()），其内存里已加载
    # 用户真实配置与下载记录，必须在此一并清空，否则自检会把真实数据当自己的。
    with S.app.lock:
        S.app.cfg["shares"] = []
        S.app.downloads = {}
        S.app.save()

    # 造一个测试共享，便于截图有内容
    tmp = Path(os.environ.get("TEMP", "/tmp")) / "lanshare_selftest"
    tmp.mkdir(exist_ok=True)
    (tmp / "示例文件.txt").write_text("hello lan share preview", encoding="utf-8")
    (tmp / "说明文档.md").write_text("# 标题\n\n- 列表项一\n- 列表项二\n\n**加粗**与`行内代码`", encoding="utf-8")
    _sub = tmp / "子文件夹"
    _sub.mkdir(exist_ok=True)
    (_sub / "内文件.txt").write_text("inside folder", encoding="utf-8")
    (tmp / "photo.png").write_bytes(
        base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="))
    try:
        win.bridge.addFolder(str(tmp))
    except Exception:
        pass

    # 再补 4 个共享（共 6 个）——复现用户"共享多 + 网格 3 列"场景，验证切换页面卡片网格不跳动
    for _i in range(4):
        with S.app.lock:
            S.app.cfg["shares"].append({
                "id": uuid.uuid4().hex[:8], "name": "布局测试%d" % _i,
                "path": str(tmp), "perm": "public", "password": "", "writable": False})
        S.app.save()

    # 模拟一次局域网下载，验证管理页「下载记录」面板有真实内容。
    # 设置 download_dir → 本机下载被 server 接管复制到该目录（验证落盘路径）。
    _dl_zone = tmp / "保存区"
    with S.app.lock:
        S.app.cfg["download_dir"] = str(_dl_zone)
        _sid = S.app.cfg["shares"][0]["id"]
    try:
        import urllib.request as _ur
        import urllib.parse as _up
        _ur.urlopen("http://127.0.0.1:%d/api/download?share=%s&path=%s"
                    % (port, _sid, _up.quote("/示例文件.txt")), timeout=5).read()
    except Exception:
        pass

    # 加一个密码共享，验证编辑时明文密码回填
    try:
        import urllib.request as _ur
        _req = _ur.Request("http://127.0.0.1:%d/api/shares" % port,
                           data=json.dumps({"name": "密码测试", "path": str(tmp),
                                            "perm": "password", "password": "test123"}).encode("utf-8"),
                           headers={"Content-Type": "application/json"})
        _ur.urlopen(_req, timeout=5).read()
    except Exception:
        pass

    out = DATA_DIR / "_selftest_shares.png"
    out2 = DATA_DIR / "_selftest_admin.png"
    out3 = DATA_DIR / "_selftest_browse.png"
    out4 = DATA_DIR / "_selftest_preview.png"
    checks = []

    def run_js_checks(tag):
        code = (
            "JSON.stringify({" +
            " tag: %r," % tag +
            " title: document.title," +
            " speedBox: !!document.getElementById('speedBox')," +
            " speedDown: document.getElementById('speedDown') && document.getElementById('speedDown').textContent," +
            " deskVisible: !document.getElementById('desktopSettings') || !document.getElementById('desktopSettings').hidden," +
            " dropZone: !!document.getElementById('dropZone')," +
            " badgeWrite: !!document.querySelector('.badge-write')," +
            " shareCards: document.querySelectorAll('.share-card').length," +
            " hasShare: !!document.querySelector('.share-card')," +
            " native: !!window.native," +
            " qc: typeof window.QWebChannel," +
            " qtType: typeof qt," +
            " qtwct: !!qt.webChannelTransport," +
            " btnUpload: !!document.getElementById('btnUpload')," +
            " uploadList: !!document.getElementById('uploadList')," +
            " dropHint: !!document.querySelector('.drop-hint')," +
            " fileRows: document.querySelectorAll('.file-row').length," +
            " fileNames: Array.prototype.slice.call(document.querySelectorAll('.row-name')).map(function(x){return x.textContent;}).join(',')," +
            " previewVisible: !document.getElementById('previewModal') || !document.getElementById('previewModal').hidden," +
            " txtText: (document.getElementById('txtView')||{}).textContent || ''," +
            " imgLoaded: (function(){ var i=document.querySelector('#previewBody img'); return i ? (i.naturalWidth>0) : false; })()," +
            " diag: (window.__diag ? JSON.stringify(window.__diag) : '')," +
            " dlRows: document.querySelectorAll('#dlList .dl-row:not(.dl-head)').length," +
            " dlText: (document.getElementById('dlList')||{}).textContent ? document.getElementById('dlList').textContent.slice(0,120) : ''," +
            " dlPeerText: (function(){ var c=document.querySelector('#dlList .dl-row:not(.dl-head) span:nth-child(3)'); return c?c.textContent:''; })()," +
            " ctxMenu: !!document.querySelector('.ctx-menu')," +
            " advBodyOpen: (function(){ var b=document.querySelector('#advCard .ac-body'); return b?!b.hidden:false; })()," +
            " acCards: document.querySelectorAll('#adminList .ac-card').length," +
            " acOpen: (function(){ var b=document.querySelector('#adminList .ac-body'); return b ? !b.hidden : false; })()," +
            " acPwdVal: (function(){ var v=''; document.querySelectorAll('#adminList input[data-f=pwd]').forEach(function(i){ if(i.value) v=i.value; }); return v; })()," +
            " themeBtn: !!document.getElementById('themeBtn')," +
            " themeMode: document.documentElement.dataset.theme || 'dark'," +
            " advCard: !!document.getElementById('advCard')," +
            " advAuto: !!document.getElementById('advAutostart')," +
            " dlDirEl: !!document.getElementById('dlDirVal')," +
            " pickBtn: !!document.getElementById('btnPickDlDir')," +
            " saveDlBtn: !!document.getElementById('btnSaveDlDir')," +
            " dlTabVisible: !document.getElementById('dlTab') || !document.getElementById('dlTab').hidden," +
            " dlcFn: (typeof window.__lanshareDlEvent === 'function') ? 'yes' : 'no'," +
            " dlcTabs: document.querySelectorAll('.dlc-tabs').length," +
            " dlcRows: document.querySelectorAll('.dlc-row').length," +
            " pvTabs: document.querySelectorAll('.pv-tabs').length," +
            " pvMd: document.querySelectorAll('.pv-md').length," +
            " copyFn: typeof copyTextToClipboard === 'function' ? 'yes' : 'no'," +
            " pickDirFn: (window.native && typeof window.native.pickDownloadDir === 'function') ? 'yes' : 'no'," +
            " cfgPort: location.port || ''," +
            " dlMore: !!document.querySelector('[data-dl-more]')," +
            " dropPathVal: (document.getElementById('fPath') || {}).value || ''," +
            " backHomeHidden: !document.getElementById('backHome') || document.getElementById('backHome').hidden," +
            " bodyLen: document.body.innerHTML.length" +
            "})"
        )
        win.view.page().runJavaScript(code, 0, lambda v: checks.append(v))

    def snap(path):
        # 让 WebEngine 合成完成再抓图（否则可能抓到全黑）
        for _ in range(12):
            QApplication.processEvents()
            time.sleep(0.05)
        win.grab().save(str(path))

    def shot1():
        run_js_checks("shares")
        snap(out)
        # scrollbar-gutter 是否生效：固定滚动条槽位，避免切换页面内容区宽度抖动
        win.view.page().runJavaScript(
            "(function(){"
            " var a = document.createElement('div'); a.style.cssText='overflow-y:scroll;width:200px;scrollbar-gutter:stable;';"
            " var b = document.createElement('div'); b.style.cssText='overflow-y:auto;width:200px;scrollbar-gutter:stable;';"
            " document.body.appendChild(a); document.body.appendChild(b);"
            " var r = JSON.stringify({scrollW: 200 - a.clientWidth, autoW: b.clientWidth});"
            " a.remove(); b.remove(); return r; })()",
            0, lambda v: checks.append("GUTTER " + str(v)))
        # 布局稳定性：打开共享 -> 返回 -> 切管理 -> 切回，卡片网格列数与宽度必须一致
        win.view.page().runJavaScript(
            "(function(){"
            " var g = document.querySelector('.card-grid');"
            " window.__lay0 = g ? JSON.stringify({cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,"
            " vw: document.getElementById('view').clientWidth}) : 'none';"
            " var b = document.querySelector('.share-card [data-act=open]'); if (b) b.click();"
            " return 'ok'; })()",
            0, lambda v: None)
        QTimer.singleShot(800, shot1b)

    def shot1b():
        # 返回共享列表后记录布局；随后切到管理页
        win.view.page().runJavaScript(
            "(function(){"
            " var home = document.getElementById('btnHome'); if (home) home.click();"
            " var g = document.querySelector('.card-grid');"
            " window.__lay1 = g ? JSON.stringify({cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,"
            " vw: document.getElementById('view').clientWidth}) : 'none';"
            " var t = document.querySelector('.tab[data-view=admin]'); if (t) t.click();"
            " return 'ok'; })()",
            0, lambda v: None)
        QTimer.singleShot(900, shot1c)

    def shot1c():
        # 从管理页切回共享文件夹，对比布局是否与基线一致
        win.view.page().runJavaScript(
            "(function(){"
            " var t = document.querySelector('.tab[data-view=shares]'); if (t) t.click();"
            " var g = document.querySelector('.card-grid');"
            " window.__lay2 = g ? JSON.stringify({cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,"
            " vw: document.getElementById('view').clientWidth}) : 'none';"
            " return JSON.stringify({lay0: window.__lay0, lay1: window.__lay1, lay2: window.__lay2}); })()",
            0, lambda v: checks.append("LAYOUT " + str(v)))
        QTimer.singleShot(900, shot1d)

    def shot1d():
        # 把测试共享设为可写（模拟用户在管理页勾选"可上传"）
        with S.app.lock:
            for s in S.app.cfg["shares"]:
                s["writable"] = True
        S.app.save()  # 广播 config，页面实时刷新徽标
        win.view.page().runJavaScript(
            "document.querySelector('.tab[data-view=admin]') && "
            "document.querySelector('.tab[data-view=admin]').click()")
        QTimer.singleShot(1800, shot2)

    def shot2():
        run_js_checks("admin")
        snap(out2)
        # 展开第一个共享卡片 + 展开高级设置卡 + 切换亮色主题（交互验证）
        win.view.page().runJavaScript(
            "(function(){"
            " var h = document.querySelector('#adminList .ac-head'); if (h) h.click();"
            " var adv = document.querySelector('#advCard [data-adv-toggle]'); if (adv) adv.click();"
            " var t = document.getElementById('themeBtn'); if (t) t.click();"
            " return 'ok'; })()")
        QTimer.singleShot(700, shot2b)

    def shot2b():
        run_js_checks("admin2")
        # 模拟桌面端拖入文件夹 -> 应自动展开「添加共享」并填入路径（保存才生效）
        _drop_test = json.dumps(str(tmp))
        win.view.page().runJavaScript(
            "window.__lanshareDropPath && window.__lanshareDropPath(%s); 'ok'" % _drop_test)
        QTimer.singleShot(900, shot2c)

    def shot2c():
        run_js_checks("admin3")
        # 保存共享（触发 renderAdmin 全量重渲染）→ 高级设置卡应保持展开（折叠状态持久化）
        win.view.page().runJavaScript(
            "(function(){ var b=document.querySelector('#adminList [data-ac-save]'); if (b) b.click(); return 'ok'; })()")
        QTimer.singleShot(900, shot2c3)

    def shot2c3():
        run_js_checks("admin_saved")
        # 打开可写共享的浏览视图（验证上传 UI）
        win.view.page().runJavaScript(
            "document.querySelector('.tab[data-view=shares]') && "
            "document.querySelector('.tab[data-view=shares]').click();"
            "setTimeout(function(){ var b = document.querySelector('.share-card [data-act=open]'); if (b) b.click(); }, 300);")
        QTimer.singleShot(2200, shot3)

    def shot3():
        run_js_checks("browse")
        snap(out3)
        # 点 txt 文件的「预览」（带错误捕获）
        win.view.page().runJavaScript(
            "(function(){ try {"
            " var rows = document.querySelectorAll('.file-row[data-dir=\"0\"]');"
            " var row = rows[0];"
            " var btn = row ? row.querySelector('[data-act=preview]') : null;"
            " window.__diag = {rows: rows.length, has: !!btn, act: btn ? btn.dataset.act : ''};"
            " if (btn) btn.click();"
            " return 'ok'; } catch(e){ window.__diag = {exc: e.message}; return 'err'; }"
            "})()")
        QTimer.singleShot(1200, shot4)

    def shot4():
        run_js_checks("preview_txt")
        snap(out4)
        # 右键文件夹行 → 自定义菜单应出现（stopPropagation 修复：连续右键不误关）
        win.view.page().runJavaScript(
            "(function(){ try {"
            " var row = document.querySelector('.file-row.is-dir');"
            " window.__diag = {dirRow: !!row};"
            " if (row) { var ev = new MouseEvent('contextmenu', {bubbles: true, cancelable: true, clientX: 300, clientY: 300}); row.dispatchEvent(ev); }"
            " return 'ok'; } catch(e){ window.__diag = {exc: e.message}; return 'err'; }"
            "})()")
        QTimer.singleShot(400, shot4b)

    def shot4b():
        run_js_checks("ctxmenu")
        # 关闭右键菜单，恢复原流程：点 txt 文件（第二个文件行）的「预览」
        win.view.page().runJavaScript(
            "(function(){ try {"
            " document.body.click();"
            " var rows = document.querySelectorAll('.file-row[data-dir=\"0\"]');"
            " var row = rows[1];"
            " var btn = row ? row.querySelector('[data-act=preview]') : null;"
            " window.__diag = {rows: rows.length, has: !!btn, name: row ? (row.querySelector('.row-name')||{}).textContent : ''};"
            " if (btn) btn.click();"
            " return 'ok'; } catch(e){ window.__diag = {exc: e.message}; return 'err'; }"
            "})()")
        QTimer.singleShot(1200, shot5)

    def shot5():
        run_js_checks("preview_img")
        snap(out3)
        QTimer.singleShot(600, shot5a)

    def shot5a():
        # Markdown 预览：应出现「渲染视图/原格式」页签且渲染视图有排版内容
        win.view.page().runJavaScript(
            "(function(){ try {"
            " var rows = document.querySelectorAll('.file-row[data-dir=\"0\"]');"
            " var row = null;"
            " rows.forEach(function(r){ if((r.querySelector('.row-name')||{}).textContent.indexOf('.md')>0) row=r; });"
            " window.__diag = {rows: rows.length, mdRow: !!row, name: row ? (row.querySelector('.row-name')||{}).textContent : ''};"
            " if (row) row.querySelector('[data-act=preview]').click();"
            " return 'ok'; } catch(e){ window.__diag = {exc: e.message}; return 'err'; }"
            "})()")
        QTimer.singleShot(1200, shot5a2)

    def shot5a2():
        run_js_checks("preview_md")
        # 验证「原格式」页签可点击切换（监听此前绑定错误：点击无效）
        win.view.page().runJavaScript(
            "(function(){ var t = document.querySelector('.pv-tab[data-pv=raw]');"
            " if (!t) return JSON.stringify({tab:false});"
            " t.click();"
            " var box = document.getElementById('pvBox');"
            " return JSON.stringify({tab:true, cls: box ? box.className : '',"
            " txt: box ? (box.textContent || '').slice(0, 32) : ''}); })()",
            lambda res: checks.append("PREVIEW_RAW " + str(res)))
        snap(out4)
        # 关闭预览弹窗（清空内容），再切「下载中心」视图（切视图由 shot5b 完成）
        win.view.page().runJavaScript(
            "(function(){ var m = document.getElementById('previewModal'); if (m) { m.hidden = true;"
            " var b = document.getElementById('previewBody'); if (b) b.innerHTML = ''; } return 'ok'; })()")
        QTimer.singleShot(400, shot5b)

    def shot5b():
        # 下载中心：本机下载自动入历史（server 回调）+ 历史读写（隔离数据目录）
        try:
            # selftest 开头的本机下载（127.0.0.1）应已由 server 回调（队列->主线程轮询）写入历史，
            # 且因设置了 download_dir，文件应被接管复制到「保存区」、记录 dir 指向它
            hist0 = win._load_local_downloads()
            srv0 = [it for it in hist0 if it.get("name") == "示例文件.txt"]
            dl_ok = (tmp / "保存区" / "示例文件.txt").exists()
            srv_dir_ok = bool(srv0) and os.path.normcase(str(srv0[0].get("dir", ""))) == \
                os.path.normcase(str(tmp / "保存区"))
            print("DL_LOCAL_API srv_note=%d dl_ok=%s dir_ok=%s hist=%d"
                  % (len(srv0), dl_ok, srv_dir_ok, len(hist0)), flush=True)
            # exists 标注：文件存在 -> True；删除后 -> False（下载中心显示「找不到」）
            try:
                import json as _json
                it_lst = _json.loads(win.bridge.getLocalDownloads())
                it_x = [it for it in it_lst if it.get("name") == "示例文件.txt"]
                ex_ok1 = bool(it_x) and it_x[0].get("exists") is True
                saved_p = tmp / "保存区" / "示例文件.txt"
                if saved_p.exists():
                    saved_p.unlink()
                it_lst2 = _json.loads(win.bridge.getLocalDownloads())
                it_x2 = [it for it in it_lst2 if it.get("name") == "示例文件.txt"]
                ex_ok2 = bool(it_x2) and it_x2[0].get("exists") is False
                print("DL_LOCAL_API exists1=%s exists2=%s" % (ex_ok1, ex_ok2), flush=True)
            except Exception as e:
                print("DL_LOCAL_API exists_err %r" % (e,), flush=True)
            win._save_local_downloads([{"key": "K1", "name": "测试文件.zip", "size": 123,
                                        "dir": str(tmp), "path": str(tmp / "a.zip"), "ts": time.time()}])
            n1 = len(win._load_local_downloads())
            ok_rm = win._remove_local_download("K1")
            n2 = len(win._load_local_downloads())
            ok_clear = win._clear_local_downloads()
            n3 = len(win._load_local_downloads())
            print("DL_LOCAL_API save1=%d rm=%s(%d) clear=%s(%d)" % (n1, ok_rm, n2, ok_clear, n3), flush=True)
        except Exception as e:
            print("DL_LOCAL_API_ERR", repr(e), flush=True)
        win.view.page().runJavaScript(
            "document.querySelector('.tab[data-view=dlcenter]') && "
            "document.querySelector('.tab[data-view=dlcenter]').click()")
        QTimer.singleShot(700, shot5c)

    def shot5c():
        run_js_checks("dlcenter")
        snap(out4)
        QTimer.singleShot(600, shot6)

    def shot6():
        # 托盘双击唤出：先隐藏窗口，再模拟双击托盘图标，应恢复显示
        win.hide()
        win.tray.activated.emit(QSystemTrayIcon.DoubleClick)
        QTimer.singleShot(500, shot7)

    def shot7():
        checks.append("TRAY_DOUBLE_CLICK visible=%s tray=%s" % (win.isVisible(), win.tray.isVisible()))
        print("TRAY_CHECK %s" % checks[-1], flush=True)
        QTimer.singleShot(300, finish)

    def finish():
        (DATA_DIR / "_selftest_dom.json").write_text(
            json.dumps(checks, ensure_ascii=False, indent=2), encoding="utf-8")
        print("SELFTEST_DOM %s" % json.dumps(checks, ensure_ascii=False), flush=True)
        print("SELFTEST_OK %s %s %s" % (out, out2, out3), flush=True)
        app.quit()

    def loaded(ok):
        win.show()
        QTimer.singleShot(2200 if ok else 300, shot1)

    win.view.loadFinished.connect(loaded)
    win.view.load(QUrl("http://127.0.0.1:%d/" % port))
    app.exec()
    return 0


if __name__ == "__main__":
    sys.exit(run())
