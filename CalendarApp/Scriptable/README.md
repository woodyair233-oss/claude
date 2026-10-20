# 一览 · Scriptable 版（不需要签名）

在 iPhone 上**不签名、不用 Mac、不用开发者账号**就能使用的「一览」。
它运行在 App Store 上免费的 [Scriptable](https://apps.apple.com/app/id1405459188) 里，通过 Scriptable 直接读写系统的**日历**与**提醒事项**，所以和系统日历、iCloud、Google、Exchange 等所有账户保持同步，不另存一份数据。

| 日视图 | 周视图 | 月视图 + 排班 | 清单 + 快速新增 |
| --- | --- | --- | --- |
| ![日视图](docs/day.png) | ![周视图](docs/week.png) | ![月视图](docs/month.png) | ![清单](docs/list.png) |

（截图为示例数据。）

## 安装（约 2 分钟）

1. 在 App Store 安装 **Scriptable**（免费）。
2. 打开 Scriptable，点右上角 **＋** 新建脚本，粘贴下面这段代码，点右下角 ▶︎ 运行：

   ```js
   // 安装 / 更新「一览」
   const url = 'https://raw.githubusercontent.com/woodyair233-oss/claude/claude/zealous-knuth-jpnk92/CalendarApp/Scriptable/dist/%E4%B8%80%E8%A7%88.js';
   const code = await new Request(url).loadString();
   if (!code.includes('GlanceCore')) throw new Error('下载失败，请检查网络后重试');
   let fm;
   try { fm = FileManager.iCloud(); fm.documentsDirectory(); } catch (e) { fm = FileManager.local(); }
   fm.writeString(fm.joinPath(fm.documentsDirectory(), '一览.js'), code);
   log('已安装「一览」');
   ```

   运行后脚本列表里会出现「**一览**」。这段安装代码可以删掉；以后在「一览 → 设置 → 检查更新」就能更新。
3. 点「一览」运行，允许访问**日历**与**提醒事项**（请选择「完全访问」）。

> 也可以不用安装代码：在电脑上把 [`dist/一览.js`](dist/一览.js) 放进 **iCloud 云盘 / Scriptable** 文件夹。

### 放到主屏幕

- **App 图标**：打开「捷径」App → 新建捷径 → 添加操作「运行脚本」（Scriptable）→ 选择「一览」→ 关闭「运行时显示」→ 分享 →「添加到主屏幕」。
- **小组件**：主屏幕长按 → 左上角 ＋ → 选 Scriptable 小组件 → 加好后长按「编辑小组件」→ Script 选「一览」。支持小、中、大和锁定画面。点小组件会打开「一览」。

### 用 Siri 或捷径快速新增（不打开画面）

在「捷径」新建：「听写文本」→「运行脚本：一览」（输入选“听写的文本”）→ 设定 Siri 短语，例如「一览新增」。
之后说「一览新增」，再说「明天下午3点 开会 1小时」就会直接写进日历。
也可以用网址：`scriptable:///run/一览?add=周六 夜班`。

## 怎么用

| 操作 | 方式 |
| --- | --- |
| 切换日 / 周 / 月 | 顶部分段按钮；日视图右上「清单 / 时间轴」切换样式 |
| 换一周 / 一个月 | 左右滑动日期条或月历，或点 ‹ › |
| 移动日程 | 长按方块约 0.4 秒，再拖动；周视图可以拖到别天 |
| 改时长 | 长按方块底边的小横条，再上下拖 |
| 新建日程 | 时间轴空白处长按并往下拖出时长，或双击空白处 |
| 待办排进时间 | 长按待办（顶部托盘、「未排期」或清单），拖到时间轴某个时间；拖到日期条 / 月历格子则只改日期 |
| 完成待办 | 点圆圈 |
| 缩放时间轴 | 日视图双指捏合 |
| 排班 | 月视图「🖌 排班」→ 选班次 → 点日期；同一个班次再点一次就取消 |
| 快速新增 | 底部输入栏，例如 `明天下午3点 开会 1小时`、`周五 10:30-12:00 门诊`、`待办 交报告 !!`、`周六 夜班`、`组会 周三 9点 #工作`；送出前会显示它理解成什么，点第一个标签可切换日程 / 待办 |

快速新增的写法与原生版相同，详见 [CalendarApp/README.md](../README.md#快速新增语法)。

## 与原生 App 的差异（Scriptable 的限制）

- **重复日程**：Scriptable 无法指定只修改“这一次”，为免改到整个系列，重复日程不能直接拖动；点开后用「在系统编辑器中打开」修改，可选择“仅此次”或“所有将来的”。
- **待办提醒**：Scriptable 不能替提醒事项设置闹钟。打开「定时待办到点通知」（默认开启）后，由 Scriptable 在待办时间发通知，范围是未来 7 天。注意两种情况：
  - 如果待办在「提醒事项」里另外设了闹钟，会收到两次通知。
  - 拖动这类待办改时间后，原本的系统闹钟时间不会跟着变。
- **班次以标题辨认**：日程标题与班次模板名称相同就视为班次，所以别让一般日程跟班次重名。
- **「排班」日历**：Scriptable 不能新建日历，请先在系统「日历」App 新建一个，再到设置里选择它。
- **同步时机**：「一览」开着的时候，每 30 秒以及每次回到前台都会重新读取一次。别处的改动（系统日历、Mac、其他设备）通常在半分钟内出现。
- 打开时会先经过 Scriptable，比原生 App 慢一点（约 1 秒）。小组件不能直接勾选完成。
- 待办的「预估时长」只保存在这台 iPhone 上（Scriptable 的文件夹里）。

## 开发

```
Scriptable/
├── src/
│   ├── core.js         快速新增解析、时间轴排版、负荷、班次（与 Swift 版 GlanceCore 对应）
│   ├── app.js          网页界面：渲染、手势、编辑面板、与 Scriptable 通信
│   ├── app.css         样式（含深色模式）
│   ├── scriptable.js   Scriptable 端：日历 / 提醒事项读写、通知、小组件、Siri 快速新增、更新
│   └── mock.js         浏览器预览用的示例数据（模拟 Scriptable 端）
├── build.mjs           打包成 dist/一览.js 与 dist/preview.html
├── dist/               打包结果（已提交，手机直接下载这里的文件）
└── test/               核心逻辑、界面手势、模拟 Scriptable 环境的端到端测试
```

- 修改 `src/` 后执行 `node build.mjs`，再提交 `dist/`。
- `npm install && npm test`：跑核心逻辑测试，检查 `dist/` 是否最新，然后用 Chromium 模拟手指触摸，测试拖动、拉伸、捏合、拖放待办、排班等操作；也会在模拟的 Scriptable 环境里跑完整的 `dist/一览.js`。
- 在电脑浏览器打开 `dist/preview.html`，可以用示例数据试用整个界面（鼠标长按即可拖动）。
