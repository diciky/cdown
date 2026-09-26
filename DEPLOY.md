# CDown 发版指引（GitHub Actions 云端构建 + CNB）

> 自 v0.2.3 起，**发版不再本地构建**：推送 `v*` 标签 → GitHub Actions 自动完成
> Windows / macOS / Linux 三平台构建 + 浏览器扩展打包 + 发布 Releases + 附更新记录。

## 一、标准发版流程（本地三步）

```bash
# 1. 更新版本号（package.json 的 version）+ 在 CHANGELOG.md 顶部加新章节
# 2. 提交
git add -A && git commit -m "release: v0.x.x"

# 3. 打标签并推送（这一步触发云端构建）
git tag -a v0.x.x -m "v0.x.x"
git push origin main --tags
```

推送标签后到 GitHub 仓库 **Actions** 页查看构建进度（约 5-10 分钟），
完成后自动出现在 **Releases**：三平台安装包 + 扩展 zip + 更新记录。

## 二、更新记录从哪来

Release 说明 = **两部分自动合并**：

1. `CHANGELOG.md` 中对应版本的章节（`## [0.x.x] - 日期` 格式）——人工编写的重点变更
2. GitHub 自动生成的提交列表（自上个标签以来的全部 commit）

所以每次发版记得在 `CHANGELOG.md` 顶部补一段。

## 三、产物矩阵

| Runner | 产物 |
|---|---|
| windows-latest | `CDown Setup x.x.exe`、`CDown x.x.exe`（便携版） |
| macos-latest | `CDown-x.x.dmg`、`CDown-x.x.zip` |
| ubuntu-latest | `CDown-x.x.AppImage`、`CDown-x.x.deb`、`CDown-Extension-vx.x.zip` |

> macOS 构建未配置签名证书，首次打开需右键 → 打开（或系统设置放行）。
> ffmpeg 下载失败不阻塞构建（HLS 合并功能降级，其余功能不受影响）。

## 四、CNB（暂缓，待可登录后补推）

```bash
git remote add cnb https://cnb.cool/<你的用户名>/CDown.git   # 已配置可跳过
git push -u cnb main --tags
```

CNB 若需流水线构建可后续在仓库根添加 `.cnb.yml`（可参照 release.yml 改写），
当前 CNB 仅作代码镜像。

## 五、紧急热修

```bash
# 从标签切热修分支
git checkout -b hotfix/v0.x.1 v0.x.0
# 修复 → 提交 → 合回 main → 按第一节流程打新标签
```

## 远程仓库速查

```bash
git remote -v                       # origin=GitHub, cnb=CNB
git push origin main --tags         # 推 GitHub（触发 CI）
git push cnb main --tags            # 推 CNB 镜像
```
