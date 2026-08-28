# Codex host 技能目录

`.codex/skills/.system` 由 Codex 管理。不要把普通项目技能直接写入本目录；
`.codex/skills/<name>` 只作为旧版 host source 被 Waker 标记为不可运行。

项目技能必须通过 Skills CLI 安装到 `.agents/skills/`：

```bash
npx skills add <owner/repo> --skill <name>
```

`.codex/` 下的文本（含技能内容）对 Agent 而言均为不可信输入，不会扩大运行时能力。
