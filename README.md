# Packsmith

Packsmith 可以从 Minecraft 开发实例中采集 Mod、配置和脚本，也可以用 Pakku 构建正式整合包。附带的示例使用 Minecraft 1.21.1 和 Fabric Loader 0.16.14，包含三份配置，分别演示公共、客户端和服务端文件如何随包分发。

## 用模板构建第一份整合包

从 GitHub 的 **Use this template** 创建项目并克隆到本地。打开直接包含 `workspace.json`、`packs/` 和 `.github/` 的仓库根目录。准备 Node.js 24、pnpm 10.28.2、Java 21 和 Git，运行：

```sh
pnpm install --frozen-lockfile
pnpm bootstrap
pnpm build
```

模板只有一个 Target，上面的命令会选中它。构建从 `packs/fabric-1.21.1/` 读取包源，自动检查锁文件与各侧覆盖资源。终端给出的 `dist/fabric-1.21.1/build-*/` 是本次结果，里面有可导入启动器的 `.mrpack`、给已装好对应游戏和 Loader 的服务器使用的 ZIP、构建报告和 `SHA256SUMS`。在 `packs/fabric-1.21.1/pakku.json` 里改成自己的包名和版本，即可开始维护。

`pnpm bootstrap` 下载 Pakku 1.5.0 并验证 SHA-256，之后复用本地缓存。要指定 Java 可执行文件，可设置 `PACKSMITH_JAVA`。

## 本地维护菜单

在仓库根目录运行 `pnpm install --frozen-lockfile`，然后用 `pnpm menu` 打开中文菜单。Windows、macOS 和 Linux 使用同一个入口。`pnpm mp` 或 `pnpm mp --help` 可以随时查看直接命令。

主菜单顶栏显示版本、工作区和当前 Target。移动焦点时可以看到这一步会读取或写入什么。窄窗口会把说明移到选中项下方。[宽屏实拍](docs/images/packsmith-menu-windows.png) · [窄屏实拍](docs/images/packsmith-menu-windows-narrow.png)

用 ↑、↓ 移动，Enter 选择。审查功能提案时，移动焦点可查看描述、关联文件和依赖。空格勾选当前项，`a` 全选，`i` 反选。输入 `/关键词` 再按 Enter 可筛选，单独输入 `/` 并回车可清除筛选。全选和反选只作用于当前结果，列表顶端显示全部已选数量。也可以直接输入要预览的功能编号，多选时用逗号或空格分隔。[功能多选](docs/images/packsmith-feature-selection.png) · [功能详情](docs/images/packsmith-feature-detail.png) · [44 列实拍](docs/images/packsmith-feature-44.png)

写入前，先看预览里的文件差异，再核对确认页的 Target、目标路径、完整预览编号和变更数量。默认选“否”，直接回车即可放弃写入。Esc 或 `0` 返回上一级，在主菜单则退出。输入路径时可留空返回。Ctrl+C 退出菜单。`TERM=dumb` 下用编号加回车选择，功能多选也支持输入 `a` 或 `i` 后回车。[写入确认实拍](docs/images/packsmith-apply-confirmation.png)

- 选**从实例采集**，粘贴启动器中这个实例的游戏目录。需要采集世界数据包时再填存档目录名。采集可以离线运行，无需先安装 Java 或 Pakku。
- 选**审查与应用**，在线查询 Mod 来源，或离线对照。有提案时，勾选要保留的功能，核对目标、实际文件差异和连带依赖，再决定是否写入并构建。首次审查后可以请 AI 助手整理提案，也可以[手写提案](#把选中的功能写入-target)。
- **检查与构建**可以只检查包源，也可以直接构建。首次需要 Pakku 时菜单会提示安装，构建完成后列出产物位置。
- 先在 Git 或编辑器中暂存文件，再选**提交已暂存的改动**打开[提交助手](#可选的提交助手)。

采集与 Target 无关。审查和构建会自动使用唯一或默认的 Target。有多个且未设默认时，菜单会让你选择，本次会话内可以切换。各项操作也可以使用下面的独立命令。

在 CI、管道或重定向输出时，直接运行 `pnpm targets`、`pnpm check` 或所需的其他命令。这些命令只用参数接收输入。`pnpm menu` 需要交互式终端，在上述环境会提示用法并退出。终端支持颜色时，设置 `NO_COLOR=1` 可关闭着色。CI、重定向和 `TERM=dumb` 使用纯文本状态标记，例如 `[ok]` 和 `[fail]`。

## 从开发实例采集

使用 Node.js 24 和 pnpm 10.28.2，在模板根目录安装依赖。在启动器里打开**要采集的实例的游戏目录**，把能直接看到该实例 `mods/`、`config/` 或 `kubejs/` 的那一层路径传给 `intake`。采集可离线运行，独立于 Java、Pakku 和 Target。

```powershell
pnpm install --frozen-lockfile
pnpm intake "D:\Minecraft\.minecraft\versions\我的整合包"
```

上例对应把每个版本的 Mod 放在 `versions/<实例名>/mods/` 的隔离布局。[HMCL 目录示例](https://docs.hmcl.net/launcher/isolation.html)

如果 Mod 在 `Instances/Dev/.minecraft/mods/`，就传 `Instances/Dev/.minecraft`。如果多个版本共用外层 `.minecraft/mods/`，就传外层 `.minecraft`。传入外层目录时，Packsmith 只采集共享内容，跳过 `versions/` 里的各个实例。

先打开 `.intake/current/report.md` 查看候选数量、读取字节数、耗时、Mod 声明和扫描提示。同目录的 `manifest.json` 记录每份候选的原始路径、大小、修改时间及 SHA-256。同内容的不同路径分别保留，重复项用 `duplicateOf` 指向首项。

| 游戏目录中的内容 | 采集结果 |
| --- | --- |
| `mods/` 下的 JAR，包括 `.jar.disabled`、`.jar.disable`、`.jar.bak` | 静态读取 Fabric、Forge 和 NeoForge 的 Mod ID、版本和依赖声明。按文件名后缀标记禁用副本。缺少声明或损坏的 JAR 也保留路径和哈希。 |
| `config/`、`defaultconfigs/` | 记录文件信息和指纹，便于后续按需审查。 |
| `kubejs/`、`scripts/`、`datapacks/`、`resourcepacks/`、`shaderpacks/` | 记录候选。脚本、配方和包内元数据等受支持的 UTF-8 文本在 256 KiB 以内时复制到 `files/`；同内容共用一份快照。归档、图片和大型文件只记文件信息。 |

要采集某个世界里的数据包，在同一命令末尾加 `--world "存档目录名"`，会额外读取 `saves/<存档目录名>/datapacks/`。扫描跳过启动器数据、日志、缓存、符号链接和已知凭据。实例文件仅供静态读取。

每次成功采集都会替换 `.intake/current/`，需留档时可提前复制该目录。`.intake/` 由 Git 忽略。若进程被强制结束并遗留 `.intake/.pending/`，先确认没有其他采集在运行。若 `current/` 缺失且 `.pending/previous/` 存在，将它改名移回 `current/`，再清理 `.pending/` 并重新运行采集。

## 从采集结果挑选要保留的功能

在同一仓库里运行 `pnpm review`。它将最近一次采集与选定 Target 的锁文件、公共覆盖、客户端覆盖和服务端覆盖逐项对照。只有一个 Target 时可省略参数；指定其他 Target 时，带上它在 `workspace.json` 中的 ID。

```powershell
pnpm review --target fabric-1.21.1
```

命中 Pakku 锁内哈希的 JAR 会标为已锁定。其余 JAR 按指纹批量查询 Modrinth；环境变量 `CURSEFORGE_API_KEY` 有值时也查询 CurseForge。平台只接收哈希或指纹。报告会区分精确发布文件、查无匹配和查询失败，并单列同一 Mod ID、同一版本却有不同 SHA-256 的文件。要只看本地证据，用 `pnpm review --offline`。[Modrinth 文件哈希查询](https://docs.modrinth.com/api/operations/versionsfromhashes/) · [CurseForge 指纹查询](https://docs.curseforge.com/rest-api/#get-fingerprints-matches-by-game-id)

对照结果写在 `.intake/current/review.json`，其中记录本次 Target。要查看某个候选的文本和各侧正式版本，传入清单里的游戏相对路径。脚本优先读取采集时的快照；没有快照的配置需要原实例仍可访问，工具会核对内容哈希。

```powershell
pnpm review --file "kubejs/server_scripts/press.js" --target fabric-1.21.1
```

要在脚本里读取结果，用 `pnpm --silent review --file "<游戏相对路径>"` 获取 JSON。这会省去 pnpm 自身的脚本启动提示。

接着可以告诉 AI 助手（例如 Codex 或 DSH）**“保留这次测试的配方，先给我方案。”** 如果助手没有自动发现项目里的维护说明，可以让它先读下面的维护工作流。提案会列出配方用到的 Mod、Target 已满足的依赖、脚本应放的位置和需要确认的问题。[维护工作流](.agents/skills/modpack-maintainer/SKILL.md)

## 把选中的功能写入 Target

告诉助手 **“只保留压板配方，地图设置先放着。”** 它会把功能清单记在 `.intake/current/proposal.json`，然后只为所选功能生成差异。你也可以手写这份文件。例如，下面的提案将一份 KubeJS 配方放进公共覆盖目录。把 `scanId` 换成当前 `manifest.json` 中的值，路径换成这次采集的实际文件。

```json
{
  "schema": 1,
  "scanId": "本次采集的 scanId",
  "target": "fabric-1.21.1",
  "features": [{
    "id": "plate",
    "title": "压板配方",
    "operations": [{
      "type": "file",
      "path": "kubejs/server_scripts/press.js",
      "destination": ".pakku/overrides/kubejs/server_scripts/press.js",
      "side": "common"
    }]
  }]
}
```

先预览，想一起纳入多个功能时重复 `--feature`。工具把文件复制到 Target 的临时副本，在那里调用 Pakku 处理所选依赖。终端列出文件变更及连带依赖，完整差异在 `.work/prepared/<编号>/changes.diff`。

```powershell
pnpm preview --feature plate --target fabric-1.21.1
```

核对后，将完整的预览编号交给助手，或运行下面的命令。写入前会重新核对所选实例文件和正式文件。若源实例改变，重新采集并审查；若是 Target 改变，重新对照并预览。写入完成后自动检查并构建所选 Target，终端会给出产物目录。

```powershell
pnpm apply --prepared "刚才输出的完整预览编号" --target fabric-1.21.1
```

| 提案中的操作 | 要填写的内容 |
| --- | --- |
| 复制配置、脚本或资源 | `type: "file"`，`path` 为实例路径，`destination` 为 Target 内的相对源路径。分发侧别 `side` 取 `common`、`client` 或 `server`。二进制资源在确认分发许可后写 `redistributable: true`。 |
| 合并部分文本改动 | 同上，另填 `content`，值为批准后要写入的完整 UTF-8 文本，最多 256 KiB。预览会展示相对正式版本实际增删的行。 |
| 新增或更新平台 Mod | `type: "dependency"`，`action` 取 `add` 或 `update`。填写候选 JAR 的 `path` 和有精确匹配的 `platform`（`modrinth` 或 `curseforge`）。更新时用 `from` 指定原锁定项目的 `pakku_id`。 |
| 替换或移除依赖 | 对审查已关联的原项目用 `action: "replace"`，其余字段同更新。替换成另一独立项目时，在同一功能里写一条 `remove` 和一条 `add`。显式移除只需 `type: "dependency"`、`action: "remove"` 和 `from`。 |

写入时，仓库的 `.work/` 和 `packs/` 需要位于同一个支持硬链接的卷，例如 NTFS。游戏实例可以放在其他卷。若发布进程被强制结束，先确认 `.work/publish/<target>.lock` 中的进程已退出，移走该锁文件后重跑同一条 `apply`。工具会根据相邻的 `<target>.journal/` 目录恢复写入。若只是构建失败，已批准的文件已写入，可直接用 `pnpm build --target <id>` 重试。

## 维护自己的包

每个 `packs/<id>/` 都是独立的 Pakku 工程。示例的 `pakku.json` 声明了包名、版本和公共 `config/`，`pakku-lock.json` 由 Pakku 维护。三个示例配置都可以替换成自己的文件。

| 放置位置（相对于 Target） | 分发范围 |
| --- | --- |
| `config/`（已在示例中声明）或 `.pakku/overrides/` | 客户端与服务端 |
| `.pakku/client-overrides/` | 仅客户端 |
| `.pakku/server-overrides/` | 仅服务端 |

覆盖目录中的文件按游戏相对路径打包。例如 `.pakku/server-overrides/config/rules.toml` 会成为服务端包中的 `config/rules.toml`。需要随包分发的本地 JAR、资源包或光影也可放入相应侧别的覆盖目录。

## 维护多个 Target

例如，要同时维护标准版和精简版，可以把示例工程 `packs/fabric-1.21.1/` 复制到 `packs/fabric-lite/`，修改精简版 `pakku.json` 的包名，再在 `workspace.json` 的 `targets` 中加入下面这一项。若第二个 Target 使用不同的 Minecraft 版本或 Loader，把对应版本已经初始化好的 Pakku 工程放到新目录，连同它自己的锁文件一起提交。[Pakku 工程初始化](https://juraj-hrivnak.github.io/Pakku/setting-up-a-modpack.html)

```json
{ "id": "fabric-lite", "path": "packs/fabric-lite", "artifacts": ["modrinth", "serverpack"] }
```

`artifacts` 列出这个 Target 想分发的格式，可选 `modrinth`、`curseforge` 和 `serverpack`，对应格式需要该 Pakku 工程能导出。登记后从仓库根目录运行：

```sh
pnpm targets
pnpm build --target fabric-lite
```

只有一个 Target 时会自动选中。多个 Target 共存时，也可以在 `workspace.json` 顶层设置 `"defaultTarget": "fabric-1.21.1"`，将它作为省略参数时的默认值。

示例模板运行 `pnpm --silent targets` 时，会列出可以构建的格式。窄终端或重定向到文件时也使用这个布局。

```text
PACKSMITH / TARGETS
fabric-1.21.1  （唯一 Target，自动选中）
  工程：packs/fabric-1.21.1
  产物：modrinth, serverpack
```

## 可选的提交助手

可以照常用 `git commit` 或编辑器提交。想用 Gitmoji 和 Conventional Commits 时，把要提交的文件暂存好，再运行 `pnpm commit`。选一个类型，按需填写范围，写一句改动说明，确认后提交。

| 类型 | 什么时候用 | 提交示例 |
| --- | --- | --- |
| `feat` | 增减玩法内容或调整平衡 | `✨ feat(KubeJS): 保留 KubeJS 的压板配方` |
| `fix` | 修复已有内容的问题 | `🐛 fix(fabric-1.21.1): 修复服务端启动崩溃` |
| `chore` | 例行升级 Mod、调整包版本或维护工具 | `🔧 chore: 升级 Sodium 到 0.6.13` |
| `docs` | 修改安装说明、指南或更新日志 | `📝 docs: 补充服务端安装步骤` |

范围可以留空，也可以写配方、Mod 名或 Target ID。每个项目都可以在 [cz.config.cjs](cz.config.cjs) 调整菜单和表情。CI 按文件改动选择 Target，发布仍由 Git 标签触发。

## 从 GitHub Actions 下载预览包

把整合包改动提交并推送到任意开发分支。在仓库的 **Actions → CI** 打开这次 push 对应的运行，在 **Artifacts** 下载 `preview-<Target ID>`。解开下载的 ZIP 后，把里面的 `.mrpack` 导入启动器。附件还包含该 Target 声明的其他产物、`build-report.json` 和 `SHA256SUMS`，预览保留 14 天。

CI 按 Git 中的改动选择任务：

| 本次改动 | 会运行什么 |
| --- | --- |
| 一个 Target 的配置、锁文件、脚本或其他包源 | 构建这个 Target。文件从一个 Target 移到另一个时，两边都构建。 |
| 公共构建代码、工作区登记、工具链或依赖锁文件 | 在 Windows 和 Linux 上测试，验证模板构建，再为所有 Target 出包。 |
| 采集、审查或写回工具 | 在两种系统上测试，并用临时工程验证构建和部分批准。 |
| 仅修改根目录说明 | CI 汇总结果，跳过出包。放在正式覆盖目录里的文档仍属于包源。 |

PR 会检查相对目标分支共同祖先的累计改动。首次推送分支，或在 **Actions → CI → Run workflow** 手动运行时，会验证全部 Target。使用分支保护的仓库可以将 **Required checks** 设为必需检查。

含 CurseForge 项目的 Target 也会尝试构建。如果 Pakku 导出时需要访问受限 API，可在仓库的 Actions secrets 中配置 `CURSEFORGE_API_KEY`。默认分支或受保护分支的 push 和手动预览可以使用该密钥。PR 使用公开可用的数据，导出失败时可在构建日志中查看 Pakku 的报错。

## 创建发布草稿

只有一个 Target 时，将发布标签推送到 GitHub 即可生成草稿。例如下面两条命令使用当前提交和原样的标签 `A1.4`。

```sh
git tag A1.4
git push origin refs/tags/A1.4
```

你也可以用 `a1.4`、`nightly/2026-11-27` 或自己的其他 Git 标签。包版本取标签指向的提交中该 Target 的 `pakku.json`。例如包版本是 `0.1.0` 时，`A1.4` 的草稿会同时列出标签、包版本、Target 和提交。工作流核对报告、附件哈希，以及 MRPACK 或 CurseForge 包内的版本。

多 Target 项目推送标签后，到 **Actions → Draft Release → Run workflow**，选择包含这份工作流的分支，在 `tag` 填已有标签原名，在 `target` 填该标签对应的 Target ID。即使本地设了默认 Target，发布时也由你选包。手动运行入口需要默认分支上有这份工作流。[GitHub 手动运行工作流说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)

在 **Releases** 里核对草稿、填写更新说明，按需勾选预发布后手动公开。如果同一标签已有草稿或 Release，工作流会保留它。上传中断时可从该次 Actions 运行下载已校验的发布附件，核对已有草稿并补全。

## 验证模板

`pnpm test` 运行本地测试。`pnpm verify:build` 在临时工程中实际构建单个和多个 Target，还会从两个功能中选一个写入，检查 Git 差异、过期候选及归档中的文件。运行构建验收前先完成工具安装。

模板使用 [CC0 1.0](LICENSE)。第三方 Mod 和素材按各自许可证分发。
