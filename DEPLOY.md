# CDown 发布指引（GitHub + CNB）

仓库已就绪：分支 `main`，标签 `v0.2.2`，提交署名 `diciky <diciky.zl@gmail.com>`。

## 一、发布到 GitHub

1. 浏览器打开 https://github.com/new ，仓库名填 `CDown`，选 Public（不要勾选自动生成 README），创建
2. 项目目录下执行：

```bash
cd C:/Users/Administrator/WorkBuddy/2026-09-26-18-52-30/cdown
git remote add origin https://github.com/<你的GitHub用户名>/CDown.git
git push -u origin main
git push origin v0.2.2
```

> 首次推送会弹出 GitHub 登录窗口（Git Credential Manager），按提示授权即可。
> 推送后到仓库 Releases → Draft a new release → 选择标签 `v0.2.2`，把 `dist-v022/` 里的两个 exe 拖上去发布。

## 二、发布到 CNB（cnb.cool）

1. 浏览器打开 https://cnb.cool ，新建仓库（如 `<你的用户名>/CDown`）
2. 执行：

```bash
git remote add cnb https://cnb.cool/<你的用户名>/CDown.git
git push -u cnb main
git push cnb v0.2.2
```

> CNB 支持 HTTPS（推送时输入 cnb 用户名/密码或访问令牌）与 SSH 两种方式。

## 三、之后每次发版

```bash
git add -A
git commit -m "feat: xxx"
git tag -a v0.x.x -m "v0.x.x"
git push origin main --tags
git push cnb main --tags
```

## 远程仓库速查

```bash
git remote -v          # 查看已配置的远程
git remote set-url origin <新地址>   # 改地址
```
