# AGENTS.md — 局域网快传（LAN Share）项目协作规则

本文件为**项目级规则**，适用于本项目内所有代码改动与交付。与本机用户级 AGENTS.md 冲突时，以本文件为准；当前轮次的显式指令优先于两者。

## 铁律一：每次改动必须提交 Git

- 任何功能、修复、重构、配置或文档改动，**完成后必须创建对应 Git commit**，禁止"改完不提交"。
- **一次提交只做一件事（原子提交）**：一个功能 / 修复 / 重构 = 一个提交，不混合无关改动。
- 提交信息使用约定式格式（Conventional Commits）：
  `类型(范围): 中文描述`，类型取 `feat / fix / refactor / perf / docs / test / chore`。
  示例：`feat(admin): 下载记录支持一键清空`、`fix(copy): 复制链接改用桌面剪贴板`。
- 版本发布时打 tag（如 `git tag v2.3`），tag 与 CHANGELOG 版本号一一对应。

## 铁律二：改动必须配套测试，交付前全绿

- 每次代码改动后必须**编写或更新相关测试**：新增功能补对应断言，修复 bug 补回归断言。
- 交付前必须跑通本项目固定验证链，**全部通过才算完成**：
  1. `py -m py_compile server.py desktop.py smoke_test.py` —— Python 语法检查
  2. `node --check static\app.js` —— 前端语法检查
  3. `py -u smoke_test.py` —— 冒烟测试（当前 27 项；新增功能后同步增加项数）
  4. `py -u desktop.py --selftest` —— 桌面自检（强制隔离环境，禁止污染真实 config.json / downloads.json）
- 测试未全绿，不得交付、不得提交。

## 铁律三：每次提交必须更新 CHANGELOG.md，标题带哈希

- 每次代码提交时同步更新 `CHANGELOG.md`，条目须说明：**更新了什么、改动了什么、作用是什么、修复了什么、优化了什么**。
- **哈希时序**：提交哈希只有在提交完成后才能获得，故采用两步提交：
  1. 提交代码 + 测试 + CHANGELOG 条目（标题处先写 `[HASH]` 占位）；
  2. `git log -1 --format=%h` 取短哈希，回填该条标题，再提交
     `docs(changelog): 回填 vX.Y 哈希`。
- CHANGELOG 标题后的短哈希可直接用于回滚：
  - 查看某版本：`git checkout <短哈希>`
  - 撤销某次提交（保留历史）：`git revert <短哈希>`

## 铁律四：修复 bug 必须登记 BUGS.md（防复现）

- 每次修复 bug，**必须**在 `BUGS.md` 登记：现象 / 根因 / 解决 / 防复现。
- 动手改代码前，先扫一遍 `BUGS.md` 相关模块，避免同类问题复发或功能模块冲突。
- 新功能若引入第三方开源组件，登记到 BUGS.md 的「开源引入」小节（组件名 / 版本 / 许可 / 用途）。

## 仓库边界（.gitignore 已覆盖）

- `dist/ build/ *.spec`：打包产物（exe 约 206MB）不入库；构建命令记录于 README / CHANGELOG。
- `__pycache__/` 与自检诊断产物（`_selftest_*.png`、`_selftest_dom.json`、`_diag_*.py` 等）不入库。
- `config.json` / `downloads.json`：运行期用户数据（真实共享路径、下载记录，属隐私）不入库。

## 交付检查单（提交前逐项确认）

输入已读全 → 约束未越界 → 事实可追溯 → 验证链全绿 → 已 commit 并回填哈希 → CHANGELOG / README 已同步 → exe 等交付物实测通过。
