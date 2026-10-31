# 验证记录（SoundWeave 声织 v0.6.0）

验证日期：2026-11-01（v0.6.0 Windows 桌面 EXE 交付后重新验证）
环境：Windows x64，Node 24 / npm 11，Chrome（Chromium 内核）；EXE 内置 Chromium（Electron 45.2.1）
采样率：48000 Hz（AudioWorklet 实测）

本文件只记录**实际执行过**的验证。未执行的项在 [progress.md](progress.md) 的「待人工试听」与「已知限制」中单独列出。

---

## 1. 构建与类型检查

命令：

```powershell
npm run build
```

实际输出（节选，v0.6.0 最新一次）：

```text
> tsc --noEmit && vite build
vite v7.3.7 building client environment for production...
✓ 31 modules transformed.
dist/index.html                 5.10 kB │ gzip:  1.78 kB
dist/assets/index-DDUDim6A.css 22.79 kB │ gzip:  5.41 kB
dist/assets/index-CinzxErE.js 216.92 kB │ gzip: 64.74 kB
✓ built in 1.23s
```

构建过程中曾出现一次类型错误并已修复：`src/core/audio-engine.ts(173,65): error TS2345: Argument of type 'string' is not assignable to parameter of type 'InstrumentType'`——`setPreview()` / `previewNotes()` 的 `instrumentType` 参数改为 `InstrumentType` 并补充类型导入后通过。

v0.3.0 相较 v0.2.2：JS 由 161.57 kB 增至 183.33 kB（新增钢琴卷帘多选/复制粘贴、自动化曲线编辑器、预设试听与 A-B 对比、Web MIDI 输入、自定义音色库）。v0.3.1 新增自定义编曲块库，JS 增至 189.13 kB（29 modules）。v0.4.0 新增弯音/触后 DSP 与 MIDI Learn，JS 增至 197.36 kB（30 modules）。v0.5.0 新增 WAV 解码、音频素材、音频轨 DSP 与导入 UI，JS 增至 216.92 kB（31 modules）、CSS 22.79 kB。v0.6.0 新增 Electron 宿主与打包/自检脚本，Web 产物 JS/CSS 不变，`index.html` 因加入 CSP meta 由 4.80 kB 增至 5.10 kB。打包产物仍为零运行时依赖。

结论：类型检查通过，生产构建成功，`dist/` 可作为网站交付。

---

## 2. DSP 离线渲染（Node，无浏览器）

命令：

```powershell
npm run render-test
```

该脚本直接实例化 `src/audio/studio-processor.js` 中**与浏览器 Worklet 相同的** `StudioProcessor`，按 128 采样逐块调用 `processBlock`，编码为 16-bit WAV 并写 `docs/audio/`。

实际输出（v0.3.0，节选关键行）：

```text
P1 多轨混音(8小节)  len=21.50s ok=true peak=0.810 rms=0.2838 dc=0.00011 nonFinite=0 over1=0 audible=true
（v0.2.2 起 WAV 编码直接复用 src/core/wav.ts，不再使用测试脚本内的独立编码器）
音高参考 p1-ep: 期望 261.6Hz, 峰值 261.6Hz (-0.0 cents，窗口内音符重叠，仅记录)
音高 单音 piano: 期望 261.6Hz, 实测 261.7Hz, 偏差 0.4 cents OK
音高 单音 guitar: 期望 261.6Hz, 实测 261.9Hz, 偏差 1.7 cents OK
音高 单音 synth: 期望 220.0Hz, 实测 220.0Hz, 偏差 0.0 cents OK
音高 单音 bass: 期望 130.8Hz, 实测 130.8Hz, 偏差 0.1 cents OK
参数差异 cutoff 300 vs 4000: rmsA=0.1603 rmsB=0.1233 meanAbsDiff=0.1279
p4-wav-音频片段                len=2.40s ok=true peak=0.407 rms=0.1789 dc=0.00000 nonFinite=0 over1=0 audible=true
音频片段: 播放段 rms=0.293 起点前=0.000 终点后=0.000
音高 WAV 音频 440Hz: 期望 440.0Hz, 实测 440.0Hz, 偏差 -0.0 cents OK
PASS: 渲染长度正确、非静音、无非法数值、峰值未超过 1
PASS: 单音音准全部在 ±20 cents 内
```

v0.5.0 新增第 4 组用例：44.1 kHz 单声道正弦素材经 `createAudioAsset` 编码、`decodeAssetPcm` 解码，以 `asset` 消息注册后，再用 `audio` 事件在 0.6 s 处起播（`offsetSec 0.25`、`dur 0.9`、`gain 0.8`）。这段素材采样率与 Worklet 的 48 kHz 不同，因此同时覆盖了 `AudioVoice` 的线性插值重采样；播放段 RMS 0.293、片段起点前与终点后均为 0.000，440 Hz 音高偏差 -0.0 cents。

v0.3.0 对音高测试做了两处调整：

1. **估计器精度**：`dominantFreq()` 改为 Hann 窗 + 1 Hz 步进 DFT + 抛物线插值。此前的矩形窗 + 2 Hz 步进本身就有约 ±26 cents 量化误差，无法支撑更严格的判定。
2. **判定范围分流**：示范乐句里同一窗口内音符重叠（48@0、52@0.0625s、55@0.125s），频谱峰不可归因于单个音，改为 `referencePitch()` 只记录；严格判定放到新增的单音块——每种音源只起一个持续音，窗口内没有其它音符，阈值 ±20 cents。

单音音准实测（`checkPitch`，0.2 s 起始、0.5 s 窗口）：

| 音源 | 音高 | 期望频率 | 实测偏差 |
| --- | --- | --- | --- |
| piano | 60 | 261.63 Hz | **0.4 cents** |
| guitar | 60 | 261.63 Hz | **1.7 cents** |
| synth | 57（wave=square, detune=0, lfo=0） | 220.00 Hz | **0.0 cents** |
| bass | 60 + octave -12 | 130.81 Hz | **0.1 cents** |

四个单音源均 `audible=true`、长度 5.50 s、`nonFinite=0`、`over1=0`。

v0.2.1 的数值变化说明了什么：

- 总线加入 DC 阻断后，8 小节混音 `dc` 从 v0.2.0 的 +0.00656 降到接近 0（v0.2.2 记录 -0.00008，v0.3.0 首音参数即时生效后重新测得 **0.00011**）。
- 8 小节混音 `peak` 0.810、`over1=0`：加入 tanh 软限幅后仍无采样超过满刻度。
- 合成器音高偏差由 v0.2.0 的 12.4 cents 降到 v0.3.0 单音实测 **0.0 cents**。
- 参数差异 `meanAbsDiff` 为 0.1279（v0.2.0 记录为 0.0521），滤波参数对输出的影响明显。本文此前在一处写 0.0521、另一处写 0.1279，现统一以本次实测 0.1279 为准。

校验含义：

- `len`：输出时长与请求时长误差 < 2%，无截断。
- `peak` ≤ 1 且 `over1=0`：16-bit 编码前没有采样超过满刻度，即**没有发生硬削波**。这是数值检查结论，不等于“无削波失真”——总线使用 tanh 软限幅，接近满刻度时仍会引入非线性谐波，听感需人工试听确认。
- `rms` > 0.005：非静音。
- `nonFinite=0`：无 NaN/Inf。
- `dc` 接近 0：无显著直流偏移。
- 音高 DFT：合成器/吉他/钢琴在 ±60 cents 内；EP 为 FM 音色，峰值可能在边带，仅作记录。
- 参数差异：同一合成器仅改 cutoff，输出平均绝对差 0.1279，证明参数真实生效。

产物（可用任意播放器试听）：

- `docs/audio/p1-mix-8bars.wav`（8 小节多轨混音）
- `docs/audio/p1-ep.wav`、`p1-synth.wav`、`p1-guitar.wav`、`p1-drums.wav`、`p1-piano.wav`
- `docs/audio/p4-wav-clip.wav`（v0.5.0 音频片段离线渲染：0.6 s 起播 0.9 s 的 44.1 kHz 正弦素材）

---

## 3. 内容库完整性

通过 Node 侧打包检查（临时脚本已删除，可按下述逻辑复现）：

- 导入 `src/core/blocks.ts` 的 `BLOCKS` 与 `src/core/demos.ts` 的 `demoById`。
- 统计块数量，按 id 查询 `bass-root` / `bass-fifth`。
- 构建三首示例工程并统计片段数。

实际结果：

```text
blocks= 48
bass-root= "根音四分节奏"
bass-fifth= "根音与五度"
demo-night ok clips= 28 tracks= 5
demo-city ok clips= 36 tracks= 5
demo-morning ok clips= 29 tracks= 5
```

结论：48 块全部注册，示例工程可构建。此前「未知编曲块 bass-root」的根因是 `M`/`Ba`/`Dr`/`F` 构造函数只返回对象、没有写入 `BLOCKS` 数组，导致运行时只有 12 个和弦块；已修复。

---

## 4. 开发服务器浏览器实测（127.0.0.1:5173）

测试项与结果：

| 测试 | 结果 |
| --- | --- |
| 页面加载，五大区域渲染 | PASS |
| 底部状态栏显示 `48 kHz · 运行中 · AudioWorklet` | PASS |
| 载入「夜航 Lo-fi」示例 | PASS：`5 轨 · 28 片段 · 88 BPM`，无 error toast |
| 播放 | PASS：按钮变为暂停、位置从 1.1 前进到 2.3、状态栏「播放中 · 音频时钟驱动」 |
| 控制台 | PASS：无任何错误 |

截图目录（Trae 会话临时目录）：

- `C:\Users\VICTUS\.trae-cn\trae-browser-screenshots\6ae5bbad73438f6e0d647efa\`
- `C:\Users\VICTUS\AppData\Local\Temp\trae\screenshots\`

---

## 5. 生产构建浏览器实测（127.0.0.1:4173，`npm run preview`）

| 测试 | 结果 |
| --- | --- |
| UI 完整渲染 | PASS |
| AudioWorklet 48 kHz 运行 | PASS |
| 载入「夜航 Lo-fi」 | PASS：28 片段，控制台无错误 |
| 播放 | PASS：位置 0 → 2.1 |
| 导出 WAV | PASS：状态栏「已导出 WAV：45.24 秒 · 48000 Hz · 16-bit」，控制台无错误 |
| 分轨导出 | PASS：5 条分轨请求完成，状态栏「已导出 5 条分轨 WAV」，控制台无错误 |
| 导出 MIDI | PASS：下载 `夜航 Lo-fi.mid`，提示「已导出 MIDI」 |

预设与保存/恢复实测（生产构建）：

| 测试 | 结果 |
| --- | --- |
| 选中贝斯轨并应用「电贝斯」预设 | PASS：检查器标题由「指弹贝斯」变为「电贝斯」，参数与描述同步变化 |
| 点击「保存」 | PASS：状态栏「已保存工程文件：夜航 Lo-fi.swproj.json」 |
| 刷新页面 | PASS：状态栏「已恢复上次自动保存的工程」，仍为 5 轨 28 片段、88 BPM，预设修改保留 |
| 控制台 | PASS：保存与恢复前后均无错误 |

下载拦截记录（开发服务器）：

- WAV：`夜航 Lo-fi.wav`，8,685,428 字节，`audio/wav`
- MIDI：`夜航 Lo-fi.mid`，4,917 字节，`audio/midi`

说明：分轨测试中浏览器侧列出的文件名来自下载目录既有文件，不能作为本次导出文件内容的独立证据；本次可确认的是应用状态栏与下载触发（5 条）以及无错误。

### 5.1 v0.2.1 界面重做后的布局实测

`npm run preview` 在 4173 端口返回 200，浏览器视口 1272×807 下测量实际布局矩形：

| 区域 | 实测尺寸 |
| --- | --- |
| 顶栏 | 高度 62 px |
| 左栏（素材库） | 宽度 258 px |
| 中央工作区 | 宽度 553 px |
| 右栏（检查器 + 调音台） | 宽度 326 px |
| 底部状态栏 | 高度 24 px |

| 测试 | 结果 |
| --- | --- |
| 三栏 + 顶栏 + 状态栏全部可见 | PASS |
| 元素重叠、裁剪 | PASS：无重叠、无裁剪 |
| 横向滚动溢出 | PASS：无横向溢出 |
| 点击播放 | PASS：按钮切为暂停，位置由 1.1 前进到 2.2 |
| 状态栏 | PASS：`48 kHz · 运行中 · AudioWorklet` |
| 控制台 | PASS：无错误 |

说明：浏览器截图工具在本次会话返回「Screenshot is currently unavailable (the browser tab may be offscreen or the renderer is throttled)」，因此上表证据来自可访问性快照与 DOM 布局矩形，而非像素截图。调音台竖向推子、PAN/REV 小滑杆、M/S 与电平表的**拖动交互**未做逐项自动化点击验证，需要在人工使用时确认。

---

## 6. v0.2.2 播放与导出正确性回归

### 6.1 自动化回归测试（修复前失败 → 修复后通过）

命令：

```powershell
node tools/transport-tests.mjs
```

测试直接加载 TypeScript 源码（esbuild 打包为 data URL 动态 import），用假引擎与可控音频时钟驱动真实 `Scheduler`，并实例化与浏览器 Worklet 相同的 `StudioProcessor`。

**修复前基线**（`work/v0.2.2-before.log`，15/15 失败）：

```text
FAIL 长音：期望 1 次起音，实际 39 次
FAIL 循环：第 1 轮时值应为 2 秒，实际 0.080s
FAIL 循环（非零起点）：第 2 轮应在 2.060s，实际 0.140s
FAIL 后台恢复：5.2s 应位于第 2.4 拍，实际 10.280
FAIL 停止：旧运输事件未清空（1 !== 0）
FAIL 试听隔离：新试听未清理旧事件（2 !== 1）
FAIL 实时键盘：transport 重置清除了 live 事件
FAIL 节拍器 4/4、3/4、6/8：均只有 1 次点击
FAIL 变速：Scheduler 缺少 setTempo
FAIL 离线 solo、自动化一致、lane 删除：session.ts 不存在
```

**修复后**（`work/v0.2.2-after.log`，15/15 通过）：

```text
PASS 长音：120 BPM 4 拍持续音在 1 秒内只起音一次
PASS 循环：120 BPM 0—4 拍循环 20 轮，2 秒回绕且不漂移
PASS 循环：非零起点 2—6 拍循环 20 轮对齐
PASS 后台恢复：计时器停顿 5 秒后不补发过期事件
PASS 停止：resetSource 丢弃已排队的未来运输事件
PASS 试听隔离：resetSource preview 不取消工程播放事件
PASS 实时键盘：transport 重置不清除 live 来源事件
PASS 节拍器：4/4 连续 4 小节 16 次点击，每小节重音
PASS 节拍器：3/4 连续 4 小节 12 次点击
PASS 节拍器：6/8 复合拍按附点四分点击，重音落在小节头
PASS 节拍器：从中途小数拍开始不漏拍
PASS 变速：120→60→180 BPM 位置连续，不跳拍
PASS 离线导出：完整混音遵循 solo，分轨忽略其它轨独奏
PASS 自动化：实时与离线在中点得到同一控制值
PASS 自动化：删除 lane 后恢复静态参数

总计 15 项，通过 15 项，失败 0 项
```

说明：后台恢复用例的位置期望含 0.06 s 预滚（5.2 s 实际播放 5.14 s / 0.5 s = 10.28 拍，4 拍循环后为 2.28 拍）；节拍器用例的截止时间留出 0.14 s 前瞻余量，避免把下一小节首拍提前计入。

### 6.2 生产构建浏览器实测（`npm run preview`，127.0.0.1:4173）

| 测试 | 结果 |
| --- | --- |
| 播放 | PASS：`#position` 持续前进，状态栏「播放中 · 音频时钟驱动」 |
| 播放中变速（120→60 BPM） | PASS：`#position` 继续前进，未回退到起点；观测中出现的回绕发生在设置循环区间内，非位置重置 |
| 停止 | PASS：`#position` 冻结在停止值，状态栏「已停止」；再次播放从冻结值继续 |
| 循环 0–4 拍回绕 | PASS：`#position` 依次 1.1→1.2→1.3→1.4→1.1→… 循环 |
| 播放中切换节拍器 | PASS：切换后 `#position` 继续前进 |
| 导出 WAV | PASS：状态栏「已导出 WAV：3.60 秒 · 48000 Hz · 16-bit」（循环 0–4 拍、120 BPM、含 1.6 s 尾音） |

本轮浏览器验证的是 UI 与运输位置行为；音频事件是否真正被取消由 6.1 的处理器级测试（`resetSource`）给出证据，未做音频采集比对。

---

## 7. v0.3.0 音色与编辑体验验证

### 7.1 编辑层纯函数回归

命令：

```powershell
node tools/edit-tests.mjs
```

与 `transport-tests.mjs` 同一套方式：esbuild 把 TypeScript 纯模块打包成 data URL 动态 import，不依赖浏览器。

```text
总计 28 项，通过 28 项，失败 0 项
```

覆盖：矩形框选与追加多选、复制粘贴（相对位置/力度保留、粘贴到播放头）、批量力度、方向键微调（1/16 拍与半音边界）、删除、自动化点新建/拖动/区间覆盖删除/点邻近删除/排序。

### 7.2 音色客观测试

命令：

```powershell
node tools/sound-tests.mjs
```

```text
总计 34 项，通过 34 项，失败 0 项
```

覆盖范围：

| 组 | 内容 |
| --- | --- |
| 预设审计 | 64 个预设 ID 唯一、分类合法、每个参数键都在 `PARAM_DEFS` 内、宏目标参数/FX 合法 |
| 力度单调 | 0.35 / 0.6 / 0.85 三档，输出 RMS 随力度单调上升 |
| 多音高音准 | piano 48/60/72（±10 cents）、guitar 52/60/67（±15）、synth 57/64/72（±10）、bass 48/52/57（±12） |
| 释音 | noteOff 后能量在预期时间内衰减 |
| 踩镲互斥 | hat/openhat/crash 同拍时只保留优先者 |
| 声像 | pan 左/中/右的能量分布符合 `panGain` |
| 极端参数 | 6 轨同开极端参数，无 NaN/Inf、无超 1 采样 |
| 预设试听 | 64 预设逐个试听渲染，无削波，试听长度覆盖起音 |

### 7.3 定位过程：合成器音高 +13 cents 与试听首音失真

首轮与第二轮共出现 4 项失败，前 2 项为 bass 预设参数越界（`pulseWidth` 未在 `PARAM_DEFS` 声明）与三振荡器随机相位互相抵消（已改为固定错相 `[0, 0.25, 0.75]`）。剩余项是 `synth 57 +13.0 cents`、`synth 72 +1199.8 cents`。

诊断步骤（临时脚本已删除，路径在 `%TEMP%`）：

1. `pitch-diag.mjs`：用纯合成正弦/锯齿送入 `dominantFreq`，测得 220.000 Hz——排除估计器。
2. `spec-diag.mjs`：DSP 输出频谱峰在 221.6 Hz、过零率 890/s（应为 220 Hz 的 440/s）。
3. `est-diag.mjs`：确认窗口与插值无系统性偏移。
4. `voice-diag.mjs`：打印 `SynthVoice` 实际状态，得到 `det: [-7, 0, 7]`——测试明明传入 `detune: 0`。

根因：`Track` 的参数平滑每 block 以 0.1 向目标收敛，而新声部在收敛前创建，读到了旧参数（默认 detune 7）。这不只是测试伪影，也是真实产品缺陷：切换音色或连续试听两个同类型预设时，第一个音符会用旧 detune/cutoff 起音。

修复（`studio-processor.js`）：

```js
hasActiveVoices() {
  for (const v of this.voices) if (!v.done) return true;
  return false;
}
setParams(partial) {
  if (!partial) return;
  Object.assign(this.target, partial);
  // 没有发声声部时不存在需要淡出的过渡，直接生效
  if (!this.hasActiveVoices()) Object.assign(this.p, partial);
}
```

修复后 `voice: SynthVoice f0 220 det [-0,0,0]`，sound-tests 34/34 通过。

### 7.4 生产构建浏览器实测（`npm run preview`，127.0.0.1:4173）

| 测试 | 结果 |
| --- | --- |
| 预设试听 | PASS：状态栏「试听「暖电钢」 · 温暖的 FM 电钢…」，引擎「48 kHz · 运行中 · AudioWorklet」 |
| A/B 对比 | PASS：先「A/B 对比：A「清冽电钢」」，再「A/B 对比：B 当前「暖电钢」」 |
| 插入编曲块 | PASS：状态栏「温暖流行进行 · 12 音符 · 16 拍」 |
| 全选 | PASS：Ctrl+A →「已选中 12 个音符」 |
| 复制粘贴 | PASS：Ctrl+C「已复制 12 个音符」→ Ctrl+V「粘贴 12 音符」，片段由 12 变 24 音符 |
| 力度滑杆 | PASS：0.7 → 0.89，状态「修改力度」，选中 12 音符 velocity max 0.89 / avg 0.80 |
| 方向键微调 | PASS：ArrowRight 选中组起点 0 → 0.25 拍；ArrowLeft 回到 0；ArrowUp/ArrowDown 最低音高 52 ↔ 53，状态「微调音符」 |
| 新建自动化轨 | PASS：新建「FM 深度」lane，读数 `0.3 – 5 0 点`，状态「新建自动化轨：FM 深度」 |

环境限制（如实记录）：

- 复用旧标签页时 viewport 为 0×0、点击无效；新建标签页并以前台方式导航后恢复（1272×847）。
- 快照 ref 在面板重渲染后失效，需每次动作前重新取快照。
- `#inspector` 有独立滚动（`scrollTop` 1286、可视高 252），需先滚动到元素再点击。
- `browser_click` 无法向 canvas 注入超出元素范围的 offset，因此钢琴卷帘框选拖拽、自动化曲线画布的绘制/拖点/右键删除未通过浏览器桥验证；这些路径的纯函数逻辑由 7.1 的 28 项回归覆盖，UI 指针路径仍需人工点按确认。
- 截图工具在本次会话不可用，证据来自可访问性快照、DOM 属性与状态栏文本。

### 7.5 Web MIDI 输入

命令：

```powershell
node tools/midi-tests.mjs
```

测试直接实例化与浏览器相同的 `MidiInput`，向 `onMessage` 喂 MIDI 字节流：

```text
PASS  力度：127 → 1
PASS  力度：64 → 约 0.504
PASS  力度：1 → 下限 0.05
PASS  音符：Note On 触发一次
PASS  音符：同一音重复 Note On 不重复起音
PASS  音符：Note Off 释放
PASS  音符：力度 0 的 Note On 视为 Note Off
PASS  音符：未按下的 Note Off 被忽略
PASS  踏板：踩下时松键不立即停音
PASS  踏板：抬起后释放被延音的音
PASS  踏板：未踩踏板时正常松键
PASS  踏板：第二个音照常松键
PASS  踏板：延音中重按同一音不重复起音
PASS  踏板：重按后抬起踏板只释放一次
PASS  CC123：释放所有正在发声的音
PASS  CC123：踏板状态被清除
PASS  releaseAll：停止运输/切窗口时释放全部音
PASS  其它：弯音/音量 CC/触后不误触发音符

总计 18 项，通过 18 项，失败 0 项
```

浏览器（生产构建 4173）：

| 测试 | 结果 |
| --- | --- |
| 顶栏 MIDI 按钮存在 | PASS：可访问性快照中有 `button "MIDI"` |
| 点击按钮 | PASS（错误路径）：状态栏由「MIDI 未连接」变为「未获得 MIDI 访问权限（请在站点权限中允许）」 |
| 控制台 | PASS：无错误 |

说明：本次为自动化浏览器环境，Web MIDI 权限无法授予，也没有实体控制器。因此**设备枚举、热插拔 `statechange`、真实按键与踏板的端到端表现未验证**；已验证的是按钮接线、状态栏反馈、错误处理，以及 18 项输入字节流逻辑。

### 7.6 自定义音色库

命令：

```powershell
node tools/preset-tests.mjs
```

测试通过 esbuild 把 `src/core/user-presets.ts` 与 `src/core/presets.ts` 打包为 ESM，在 Node 中注入内存版 `localStorage`，直接调用与浏览器相同的读写/校验函数：

```text
PASS  校验：合法预设被保留 / 自定义预设默认 custom=true / 缺少 category 时归到「我的音色」
PASS  校验：类型非法、空名称、空 id、无参数、非对象均返回 null
PASS  校验：参数只保留有限数字；效果只保留有限数字；标签裁剪为 6 个字符串；无有效效果字段时 fx 不保留
PASS  新增：两条音色都写入；新保存的排在前面
PASS  覆盖：同 ID 原位替换，数量不变；名称已更新
PASS  删除：目标音色被移除；不存在的 ID 不报错
PASS  上限：库存最多 120 条
PASS  导出：格式标记正确；包含全部自定义音色；效果快照被保留
PASS  导入：首次全部新增；同 ID 再次导入全部跳过；接受纯数组形式并过滤坏数据；非音色库文件与非法 JSON 抛错
PASS  内置：预设数量保持 64；分类包含「我的音色」
PASS  合并：allPresets 包含自定义音色；presetById 能查到；用户音色带 custom 标记；内置音色不受影响
PASS  无存储：读取返回空列表；写入不抛错；新增返回内存列表；导出为空库
PASS  损坏存储：非法 JSON / 非数组 / 混合坏条目均不崩溃并逐条丢弃

ALL PASS  41/41
```

浏览器（生产构建 4173，`npm run preview`）：

| 测试 | 结果 |
| --- | --- |
| 保存音色 | PASS：检查器点击「保存音色」→ 状态栏「已保存音色「暖电钢 副本」」，浏览器出现「我的音色 1」分组与新行 |
| 刷新持久化 | PASS：刷新页面后「我的音色 1」仍在 |
| 应用自定义音色 | PASS：点击 ✓ → 状态栏「应用音色「暖电钢 副本」」，检查器显示`电钢琴 暖电钢 副本`与「自定义音色 · 基于「暖电钢」」 |
| 删除自定义音色 | PASS：点击 × 并确认 → 状态栏「删除自定义音色」，分组变为「还没有自定义音色」，轨道回落到内置「暖电钢」 |
| 控制台 | PASS：全程无错误 |

说明：导出按钮下载 JSON、导入按钮调用系统文件选择框。导出内容与导入解析逻辑由上述 41 项 Node 测试覆盖（含真实 `exportUserPresetsJson()` 输出再导入的往返），但本次自动化浏览器无法操作系统文件选择框，**导入按钮的端到端文件读取未实测**，需人工点一次确认。

### 7.7 自定义编曲块库

命令：

```powershell
node tools/block-tests.mjs
```

同一套 esbuild + 内存 `localStorage` 方式，直接调用与浏览器相同的编曲块读写/校验函数：

```text
PASS  校验：合法块保留 / custom 标记 / 长度按音符范围推导
PASS  校验：非法分类、空名称、空 id、没有音符、非对象均返回 null
PASS  校验：非法音源类型回落 synth；调性裁剪；空风格回落；速度范围排序；标签上限
PASS  校验：越界音高过滤、音高取整、负起音归零、坏长度/力度/奏法规范、非法音符条目丢弃
PASS  片段转块：名称、小节数、超出片段长度的音符过滤、相对位置/力度/奏法保留、分类按音源推导
PASS  新增/覆盖/删除：顺序、同 ID 原位替换、不存在的 ID 不报错
PASS  上限：库存最多 100 条
PASS  导出/导入：格式标记、音符完整保留、同 ID 跳过、纯数组形式、坏数据过滤、非块库与非法 JSON 抛错
PASS  合并：内置 48 块不变；allBlocks 49；blockById 与 blocksByCategory 可查自定义块；克隆音符获得新 ID
PASS  无存储/损坏存储：不崩溃、逐条丢弃坏条目
ALL PASS  58/58
```

浏览器（生产构建 4173，`npm run preview`）闭环：

| 测试 | 结果 |
| --- | --- |
| 插入编曲块 | PASS：双击「温暖流行进行」→ 状态栏「插入编曲块「温暖流行进行」」，时间轴 12 音符 |
| 保存当前片段 | PASS：「保存片段」→ 状态栏「已保存编曲块「温暖流行进行」· 4 小节」 |
| 我的编曲块 | PASS：筹码变为「我的编曲块 1」，自定义行显示「4 小节 C · 自定义 · 60–160 BPM」与 × 按钮，「导出」由禁用变可用 |
| 刷新持久化 | PASS：刷新后仍为「我的编曲块 1」，自定义行与 × 按钮仍在 |
| 删除 | PASS：点击 × 并确认 → 状态栏「删除自定义编曲块」，筹码回到「还没有自定义编曲块」，「导出」恢复禁用 |
| 控制台 | PASS：全程无错误 |

说明：导入按钮同样调用系统文件选择框，导入解析已由 58 项 Node 测试覆盖（含真实导出文本往返），浏览器文件读取路径未实测。

### 7.8 MIDI 弯音、触后与 CC MIDI Learn（v0.4.0）

命令：

```powershell
node tools/midi-tests.mjs
```

同一套 esbuild + 内存 `localStorage` 方式，直接实例化与浏览器相同的 `MidiInput`，向 `onMessage` 喂 MIDI 字节流；映射函数直接调用 `src/core/midi-learn.ts`：

```text
PASS  弯音：中心 8192 → 0
PASS  弯音：上限 16383 → 约 +1
PASS  弯音：下限 0 → -1
PASS  弯音：低 7 位参与 14-bit 计算
PASS  触后：通道压力 64 → 约 0.5
PASS  触后：复音压力 100 → 约 0.79
PASS  CC：未被内置占用的控制器转发给 MIDI Learn
PASS  CC：踏板与 CC123 不进入 MIDI Learn
PASS  映射：合成器 cutoff 范围 100–6000 / 鼓机 punch 可用 / 切换音源后不适用返回 null
PASS  映射：轨道效果 volume 0–1 / 未知效果返回 null / 标签取参数名
PASS  映射：合法条目通过校验；CC 越界、负 CC、未知类型、空 key、min/max 反向、非数字范围均被拒绝
PASS  映射：新增/不同 CC 并列/同一目标换 CC 只保留最新/同一 CC 覆盖旧目标/按 CC 查找/删除
PASS  映射：CC 0→下限、127→上限、64→近似中点、越界原始值被夹紧
PASS  持久化：写入后可读回；损坏内容返回空；重复 CC 与坏条目被过滤
PASS  releaseAll：弯音与触后归零

总计 56 项，通过 56 项，失败 0 项
```

DSP 侧数值（`npm run render-test`，同一 `StudioProcessor`）：

```text
音高 弯音 +2 半音: 期望 246.9Hz, 实测 246.9Hz, 偏差 -0.0 cents OK
音高 弯音 -2 半音: 期望 196.0Hz, 实测 196.0Hz, 偏差 0.0 cents OK
触后压力: rms 无触后=0.1118 满触后=0.1369 比值=1.22 OK
```

测试方式：合成器只起一个持续音，排入 `bend` 事件后测其主导频率；触后用例比较同一音符在 `pressure=0` 与 `pressure=1` 时 0.15–1.0 s 的 RMS。

浏览器（生产构建 4173）：

| 测试 | 结果 |
| --- | --- |
| 检查器「MIDI 映射」分区 | PASS：选中轨道后出现分区、提示文案与 15 个参数/效果 `L` 按钮 |
| 空态 | PASS：无映射时显示「尚无 CC 映射。」 |
| 按钮可点击性 | PASS：`#inspector` 为独立滚动面板（可视高 252 px），滚动到 `L` 按钮后 `elementFromPoint` 命中 `BUTTON.midi-learn`（rect y=210，`scrollTop=227`） |
| 学习态点击 | 未实测：续接会话中浏览器操作工具不可用（见 §9） |

说明：`elementFromPoint` 证实按钮未被调音台等相邻区域遮挡；但「点击 L → 学习行高亮 → 移动控制器 → 建立映射」的端到端点击路径未在本次会话完成。映射建立、范围换算、CRUD 与 localStorage 持久化由上述 56 项 Node 测试覆盖，UI 点击需人工确认一次。

---

## 8. v0.5.0 WAV 音频导入与音频轨

### 8.1 WAV 解码与素材编解码

命令：

```powershell
node tools/audio-asset-tests.mjs
```

测试自带最小 WAV 构造函数（可指定位深、浮点格式、声道、`WAVE_FORMAT_EXTENSIBLE`），直接调用 `src/core/wav.ts` 与 `src/core/audio-asset.ts`：

```text
PASS  decodeWav 16-bit / 24-bit / 32-bit PCM / 8-bit PCM / float32 / float64
PASS  decodeWav 立体声分声道 / WAVE_FORMAT_EXTENSIBLE
PASS  decodeWav 拒绝非 WAV / 拒绝 20 位 WAV / 拒绝 64 位整数 WAV
PASS  encodeWav → decodeWav 往返 — maxErr=5.16e-5
PASS  PCM16 单声道/满幅往返；长数据分块 base64（37,336 字符）；长数据往返 maxErr=3.34e-5
PASS  createAudioAsset 声道与时长 / PCM 与峰值 / 峰值 bin 数 100 / 峰值范围
PASS  createAudioAsset id 确定性 — a_aydx3p_1as40pn1gpo4kly10
PASS  createAudioAsset 名称改变 id
PASS  createAudioAsset 同名同长不同内容改变 id — a_aydx3p_18z9rr3dsodzy10
PASS  createAudioAsset 重导入同内容可重连
PASS  adopt 新素材 mode=new 并入表
PASS  adopt 同内容再导入 mode=existing 不重复
PASS  adopt 缺 PCM 同 id mode=restore 且补回数据
PASS  adopt 旧 id 缺 PCM mode=rebind 沿用旧 id — a_legacy_123
PASS  adopt 文件名不同不绑回
PASS  peaksFromChannels 静音为 0 / 取绝对值
PASS  sanitize 保留合法素材；拒绝缺 id / 低采样率 / 超长 / 零时长 / 非对象；声道收敛 1/2；峰值裁剪；允许缺 data
PASS  stripAssetData 去掉 PCM / 保留峰值 / 保留元数据；assetById 查找与空表
54/54 通过
```

说明：`createAudioAsset` 的 id 由「文件名 + 采样率 + 声道 + PCM 内容指纹」共同决定，因此同名同长度的两个不同文件不会拿到同一个 id，而自动保存剥离 PCM 后重新导入同一个文件仍能自动重连（缺失素材的启动提示见 [progress.md](progress.md) §5 第 5 条）。

### 8.2 音频轨 DSP

命令：

```powershell
node tools/audio-track-tests.mjs
```

直接实例化与浏览器 Worklet 相同的 `StudioProcessor`（48 kHz），通过 `asset` / `audio` / `track` / `resetSource` / `panic` 消息驱动，逐块 `processBlock` 后测量输出：

```text
PASS  音频片段发声 — rms=0.1972
PASS  单声道素材左右相同 / 峰值受主总线限制 waveform peak=0.290 / 输出无 NaN
PASS  片段增益 0.5 — ratio=0.504
PASS  片段源偏移 — rms=0.2070
PASS  片段终点截断 — after=0.00000；截断前有声 0.2069
PASS  素材播完即停 — rms=0.00005
PASS  缺失素材静默跳过 — rms=0.00e+0
PASS  立体声素材保持左右相位 — maxDiff=0.0000
PASS  音频轨声像左移 — L=0.2864 R=0.0000
PASS  音频轨音量跟随轨道音量 — 0.1052 < 0.2069
PASS  resetSource 淡出音频 — rms=0.00001；释放后无声部
PASS  panic 立即清零音频 — rms=4.78e-4（总线 DC 阻断器的残余衰减）
PASS  panic 清空音频声部
PASS  静音音频轨不出声 — rms=0.00e+0
PASS  44.1k 素材重采样到 48k — 零交叉 149（期望约 150）
PASS  重采样后电平正常 — rms=0.2066
PASS  多段音频独立排程 — first=0.207 gap=0.000 second=0.207
21/21 通过
```

测试构造中把 `sendReverb` / `sendDelay` 直接设为最终值并绕过参数平滑，否则混响尾音会污染「终点后静音」「panic 清零」等判定。

### 8.3 浏览器导入闭环（开发服务器 127.0.0.1:5173）

通过浏览器自动化把本地 WAV（`docs/audio/p4-wav-clip.wav`，2.40 s / 48 kHz）写入隐藏的文件输入 `#file-audio`：

| 测试 | 结果 |
| --- | --- |
| 页面加载 | PASS：时间轴、轨道、素材库正常渲染（4 轨 · 2 片段 · 100 BPM） |
| WAV 导入 | PASS：调音台新增第 4 轨「音频 1」，类型标签「音频」；状态栏「已导入音频「p4-wav-clip.wav」 · 2.40 秒」 |
| 时间轴片段 | PASS：轨道数变为 4、片段数 2，音频片段出现在 4.00 拍 |
| 检查器「音频素材」 | PASS：`p4-wav-clip.wav 2.40 秒 · 48000 Hz · 立体声` |
| 检查器「音频片段」 | PASS：`起点 4.00 拍 · 长度 4.00 拍`，含片段增益与素材起点控件 |
| 播放/停止 | PASS：播放后位置 `1.1 → 2.1`、状态栏「播放中 · 音频时钟驱动」；停止后「已停止」 |
| 导出 WAV | PASS：「已导出 WAV：6.40 秒 · 48000 Hz · 16-bit」（8 拍工程 + 1.6 s 尾音） |
| 控制台 | PASS：`Console messages: (none)` |

说明：本次截图工具不可用，证据来自可访问性快照与状态栏文本；波形的逐像素外观、音频片段的拖动/复制手感与导出后实际听感仍需人工确认（见 §9）。

### 8.4 自动保存 → 刷新 → 重新导入的重连闭环

自动保存会剥离 PCM（`stripAssetData`），刷新后素材表只剩元数据。用 `docs/audio/p4-wav-clip.wav` 实测该闭环：

| 步骤 | 状态栏 | 片段数（`clips.length`） |
| --- | --- | --- |
| 刷新后 | 「已恢复自动保存；1 个音频素材缺少 PCM，请重新导入对应 WAV 后播放」 | 6 |
| 再次导入同一 WAV | 「已恢复音频素材「p4-wav-clip.wav」 · 2.40 秒」 | 6（不变） |
| 检查器 | 无「缺少 PCM」，显示 `p4-wav-clip.wav 2.40 秒 · 48000 Hz · 立体声` | — |
| 控制台 | `Console messages: (none)` | — |

期间修复了一处真实缺陷：导入用的隐藏输入 `#file-audio` 在部分注入路径下会连派两次 `change`，第一次走 `restore` 补回 PCM，第二次看到素材已有数据便判为 `existing` 并**多摆一个片段**。修复为两道守卫——`importingWav` 串行化重入，以及「同一素材 id 在 2 秒内再次导入直接忽略」。修复前实测片段数 +1 且状态栏显示「已导入音频」，修复后片段数不变并显示「已恢复音频素材」。

---

## 9. v0.6.0 桌面 EXE

### 9.1 打包

命令与输出：

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
node electron/package.mjs
```

```text
Packaging app for platform win32 x64 using electron v45.2.1
packager 失败（EPERM），改用本地运行时手工拼装
已生成 E:\Users\VICTUS\Documents\ChatGPT\编曲软件\release\SoundWeave-win32-x64
可执行文件：...\SoundWeave.exe（238.2 MB）
```

产物：`SoundWeave.exe` 249,788,928 字节，整个目录 356.9 MB，`resources/app.asar` 253,494 字节（只含 `dist/`、`electron/main.cjs`、`package.json`）。

说明：本机环境中 `@electron/packager` 在 `initialize()` 里把刚解压的 Electron 模板目录 rename 到 staging 目录时被系统拒绝（`EPERM: operation not permitted, rename ...`）。实测同一目录下的文件与子目录都能正常 rename，只有模板顶层目录不行，判定为杀毒/索引器持有目录句柄；换到项目同盘临时目录、关闭沙箱后重试仍复现。`electron/package.mjs` 因此加入兜底：packager 失败时直接用 `node_modules/electron/dist` 复制运行时、用 `@electron/asar` 生成 `app.asar`、把 `electron.exe` 改名为 `SoundWeave.exe`，产物结构与 packager 一致（该路径下 EXE 无自定义版本信息）。

### 9.2 EXE 自检（`npm run exe:smoke`）

```text
PASS  EXE 正常退出 — exit=0
PASS  页面已加载（时间轴信息） — 3 轨 · 0 片段 · 100 BPM
PASS  音频引擎运行 — 48 kHz · 运行中 · AudioWorklet
PASS  播放推进 — position=1.3
PASS  导出成功提示 — 已导出 WAV：4.00 秒 · 48000 Hz · 16-bit
PASS  控制台无警告/错误
PASS  生成了 WAV 文件 — 未命名工程.wav
PASS  WAV 头合法（RIFF/WAVE · 48 kHz · 16-bit · 时长 > 0） — 2ch 48000Hz 16bit 4.00s

总计 8 项，通过 8 项，失败 0 项
```

自检结果 JSON（`work/exe-smoke/result.json`，节选）：

```json
{
  "ok": true,
  "status": "已导出 WAV：4.00 秒 · 48000 Hz · 16-bit",
  "beforeExport": "已停止",
  "info": "3 轨 · 0 片段 · 100 BPM",
  "engine": "48 kHz · 运行中 · AudioWorklet",
  "position": "1.3",
  "midi": "MIDI 未连接",
  "logs": []
}
```

WAV 文件 `work/exe-smoke/未命名工程.wav` 768,044 字节，头信息 `RIFF/WAVE`、2 声道、48000 Hz、16-bit、data 768,000 字节（4.00 s）。

自检流程：EXE 以 `--smoke-out <file>` 启动 → 页面 load 完成后点「▶」→ 1.8 s 后点「■」→ 点「导出 WAV」→ 每 0.8 s 读取状态栏共 10 次 → 写 JSON 并 `app.exit(0/1)`；导出目标目录由 `SOUNDWEAVE_SMOKE_SAVE` 指定，绕过系统「另存为」对话框。

### 9.3 正常启动（无参数）

```
PID=24848 Responding=True Title=SoundWeave 声织 · 音色编曲工作站
已正常退出
```

双击运行后进程响应正常、窗口标题正确，关闭主窗口后进程退出（未残留后台进程）。

### 9.4 Electron 宿主与 CSP

- `npx electron . --smoke-out`（开发态直接跑主进程）同样输出上述自检 JSON：`{"ok":true,...,"logs":[]}`，证明自定义 `app://` 协议能正确加载 Vite 构建产物、AudioWorklet 可启动。
- `index.html` 加入 CSP meta 后重新验证：引擎仍为 `48 kHz · 运行中 · AudioWorklet`，控制台无 Insecure-CSP 警告。
- 早期用默认沙箱参数直接 `npx electron .` 曾出现 `0xC0000005` 访问冲突，加 `--no-sandbox` 可复现为环境限制；打包后的 EXE 用默认参数启动正常，生产配置保持 `sandbox: true` 未放宽。

---

## 10. v0.7.0 回溯录制 / 五线谱 / 和弦建议

### 10.1 纯函数回归（Node，无浏览器）

```powershell
node tools/retro-tests.mjs
node tools/notation-tests.mjs
node tools/scales-tests.mjs
```

```text
总计 9 项，通过 9 项，失败 0 项
总计 9 项，通过 9 项，失败 0 项
总计 18 项，通过 18 项，失败 0 项
```

三个脚本都用 `esbuild` 打包 TS → base64 data URL → `import()` 的方式在 Node 里直接跑源码，覆盖：

- `retro-tests`：`pushRetro` 追加与 64 上限滚动、超短音符时长钳到 0.0625、`retroToNotes` 的绝对拍→片段内相对拍换算、起始拍吸附到 snap、时长 1/16 取整、片段外丢弃、尾部越界裁剪、`clip.offset` 非零时的偏移。
- `notation-tests`：`spellPitch` 对中央 C / 相邻黑白键 / 八度边界 / 高音区 的 `letter`、`alter`、`octave`、`step` 与音名文本；`alterMark` 的 ♯/♭/重升重降；谱表 step 单调性。
- `scales-tests`：7 种音阶的音程合法性、各级七和弦音集合、`chordQuality` 后缀（`maj7`/`m7`/`7`/`m7♭5`/`dim7`/`m(maj7)`）、`numeralFor` 大小写与 `°`、`spellScaleRoot` 按级数字母序的升降根音（B♭/E♭ 而非 A♯/D♯）、`suggestChord` 命中数评分与平手取低级别、空候选/空输入返回 `null`。

### 10.2 类型检查与生产构建

`npm run build`（`tsc --noEmit && vite build`）通过：

```text
dist/index.html                  9.70 kB │ gzip:  3.00 kB
dist/assets/index-*.css         27.17 kB │ gzip:  6.34 kB
dist/assets/index-*.js         279.60 kB │ gzip: 86.73 kB
✓ 52 modules transformed
```

### 10.3 全量回归

除新增三个脚本外，既有 17 个脚本同时跑过一遍，全部 `exit=0`：

| 脚本 | 结果 | 脚本 | 结果 |
| --- | --- | --- | --- |
| `transport-tests` | 15/15 | `ambient-tests` | 35/35 |
| `edit-tests` | 28/28 | `ambient-analysis-tests` | 35/35 |
| `sound-tests` | 34/34 | `ambient-render-tests` | 13/13 |
| `midi-tests` | 56/56 | `ambient-fitting-tests` | 25/25 |
| `preset-tests` | 41/41 | `ambient-integration-tests` | 4/4 |
| `block-tests` | 58/58 | `ambient-preference-tests` | 26/26 |
| `render-test` | PASS | `ambient-radio-tests` | 22/22 |
| `audio-asset-tests` | 54/54 | `audio-track-tests` | 21/21 |

新增三个脚本合计 **36/36**，全量 **0 失败**。

### 10.4 布局修正

实现和弦条时 `index.html` 的中央区多了一个子元素，但 `src/style.css` 的 `.center` 仍是 4 行网格（`30px minmax(0,1fr) 30px 306px`），导致 `chord-bar` 吃到 306 px、编辑区被压成自适应行。修正为 5 行：

```css
.center { grid-template-rows: 30px minmax(0, 1fr) 30px 38px 306px; }
```

38 px = 和弦条上下 6 px padding + 26 px 控件高度。修正后重新构建通过。

---

## 11. v0.7.1 音频长会话自愈 / EXE 重打包

### 11.1 缺陷复现（修复前）

用 `work/nan-probe.mjs`（临时探针，未入库）向 `src/audio/studio-processor.js` 直接喂事件，三条路径在修复前都让输出 **永久静默**（后续合法音符 `peak = 0`）：

| 注入 | 修复前观察值 | 修复后 |
| --- | --- | --- |
| `when: NaN` 的事件排在队首 | 事件队列不再消化（队列长度恒为 2），之后所有音符静音 | 该事件被丢弃，队列继续消化，后续音符 `peak = 0.62` |
| NaN 力度声部 | `track.lpL = NaN`、总线 `dcL = NaN`、`delay.lpL = NaN`，整曲永久静音 | 逐样本兜底，状态均为有限值，`peak = 0.61` |
| `params: { cutoff: NaN, resonance: undefined }` | 平滑目标为 `NaN/undefined`，参数永久失效 | 非有限参数被过滤，后续合法参数生效，`peak = 0.57` |

这三条正是「界面显示在播但没有声音」的成因：Worklet 不报错、电平表仍按旧值或 0 显示，但总线状态已被非有限值污染。

### 11.2 新增回归（Node，无浏览器）

```powershell
node tools/audio-recovery-tests.mjs
```

```text
总计 19 项，通过 19 项，失败 0 项
```

脚本先注入 `globalThis.AudioWorkletProcessor` / `sampleRate` / `registerProcessor` 再 `import()` 真实的 Worklet 源文件（与浏览器、离线导出共用同一份 DSP），覆盖：坏时间戳不堵队列、NaN 力度不污染滤波器、NaN 参数被丢弃但后续合法参数生效、总线 NaN 触发 `resetMasterState()`、`recover()` 清空事件与声部、事件队列上限 8192、处理器抛异常时捕获并上报且继续发声、20 秒长会话输出稳定且声部数量受控。

首跑有 1 项失败，原因是断言写死了 synth 预设并不存在的 `index` 参数（属 ep 预设），改为只断言 `cutoff`/`resonance` 有限且不含 `index` 后 19/19 通过——不是产品缺陷。

### 11.3 全量回归

```text
transport-tests 15/15   retro-tests 9/9    notation-tests 9/9    scales-tests 18/18
ambient-tests 35/35     ambient-integration-tests 4/4   audio-recovery-tests 19/19
render-test：440 Hz 实测偏差 -0.0 cents；渲染长度正确、非静音、无非法数值、峰值未超过 1
```

`npm run build`（`tsc --noEmit && vite build`）通过：`index.html` 9.70 kB、CSS 27.17 kB、JS 288.16 kB（gzip 89.70 kB）、52 modules。

### 11.4 EXE 确认为旧版 → 重新打包

用户反馈「EXE 里找不到 ambient 子系统与五线谱」。解包旧 `app.asar` 对照：

| 项 | 旧 asar（2026-11-01 01:03） | 新构建 `dist/` |
| --- | --- | --- |
| `index.html` | 5,101 字节 | 9,700 字节 |
| JS | 216,923 字节 | 288,158 字节 |
| 检索「回溯 / 五线谱 / 和弦建议 / 氛围」 | **0 命中** | 11 命中 |

确认旧 EXE 是用旧 `dist/` 打的。执行 `node electron/package.mjs`（packager 仍因 EPERM 回退到本地运行时 + asar 手工拼装），产物 `release/SoundWeave-win32-x64/SoundWeave.exe`（238.2 MB）。再次解包新 asar：`index.html` 9,700 字节、`index-DRKtrkAM.js` 288,158 字节、`index-tPl2tgsR.css` 27,165 字节；「五线谱 / 回溯 / 和弦建议 / 氛围 / ambient」在 `index.html` 命中 6 处、在 JS 命中 41 处，且 JS 内含「稀疏雾霭」ambient 预设 → EXE 已带上新功能。

### 11.5 EXE 自检与「偶发失败」的根因

`npm run exe:smoke` 一度出现 4 项失败：`position=1.1`（未推进）、状态栏不是「已导出 WAV」而是「已生成「稀疏雾霭 Sparse Fog」…」、控制台有 `ResizeObserver loop` 报错、未生成 WAV。

根因不是产品缺陷，而是**自检环境不封闭**：

1. EXE 读的是用户真实 `userData` 里的自动保存 —— 该工程是 300 秒的 ambient 工程（3 轨 / 21 片段 / 58–70 BPM），离线渲染远超自检 8 秒采样窗口，所以状态一直停在「正在离线渲染」，退出时 WAV 还没落盘；
2. 自检窗口是**可见**的，桌面上的真实鼠标操作会点到窗口（出现过「已生成「稀疏雾霭」」「移动片段」这类只有手动点击才会产生的状态文本）。

修复（`electron/main.cjs`）：`--smoke-out` 启动时 `app.setPath('userData', <out 同目录>/userdata)` 使用独立配置目录，并且不调用 `win.show()`。修复后同一命令稳定 8/8：

```text
PASS  EXE 正常退出 — exit=0
PASS  页面已加载（时间轴信息） — 3 轨 · 0 片段 · 100 BPM
PASS  音频引擎运行 — 48 kHz · 运行中 · AudioWorklet
PASS  播放推进 — position=1.3
PASS  导出成功提示 — 已导出 WAV：4.00 秒 · 48000 Hz · 16-bit
PASS  控制台无警告/错误
PASS  生成了 WAV 文件 — 未命名工程.wav
PASS  WAV 头合法（RIFF/WAVE · 48 kHz · 16-bit · 时长 > 0） — 2ch 48000Hz 16bit 4.00s
```

---

## 12. 未执行 / 不能声称的验证

- 未逐个人耳试听 64 个预设与 3 首示例工程；音质、乐器自然度、混音平衡**未验收**。v0.2.1 的新鼓组、钢琴非谐泛音、EP 双调制、吉他环路阻尼与总线混响尤其需要人耳判断。
- 未对调音台竖向推子、PAN/REV 小滑杆、M/S、电平表做自动化拖动交互验证。
- 未通过像素截图验证 v0.2.1 新视觉（截图工具不可用，仅有布局矩形与可访问性快照）。
- v0.3.0 的预设试听与 A/B 对比只验证了**状态栏提示、预设切换与引擎运行状态**；实际听到的两段音频差异（A/B 是否真的不同、试听是否覆盖完整起音）未做音频采集比对，需人工试听。
- v0.3.0 的钢琴卷帘框选拖拽、自动化曲线画布的单击绘制/拖点/右键删除未通过浏览器桥验证（canvas 指针注入受限）；仅纯函数层有 28 项回归。
- 未在 Firefox、Safari、移动端浏览器验证。
- EXE 相关未验证项：未在干净机器上验证首次启动（SmartScreen 提示、缺少 VC 运行库等）；未人工点击系统「另存为」对话框（自检用环境变量指定目录绕过，见 §9.2）；未验证用户取消保存的路径；未做代码签名与安装包（仅免安装便携版）；回退打包路径下 EXE 无自定义版本信息；未在 macOS / Linux 打包。
- 未验证超大工程（长时间轴、上千音符、15 轨满载）的性能与内存。
- 未验证 WAV 音频导入的波形像素外观（截图工具不可用，仅有快照与状态栏证据；导入流程与检查器分区已实测）。
- 未在浏览器中实测音频片段的拖动/复制/裁切交互与导出 WAV 后的听感；DSP 与离线导出路径由 §2、§8.2 的自动化测试覆盖。
- 未验证自动保存→刷新→重新导入的**真实文件对话框**路径（§8.4 用注入 `change` 实测，含重复派发防护；系统文件选择路径未点击）。
- 未验证 20 位/64 位整数/压缩 WAV 的拒绝提示在 UI 中的显示。
- 未验证自定义音色导入按钮的系统文件选择路径（JSON 解析与导出内容已由 41 项 Node 测试往返覆盖）。
- 未验证编曲块导入按钮的系统文件选择路径（JSON 解析与导出内容已由 58 项 Node 测试往返覆盖）。
- 未验证 MIDI 实体设备：权限、枚举、热插拔与真实按键/踏板/弯音/触后/CC 端到端（输入解析与映射逻辑由 56 项 Node 测试覆盖）。
- 未完成 MIDI Learn 的端到端 UI 点击验证：续接会话中浏览器操作工具不可用，只验证了分区渲染、15 个 `L` 按钮存在、空态与按钮 hit-test；「点击 L → 学习行高亮 → 收到 CC → 建立映射」需人工确认一次。
- v0.7.0 三项新功能**只做了纯函数回归与构建验证**，未做浏览器端到端点击：没验证「演奏 → 点回溯 → 音符出现在片段」、卷帘/五线谱切换后的实际排版与升降号位置、和弦条在 12 个调 × 7 种音阶下的拼写外观、播放时高亮是否与耳朵听到的和声一致。这些需要在浏览器里人工点一遍（见 §10.4 的布局修正背景）。
- 未验证五线谱在高密度片段（同一拍内多个音、跨八度大跳）下的符头重叠情况；未验证和弦条在窄窗口（< 1100 px）下的横向滚动表现。
- 未验证五线谱/和弦条在 Electron EXE 中的显示（EXE 构建复用同一 `dist/`，理论上一致，但未单独跑自检）。
