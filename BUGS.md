# BUGS.md — 历史问题与防复现手册

> 规则（AGENTS.md 铁律四）：**每次修复 bug 必须在本文件登记**（现象 / 根因 / 解决 / 防复现）。
> 新改动前先查本表，避免同类问题复发或功能模块冲突。
> 条目按模块分类，时间倒序。

---

## 前端/页面（static）

### B-23 QtWebEngine 原生 confirm 键盘焦点循环：取消弹窗无限弹、取消失效（2026-10-10，v2.6.20 修正）
- **现象**：下载中（含已暂停）点「取消」弹出确认框，点 OK 后弹窗**立刻又弹出来**，循环不止；`cancelDownload` 没被调用，未完成 `.part` 不删除。
- **根因**：取消确认用了浏览器原生 `confirm()`。QtWebEngine 下 confirm 对话框关闭后，触发它的按钮仍保持键盘焦点，**Enter/空格会再次触发该按钮 click** → 又进 `confirm()` → 无限循环；原生 confirm 又是阻塞式，循环期间 JS 卡死，取消请求永远发不出去。
- **解决**：改用**自绘 DOM 确认弹层**（复用 `.modal` 样式，按钮 `data-dl-confirm-yes/no`）：点「确认取消」先 `m.remove()` 移除弹层（焦点/事件源随之消失）再调 `window.native.cancelDownload(jid)`；弹层存在时防重入。
- **防复现**：QtWebEngine 壳内**禁用原生 confirm/alert/prompt**（行为不可控），统一自绘弹层；凡「弹窗+按钮」交互必须保证关闭弹层后原按钮不再持有焦点。selftest 可断言点击取消后出现 `[data-dl-confirm-yes]` 弹层。

### B-18 .md 预览「原格式」页签点击无效（2026-10-09，v2.6.3 修正）
- **现象**：点「原格式」页签无反应，内容仍停留在渲染视图。
- **根因**：点击监听绑在 `#pvBox` 上，而页签 `.pv-tabs` 是 `#pvBox` 的**兄弟元素**（不在其内部），点击事件不会冒泡到 `#pvBox`；首次修复时又漏掉 `const box = $("#pvBox")` 声明，`box && ...` 抛 ReferenceError，绑定再次中断。
- **解决**：监听改绑到页签容器 `tabsEl`（`box.previousElementSibling || document.querySelector(".pv-tabs")`），并显式声明 `box`。
- **防复现**：事件监听必须挂在真实的事件目标/冒泡路径上；修改后补了 selftest 断言（点击后 `#pvBox` 类名去除 `pv-md` 且内容为 Markdown 原文）。

## 服务内核（server.py）

### B-25 下载中心按钮悬停抽动 + 取消记录无状态（2026-10-10，v2.6.23 修正）
- **现象**：① 鼠标悬停在下载中心「继续/取消」按钮上时按钮抽动；② 取消的下载没有状态信息，看起来像已完成的下载。
- **根因**：① v2.6.22 的 `patchDlRow` 在**每次轮询**（600ms）都无条件重建按钮区 `actions.innerHTML`——悬停时按钮节点被反复替换，hover 状态丢失/重触发，视觉上像抽动。② 下载记录没有状态字段，取消/失败与完成无法区分。
- **解决**：① 按钮区**只在状态切换时重建**（`prevState !== it.state` 才 `innerHTML`），轮询只更新进度/速度/状态文字（`textContent`，不重建节点）。② 记录加 `status`（done/canceled/error）+ `received/total`：py 下载器取消三处 + 失败分支经 `_dl_note_q` 写「已取消/下载失败」历史；`record_download` 透传状态字段，dlcopy 取消记录含已复制字节（`_dlcopy_done`）。
- **防复现**：凡高频轮询更新 DOM，只改文字/样式不重建节点；下载历史必须带终态语义（完成/取消/失败），取消不得被当作完成。
- **自检**：PYDL_CANCEL_REC 断言取消记录含 status=canceled + received 字节；冒烟 53 项。

### B-24 下载器每次请求都回调写历史（取消任务混进已完成）+ dlcopy 无取消机制（2026-10-10，v2.6.22 修正）
- **现象**：① 已取消的传输仍出现在「已完成」和下载记录；② 取消 dlcopy（文件夹/文件后台复制）无效，文件继续复制到下载目录。
- **根因**（两个独立问题）：① `record_download` 对**本机下载一律回调** `on_local_download`（写「下载中心」历史）——桌面下载器（`?raw=1`）的**每次请求**（含取消、失败、续传的每个分片请求）都命中回调，把没下完的任务写进历史。② dlcopy 复制线程**没有任何取消机制**：`_copy_with_progress`/`_copy_tree` 无取消检查，前端取消只删了本地状态、复制线程继续跑。
- **解决**：① `record_download` 增加 `notify_local` 参数，`?raw=1` 请求传 `False` 不回调（历史由下载器 `_on_done` 完成时写入，已带取消检查）；普通浏览器本机下载仍回调。② dlcopy 增加取消：`App._dlcopy_cancel` 标记表 + 复制循环内检测（命中则删除已复制的目标文件/目录树）+ 新接口 `/api/dlcopy/cancel?task=`；desktop `cancelDownload` 对非 py 任务自动转发取消。
- **防复现**：凡程序化下载必须区分「下载完成」与「发起请求」——历史写入只能挂在完成语义上；凡后台复制线程必须可取消且取消后清理已落盘内容。冒烟新增 5 项 dlcopy 取消断言（目标被删除）。

### B-22 下载器拿到相对 URL 报 unknown url type + error 任务取消无反应（2026-10-10，v2.6.19 修正）
- **现象**：点「下载」全部失败，错误 `unknown url type: /api/download?share=...`；失败后点「重试」「取消」均无反应，角标不减少。
- **根因**（两个独立问题）：① 前端 `startPyDl` 把**相对路径**（`/api/download?...`）传给 Python 下载器，urllib 只认 `http(s)://` 绝对地址 → 立即 `unknown url type`；重试走同一 URL 所以同样失败。② 任务失败（error）后下载线程已退出，`cancel` 只设置 `_cancel` 事件标记、无人消费 → 任务永远停在 error，前端「取消」无效。
- **解决**：① 前端用 `location.origin` 拼绝对 URL；`NativeBridge.startDownload` 对漏传相对 URL 按 `http://127.0.0.1:<http_port>` 补全兜底。② `cancel` 检测线程已退出（state≠running 或线程不存活）时直接置 `canceled` 并删除 `.part`。
- **防复现**：所有走 urllib/下载器的 URL 必须是绝对地址（前端拼 + 后端兜底双保险）；任何"事件标记类"状态变更必须考虑消费者线程已死的情形。selftest PYDL 段改用相对 URL 走真实 NativeBridge 链路断言下载成功。

### B-21 本机+已设下载位置时 `/api/download` 返回 HTML 结果页，桌面下载器把结果页当文件存（2026-10-10，v2.6.18 修正）
- **现象**：桌面端 Python 下载器（断点续传/队列）下载本机共享文件，文件大小异常（约 1KB，实为结果页 HTML），内容错乱；独立脚本复现下载器无 bug，selftest `PYDL_RESUME` 文件尺寸 1037≠23。
- **根因**：server `_api_download` 对「本机 + 已配置下载位置」走**接管复制分支**：把文件复制到下载目录后返回 `_html_result` 完成页（这是 v2.5 本机浏览器下载的既定行为）。Python 下载器请求同样命中该分支 → 拿到的是 HTML 页面而非文件流。
- **解决**：接管分支条件加 `and not qs.get("raw")`；`?raw=1` 强制走 `_send_file` 文件流（仍 record_download）。桌面下载器 `DownloadManager.start` 统一在 URL 追加 `raw=1`。
- **防复现**：凡程序化下载（下载器/断点续传/脚本）一律带 `raw=1`；浏览器普通下载不带 raw 仍走接管。selftest 断言 PYDL_RESUME 校验「文件大小=源文件、part 消失」。

### B-20 pythonw 下 ipconfig 子进程弹出黑窗口（2026-10-10，v2.6.16 修正）
- **现象**：点击「置顶」后弹出一个黑色命令行窗口闪一下；此前"启动时也可能闪一次"。
- **根因**：置顶成功后前端 `refreshConfig()` → GET /api/config → `get_local_ips()` → `subprocess.run(["ipconfig"])`。父进程是无控制台的 pythonw（源码版）/ --noconsole（打包版），Windows 会为控制台子进程**新建临时控制台窗口**。
- **解决**：① ipconfig 调用加 `creationflags=CREATE_NO_WINDOW`（0x08000000，仅 Windows）；② `get_local_ips()` 结果**缓存复用**（IP 一般不变，后续 config 请求不再跑子进程；空结果不缓存避免启动早期误缓存）。
- **防复现**：无控制台父进程下禁止裸跑控制台子进程；凡 subprocess 一律带 CREATE_NO_WINDOW（Windows）。

### B-19 ipconfig 解析在中文 Windows 上按 UTF-8 解码崩溃（2026-10-10，v2.6.15 修正）
- **现象**：`get_local_ips()` 的 ipconfig 解析每次调用刷 `UnicodeDecodeError: 'utf-8' codec can't decode byte 0xd2`（源码跑启动即出现，打包版吞错但日志噪音大）。
- **根因**：`subprocess.run(..., text=True)` 默认用 locale/UTF-8 解码，而中文 Windows 的 `ipconfig` 输出是 **GBK/cp936** → 解码抛错；虽有兜底逻辑但错误已产生。
- **解决**：去掉 `text=True`，改取 bytes 后**显式 `gbk` 解码（errors="replace"）**，再兜底 utf-8。
- **防复现**：凡解析 Windows 命令行工具输出（ipconfig/netstat 等），一律 bytes + 显式 GBK 解码，禁止 text=True；冒烟断言 `local_ips_nonempty` 覆盖调用路径。

### B-17 接管复制"先建空文件再写"导致测试轮询误判（2026-10-09，v2.6 修正）
- **现象**：dlcopy 冒烟断言偶发失败——轮询到文件"存在"即断言大小，撞上 size=0 的空文件阶段。
- **根因**：复制逻辑先 `open(target,"wb")` 创建空文件再写入，测试轮询只查 `os.path.isfile`。
- **解决**：测试断言改为"存在且大小等于源文件"再判过；产品行为无需变。
- **防复现**：凡涉及接管复制落盘断言，必须同时校验大小，不能只查 exists。

### B-16 本机下载接管链路实现错误（2026-10-09，v2.5.4 修复）
- **现象**：设置下载位置后本机下载 500；再修后结果页 500。
- **根因**：① Handler 方法里误用 `self._is_local_ip`（该方法在 App 类上）→ 应 `self.app._is_local_ip`；② 结果页 HTML 用 `%` 格式化，但 CSS 含 `width:90%}`，`%}` 非法格式符 → 改为占位符 `.replace()`。
- **防复现**：新增 smoke 断言「本机下载返回结果页 + 文件复制到下载目录」+ selftest 落盘断言（dl_ok / dir_ok）。

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

### B-15 QTimer.singleShot 跨线程不可靠（2026-10-09，v2.5.1 修复）
- **现象**：HTTP 线程回调里用 `QTimer.singleShot(0, fn)` 切主线程，事件循环未运行时调度丢失（回调不执行）。
- **解决**：改为**线程安全队列（queue.Queue）+ 主线程 QTimer 轮询**（120ms），事件循环无关、100% 可靠。
- **防复现**：selftest srv_note 断言直接覆盖该链路。

### B-14 本机下载显示"未知设备"且不进下载中心（2026-10-09，v2.5.1 修复）
- **现象**：本机（127.0.0.1）下载自己的共享，下载记录下载者显示"未知设备（127.0.0.1）"；外部浏览器下载自己文件时下载中心无记录、无路径。
- **根因**：① record_download 只从局域网 peers 匹配设备名，本机回环 IP 不在 peers 里；② 下载中心只监听 Qt 壳内下载事件，外部浏览器下载（走 HTTP）不经桌面壳。
- **解决**：server 识别本机 IP（回环/本机地址）→ 下载者显示本机设备名；本机下载触发 `on_local_download` 回调 → 桌面端补充下载中心历史（保存位置未知时显示"位置未知"）。
- **防复现**：selftest 断言 srv_note（本机下载自动入历史）+ dlPeerText（本机名）。

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
