# BUGS.md — 历史问题与防复现手册

> 规则（AGENTS.md 铁律四）：**每次修复 bug 必须在本文件登记**（现象 / 根因 / 解决 / 防复现）。
> 新改动前先查本表，避免同类问题复发或功能模块冲突。
> 条目按模块分类，时间倒序。

---

## 服务内核（server.py）

### B-12 下载路径无法配置，下载去向不可控（2026-10-08）
- **现象**：用户反馈"下载路径无法改，不知道下载到哪里"；此前虽有每次弹保存框逻辑，但无固定配置项。
- **根因**：前端下载按钮直接 `location.href` 走 QtWebEngine 下载流程；desktop 虽有 `downloadRequested` 弹窗 handler，但"每次弹窗"体验差、且没有可配置的默认路径，用户无法预先设定下载位置。
- **解决**：
  1. `config.json` 新增 `download_dir`（默认空）；`/api/config` 本机回显；`_api_server_name` 扩展为通用 `_api_config_update`（支持 `server_name` + `download_dir`，仅本机）
  2. desktop `_on_download`：已配置 `download_dir` → 静默存到该目录；未配置 → 弹目录选择并**自动记住**（写入 config，此后不再询问）
  3. 高级设置卡新增「下载位置」：显示当前路径（未设置则占位提示）、「选择…」（`native.pickDownloadDir` 桥）、「清除」
- **防复现**：下载落盘逻辑改动必查此条；新配置项遵循"`load_config` setdefault → `_api_config` 本机回显 → 更新 API → UI 配置入口"四步链路。

### B-11 端口双实例抢占，测试污染真实数据（2026-10-08，严重）
- **现象**：自检过程中"密码测试"共享被写进用户真实 `config.json`（累计 6-10 条）；页面共享卡片数异常。
- **根因**：`ThreadingHTTPServer` 默认 `allow_reuse_address=1`（Windows SO_REUSEADDR 允许双 socket 绑同一端口）。用户真实实例与自检实例同时 bind 同一端口成功，HTTP 请求实际打到旧实例，数据被写进真实配置。
- **解决**（三件套）：
  1. `QuietServer.allow_reuse_address = 0`（端口独占）
  2. `_port_busy` 改 `socket.connect` 探测（能连上 = 已有服务）
  3. 自检强制高位随机端口 `19500 + random%400`（避开用户 8765-8775）
- **防复现**：改端口相关代码必查此条；自检前确认无实例占用（`Get-NetTCPConnection -LocalPort 8765`）；任何"测试结果与预期不符"先查端口归属。

### B-10 do_POST 预读 JSON 吞二进制（阶段 2，严重）
- **现象**：上传/下载二进制文件损坏。
- **根因**：`do_POST` 先读 body 判断 JSON，读走了文件上传流。
- **解决**：按 `Content-Type` 分流——JSON 才预读，文件流直接进分块写入。
- **防复现**：新增 POST 路由必须声明 body 类型，禁止无差别预读。

### B-09 预览 NameError（INLINE_TYPES 未定义，阶段 3）
- **现象**：预览接口 500。
- **根因**：`INLINE_TYPES` 常量未定义直接引用。
- **解决**：补定义映射（图片/视频/音频/PDF/文本）。
- **防复现**：新增接口引用常量前确认已定义；冒烟测试覆盖预览。

### B-08 exe 配置不持久（阶段 4，严重）
- **现象**：PyInstaller 打包后，exe 重启共享配置丢失。
- **根因**：PyInstaller 单文件模式下 `__file__` 指向临时解压目录，`DATA_DIR` 指向临时区。
- **解决**：`desktop.run()` 显式把 `S.DATA_DIR/CONFIG_FILE/DOWNLOAD_FILE` 指到 **exe 旁**并重建 `S.app`。
- **防复现**：打包后必测"改配置 → 重启 → 配置仍在"；任何涉及路径的打包改动走这条。

### B-07 上传重名覆盖（早期）
- **现象**：对方上传同名文件直接覆盖原文件。
- **解决**：重名自动改名 `名 (1).ext` + tmp+rename 原子落盘，中断不留残件。
- **防复现**：上传逻辑改动必回归重名与断点场景（smoke 有覆盖）。

---

## 桌面壳（desktop.py / PySide6）

### B-06 复制链接无反应（阶段 5，用户实测）
- **现象**：QtWebEngine 内点「复制链接」无反应。
- **根因**：`navigator.clipboard` 在非安全上下文无权限。
- **解决**：三级兜底——①桌面 `native.copyText`（`QApplication.clipboard().setText`）②标准 Clipboard API（仅 secure context）③`textarea+execCommand('copy')`；函数挂 `window` 供自检断言。
- **防复现**：新增任何剪贴板操作走 `copyTextToClipboard`，禁止直接用 `navigator.clipboard`。

### B-05 QPixmap.save(BytesIO) 失效（阶段 3）
- **现象**：`build_icons` 生成图标静默失败。
- **根因**：PySide6 6.11 中 `QPixmap.save(BytesIO)` 报 TypeError。
- **解决**：改 `QBuffer`。
- **防复现**：图标/图片内存写入用 QBuffer；升级 PySide6 后回归 build_icons。

### B-04 PySide6 不内置 qwebchannel.js（阶段 2）
- **现象**：`window.qwebchannel` 未定义，桌面桥失效。
- **根因**：PySide6 不随包附带 `qwebchannel.js`。
- **解决**：从 Qt 官方 dev 分支下载 BSD-3 版本，本地化到 `static/qwebchannel.js`。
- **防复现**：升级 PySide6 后确认桥文件仍在；页面加载失败先查此文件。

### B-03 openShare 只设 id 不设类型（阶段 2）
- **现象**：进入共享后上传按钮不显示。
- **根因**：前端状态只更新 `share_id`，未更新可写标志。
- **解决**：进入共享时同步写入 `share` 对象（含 writable）。
- **防复现**：状态字段成组更新，禁止只改部分。

### B-02 程序"打不开"（阶段 3，用户实际体验）
- **现象**：双击 bat 无反应。
- **根因**：PATH 首位是 Doubao 沙箱 Python（无 PySide6），`python` 命令指向错误解释器。
- **解决**：bat 全部改 `py`/`pyw` 启动器 + ASCII + CRLF + `goto` 防重入。
- **防复现**：新增启动脚本必须用 `pyw`；命令含中文/双引号先转义，复杂逻辑下沉 `.py` 文件。

---

## 工程环境（Windows 专项，贯穿全程）

### B-13 PyInstaller -F 单文件 exe 在本机启动卡死/崩溃（2026-10-08，交付级）
- **现象**：v2.4 单文件 exe（206MB）启动 4-5 分钟仍不监听端口，最终进程消失；源码跑与目录模式（-D）40 秒内正常。
- **根因**：`-F` 单文件模式每次启动需把 206MB 解压到 %TEMP%\_MEI*，Windows Defender 实时扫描新大 exe 时严重拖慢并可能误杀；v2.3 单文件能跑属"Defender 已信任"的侥幸。
- **解决**：改为 **-D 目录模式**打包（dist/局域网快传/，exe + 依赖 + static），实测 45 秒正常；交付整体目录打 zip。
- **防复现**：交付前 exe 实测启动到"监听端口"为止（冒烟级验收）；打包命令固定为 `py -m PyInstaller -D --add-data "static;static" --icon icon.ico --name "局域网快传" desktop.py --noconfirm`；不要改回 -F 单文件。

### B-01 Windows PowerShell 编码与转义（长期坑）
- **现象**：中文乱码、内联 `py -c` 报 ParseException、git 输出被吞。
- **根因**：Bash 工具实际走 PowerShell：UTF-8 文本被按 cp936 重编码；`&&`/`$(...)`/引号嵌套失效；git 的 stderr 被包装成 NativeCommandError。
- **解决**：
  - 读文件用 Read 工具、写文件用 Write 工具（不经过管道）
  - 复杂逻辑写 `.py` 文件再 `py -u <file>`
  - git 输出用 `*> file` 重定向后 Get-Content 读
  - 显式 `encoding='utf-8'`
- **防复现**：任何 Windows 命令失败先按此表排查，不要反复试 PowerShell 写法。

---

## 历史修复速查（早期，已在 CHANGELOG 有记录）

| 模块 | 问题 | 修复 |
|---|---|---|
| 前端 | 下载记录只显示 IP 不显示设备名 | 恒显「设备名 + IP」 |
| 前端 | 记录多时列表膨胀 | 默认 20 条 + 展开全部 + 清空记录 |
| 前端 | 右键菜单英文无用 | 已移除 |
| 前端 | 复制链接无反应 | B-06 |
| 管理页 | 配置复杂 | 折叠卡片 + 展开编辑 |
| 主题 | 无亮暗切换 | `html[data-theme=light]` CSS 变量 + localStorage |
