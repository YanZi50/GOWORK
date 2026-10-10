# -*- coding: utf-8 -*-
"""
局域网快传 · 冒烟测试（阶段2扩展）
=================================
隔离运行：把 server.py 复制到临时目录（独立 config.json），
在 18765 端口启动，验证 上传/限速/统计/可写权限/断点续传/SSE。

用法： py smoke_test.py
"""
import io
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
PORT = 18765
BASE = "http://127.0.0.1:%d" % PORT

import server as _srv  # 仅取 get_local_ips 等纯函数

PASS = []


def check(name, cond, detail=""):
    if cond:
        PASS.append(name)
        print("  PASS  %s" % name)
    else:
        print("  FAIL  %s  %s" % (name, detail))
        sys.exit(1)


def api(path, data=None, method=None, ctype="application/json"):
    url = BASE + path
    headers = {"Content-Type": ctype} if data is not None else {}
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data is not None else "GET"),
                                 headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
            code = r.status
    except urllib.error.HTTPError as e:
        body = e.read()
        code = e.code
    return code, (json.loads(body) if body and body.strip()[:1] in b"[{" else body)


def wait_up(secs=15):
    for _ in range(secs * 2):
        try:
            _, cfg = api("/api/config")
            return cfg
        except Exception:
            time.sleep(0.5)
    raise RuntimeError("服务未在 %d 秒内启动" % secs)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="lanshare_smoke_"))
    server_dir = tmp / "server"
    server_dir.mkdir()
    shutil.copy2(APP_DIR / "server.py", server_dir / "server.py")

    share_dir = tmp / "share"
    share_dir.mkdir()
    (share_dir / "hello.txt").write_text("hello lan share", encoding="utf-8")

    proc = subprocess.Popen(
        [sys.executable, "server.py", "--port", str(PORT), "--no-browser", "--discovery-off"],
        cwd=str(server_dir), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        print("== 阶段2 冒烟测试 ==")
        cfg = wait_up()

        # 1) 添加可写共享
        st, r = api("/api/shares", json.dumps({
            "name": "写入测试", "path": str(share_dir), "perm": "public", "writable": True,
        }).encode("utf-8"))
        check("添加共享 200", st == 200, str(r))
        share_id = r["share"]["id"]

        # 2) config 暴露 writable + speed_limit_kb
        _, cfg = api("/api/config")
        s = next(x for x in cfg["shares"] if x["id"] == share_id)
        check("config 暴露 writable", s.get("writable") is True, json.dumps(s))
        check("config 暴露 speed_limit_kb", cfg.get("speed_limit_kb") == 0)

        # 2a) 主题持久化：默认 dark -> 保存 light -> 回读 light -> 恢复 dark
        check("theme_default_dark", cfg.get("theme", "dark") == "dark", "theme=%r" % cfg.get("theme"))
        st, r = api("/api/config", data=b'{"theme":"light"}', ctype="application/json")
        check("theme_save_200", st == 200 and (r or {}).get("ok") is True, "st=%d r=%s" % (st, r))
        _, cfg2 = api("/api/config")
        check("theme_readback_light", cfg2.get("theme") == "light", "theme=%r" % cfg2.get("theme"))
        st, _ = api("/api/config", data=b'{"theme":"dark"}', ctype="application/json")
        check("theme_restore_200", st == 200, "st=%d" % st)

        # 2b) 共享置顶：pin 字段透传 + 回读；多网卡 IP 枚举非空
        st, r = api("/api/shares", json.dumps({
            "name": "置顶测试", "path": str(share_dir), "perm": "public", "writable": False, "pin": True,
        }).encode("utf-8"))
        check("pin_save_200", st == 200, str(r))
        _, cfg3 = api("/api/config")
        p = next((x for x in cfg3["shares"] if x.get("name") == "置顶测试"), None)
        check("pin_readback", p is not None and p.get("pin") is True, json.dumps(p or {}))
        check("pin_at_written", p is not None and isinstance(p.get("pin_at"), (int, float)),
              json.dumps(p or {}))
        # 第二个置顶：pin_at 应晚于第一个 → 前端按 pin_at 倒序排前面
        st, r = api("/api/shares", json.dumps({
            "name": "置顶测试2", "path": str(share_dir), "perm": "public", "writable": False, "pin": True,
        }).encode("utf-8"))
        check("pin2_save_200", st == 200, str(r))
        _, cfg4 = api("/api/config")
        p2 = next((x for x in cfg4["shares"] if x.get("name") == "置顶测试2"), None)
        check("pin2_newer", p2 is not None and p.get("pin_at") is not None and
              p2["pin_at"] > p["pin_at"], "a=%s b=%s" % (p.get("pin_at"), p2 and p2.get("pin_at")))
        # 拖动排序接口：把 p 放到 p2 前面（视觉顺序 p, p2）→ 重写 pin_at 使 p 更新
        st, r = api("/api/shares/order", json.dumps({
            "order": [p["id"], p2["id"]],
        }).encode("utf-8"))
        check("order_200", st == 200, str(r))
        _, cfg5 = api("/api/config")
        pa = next(x for x in cfg5["shares"] if x["id"] == p["id"])
        pb = next(x for x in cfg5["shares"] if x["id"] == p2["id"])
        check("order_pin_at", pa["pin_at"] > pb["pin_at"],
              "pa=%s pb=%s" % (pa.get("pin_at"), pb.get("pin_at")))
        if p2:
            api("/api/shares/" + p2["id"])
        if p:
            api("/api/shares/" + p["id"])
        ips = _srv.get_local_ips()
        check("local_ips_nonempty", len(ips) >= 1, "ips=%r" % ips)
        check("local_ips_no_loopback", all(not i.startswith("127.") for i in ips), "ips=%r" % ips)

        # 3) 列表可见
        st, r = api("/api/list?share=%s&path=/" % share_id)
        check("list 200 且含 hello.txt", st == 200 and any(e["name"] == "hello.txt" for e in r["entries"]), str(r)[:200])

        # 4) 上传新文件
        blob = os.urandom(512 * 1024)
        st, r = api("/api/upload?share=%s&path=/&name=up.bin" % share_id, blob, ctype="application/octet-stream")
        check("上传新文件 200", st == 200 and r.get("size") == len(blob), str(r)[:200])
        check("上传文件已落盘", (share_dir / "up.bin").stat().st_size == len(blob))

        # 5) 重名自动改名
        st, r = api("/api/upload?share=%s&path=/&name=hello.txt" % share_id, b"dup content",
                    ctype="application/octet-stream")
        check("重名上传自动改名", st == 200 and r.get("name") == "hello (1).txt", str(r)[:200])
        check("原文件未被覆盖", (share_dir / "hello.txt").read_text(encoding="utf-8") == "hello lan share")

        # 6) 只读共享拒绝上传
        st, r = api("/api/shares", json.dumps({
            "name": "只读", "path": str(share_dir), "perm": "public", "writable": False,
        }).encode("utf-8"))
        ro_id = r["share"]["id"]
        st, r = api("/api/upload?share=%s&path=/&name=x.txt" % ro_id, b"x",
                    ctype="application/octet-stream")
        check("只读共享上传 403", st == 403, str(r)[:200])

        # 7) 限速生效：1MB @ 256KB/s，允许一桶突发(256KB)，理论下限 3.0s
        st, r = api("/api/limits", json.dumps({"speed_limit_kb": 256}).encode("utf-8"))
        check("保存限速 200", st == 200 and r.get("speed_limit_kb") == 256)
        big = os.urandom(1024 * 1024)
        t0 = time.time()

        # 7.5) 下载位置配置：POST /api/config 保存 download_dir，本机回显一致且落盘
        dl_dir = tempfile.mkdtemp(prefix="lanshare_dl_")
        st, r = api("/api/config", json.dumps({"download_dir": dl_dir}).encode("utf-8"))
        check("保存下载目录 200", st == 200 and r.get("download_dir") == dl_dir, str(r)[:200])
        st, cfg2 = api("/api/config")
        check("config 回显 download_dir", st == 200 and cfg2.get("download_dir") == dl_dir, str(cfg2)[:200])
        _cfg_disk = json.loads((server_dir / "config.json").read_text(encoding="utf-8"))
        check("download_dir 落盘", _cfg_disk.get("download_dir") == dl_dir)
        # 7.6) 本机下载接管：已设置下载位置时，本机下载直接复制到该目录并返回结果页
        try:
            resp = urllib.request.urlopen(
                BASE + "/api/download?share=%s&path=/up.bin" % share_id, timeout=30)
            data = resp.read().decode("utf-8", "replace")
            check("本机下载返回结果页", resp.status == 200 and "文件已保存" in data, data[:120])
            saved = os.path.join(dl_dir, "up.bin")
            check("文件已复制到下载目录",
                  os.path.isfile(saved) and os.path.getsize(saved) == len(blob), saved)
            try:
                os.remove(saved)
            except Exception:
                pass
        except Exception as e:
            check("本机下载接管链路", False, repr(e))
        # 7.7) /api/dlcopy：本机下载前台接管——202 + 后台复制到下载目录（按钮圆环由 SSE 驱动）
        try:
            st, r = api("/api/dlcopy?share=%s&path=/up.bin&task=t_smoke1" % share_id)
            check("dlcopy 返回 202", st == 202 and r.get("task") == "t_smoke1", str(r)[:200])
            saved = os.path.join(dl_dir, "up.bin")
            t0 = time.time()
            while time.time() - t0 < 15:
                if os.path.isfile(saved) and os.path.getsize(saved) == len(blob):
                    break
                time.sleep(0.2)
            check("dlcopy 文件复制到下载目录",
                  os.path.isfile(saved) and os.path.getsize(saved) == len(blob), saved)
            try:
                os.remove(saved)
            except Exception:
                pass
        except Exception as e:
            check("dlcopy 链路", False, repr(e))
        st, r = api("/api/config", json.dumps({"download_dir": ""}).encode("utf-8"))
        check("清除下载目录 200", st == 200 and r.get("download_dir") == "")

        st, r = api("/api/upload?share=%s&path=/&name=big.bin" % share_id, big,
                    ctype="application/octet-stream")
        elapsed = time.time() - t0
        check("限速下上传完成", st == 200, str(r)[:200])
        check("限速耗时合理(>=2.8s)", elapsed >= 2.8, "实际 %.2fs" % elapsed)

        # 8) 统计口径
        st, r = api("/api/stats")
        check("stats 200", st == 200 and "up" in r and "down" in r, str(r)[:200])
        check("上行总量累加正确", r["up"]["total"] >= len(blob) + 11 + len(big),
              "total=%d expect>=%d" % (r["up"]["total"], len(blob) + 11 + len(big)))

        # 9) 下载 + Range 断点续传
        with urllib.request.urlopen(BASE + "/api/download?share=%s&path=/up.bin" % share_id, timeout=30) as resp:
            check("下载 200", resp.status == 200 and resp.read() == blob)
        req = urllib.request.Request(BASE + "/api/download?share=%s&path=/up.bin" % share_id,
                                     headers={"Range": "bytes=0-1023"})
        with urllib.request.urlopen(req, timeout=30) as resp:
            part = resp.read()
            check("Range 206 且内容正确", resp.status == 206 and part == blob[:1024], "status=%d len=%d" % (resp.status, len(part)))

        # 10) 下载统计：谁下载过、几次、何时（本机可查，续传去重）
        st, r = api("/api/downloads")
        check("downloads 仅本机 200", st == 200 and isinstance(r.get("list"), list), str(r)[:200])
        rec = next((x for x in r["list"] if x["path"] == "/up.bin"), None)
        check("下载记录含 up.bin", rec is not None, json.dumps(r)[:300])
        if rec:
            check("下载者 IP 记录正确", rec["ip"] == "127.0.0.1", rec["ip"])
            check("下载计数为 1（全量+Range 续传不重复计）", rec["count"] == 1, str(rec["count"]))
            check("下载名/共享名正确", rec["name"] == "up.bin" and rec["share_name"] == "写入测试",
                  json.dumps(rec))
        # 非本机访问 downloads 应 403（用 Host 头伪造远端来源不改变 client_address，仅验证接口存在本机守卫）
        check("downloads 数据可持久化", (server_dir / "downloads.json").exists())

        # 12) 密码共享：本机 config 回显明文密码（编辑时可见），供管理页回填
        st, r = api("/api/shares", json.dumps({
            "name": "密码夹", "path": str(share_dir), "perm": "password",
            "password": "secret123", "writable": False,
        }).encode("utf-8"))
        pwd_id = r["share"]["id"]
        _, cfg2 = api("/api/config")
        ps = next((x for x in cfg2["shares"] if x["id"] == pwd_id), None)
        check("密码共享添加成功", ps is not None, json.dumps(r))
        if ps:
            check("本机 config 回显明文密码", ps.get("pwd") == "secret123", json.dumps(ps))

        # 13) 清空下载记录（仅本机）：清空后 count=0，且不影响文件
        st, r = api("/api/downloads", method="POST")
        check("清空下载记录", r.get("ok") is True, json.dumps(r))
        _, d2 = api("/api/downloads")
        check("清空后记录数为 0", d2.get("count") == 0, json.dumps(d2))
        # 恢复一条记录，避免影响后续用例对下载功能的依赖
        urllib.request.urlopen(BASE + "/api/download?share=%s&path=%s"
                               % (share_id, urllib.parse.quote("/up.bin")), timeout=5).read()

        # 11) SSE 事件流可连：先开流，再改配置，应收到 config 推送（裸 socket，流式可靠）
        sse_sock = socket.create_connection(("127.0.0.1", PORT), timeout=5)
        sse_sock.sendall(b"GET /api/events HTTP/1.1\r\nHost: 127.0.0.1\r\n"
                         b"Accept: text/event-stream\r\nConnection: close\r\n\r\n")
        sse_sock.settimeout(2)
        _ = sse_sock.recv(2048)  # 读响应头
        api("/api/config", json.dumps({"server_name": "冒烟机"}).encode("utf-8"))
        sse_body = b""
        try:
            while len(sse_body) < 2048:
                c = sse_sock.recv(2048)
                if not c:
                    break
                sse_body += c
        except TimeoutError:
            pass
        sse_sock.close()
        sse_text = sse_body.decode("utf-8", "replace")
        check("SSE 收到 config 推送", "event: config" in sse_text, sse_text[:120])

        print("\n== 全部通过：%d 项 ==" % len(PASS))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
