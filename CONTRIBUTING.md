# 参与贡献

欢迎提 Issue 和 PR。

## PR 怎么被合并

本仓库由维护者从统一的开发仓库同步而来，但 PR 照常提到本仓库的 `main` 分支即可：

- 合并时，维护者在开发仓库里合入你的提交，再同步回本仓库。PR 会显示为 **Merged**，你的提交和署名原样保留。
- 合并前可能请你修改或 rebase；维护者也可能直接在你的 PR 分支上补提交，请保持勾选 “Allow edits by maintainers”。
- `main` 只由同步流程写入，请不要期待直接推送或在网页上编辑 `main` 被保留。

## 提交前

```bash
npm install
npm run typecheck
npm test
```

- 有行为变更请补一条测试，测试与实现放在同目录的 `src/*.test.ts`。
- 提交信息用 Conventional Commits（`feat: …`、`fix: …`、`docs: …`）。

## 跨插件约定

左栏、设计语言、设置协议等跨插件约定的修改，请先到 [pi-shizuku](https://github.com/AoShizuku/pi-shizuku) 提 Issue 讨论。
