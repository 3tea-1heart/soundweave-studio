# P0 架构与技术决策

日期：2026-10-31
状态：已定稿，后续实现以此为准（变更需在本文件记录原因）。

## 1. 交付形态：网站优先（路线 A），保留桌面化空间

- 选择 **Web 应用**作为首个可靠交付形态：Vite + TypeScript，纯浏览器运行，构建产物为静态文件，可用任意静态服务器托管（含本地 `npm run preview`）。
- 原因：无需安装、启动快、`AudioWorklet` 可提供真实低延迟实时 DSP、`OfflineAudioContext` 可用同一份 DSP 代码完成真实离线渲染（导出与所听一致），且便于自动化验证。
- 不采用：C++/JUCE 原生路线（构建链与迭代成本过高、当前环境无 JUCE 工具链）；Electron/Tauri 桌面壳首版不做——桌面壳不改善音频引擎，还引入包体与授权维护成本。后续若需要 EXE，可用 Tauri/Electron 包裹同一 Web 构建，无需改 DSP。
- 网页需要用户手势解锁音频、HTTPS（Web MIDI 需要安全上下文）。本地 `localhost` 视为安全上下文。

## 2. 音频引擎：单一 AudioWorklet 承载整个“工作室”

核心决策：**所有轨道、音源、插入效果、发送效果、总线与限幅都放在一个 AudioWorkletProcessor（`studio-processor`）里**。

原因：

1. 实时演奏、离线导出、Node 自动化测试共用同一份 DSP 源码（`src/audio/studio-processor.js`），不存在“导出用另一套简化引擎”的风险。
2. 参数、音符事件通过 `MessagePort` 进入音频线程，事件带绝对音频时间，音频线程内按采样帧对齐，UI 动画不参与发声计时。
3. 导出时用 `OfflineAudioContext` + 同一个 processor，逐事件预排，天然包含效果尾音与自动化。

边界：

- 音频线程不做文件、网络、DOM、大型分配。
- 主线程只负责：工程数据、编辑、调度（提前 0.15s 投递事件）、UI 渲染、导出编码。
- 音乐时间是 **拍（beat）**；主线程用 tempo map 映射为音频秒；绝不使用像素或动画帧。
- 所有 `AudioWorklet` 通话通过 `postMessage`，无 SharedArrayBuffer（避免跨源隔离要求）。

## 3. 音源策略：合成 + 物理建模，不打包来源不明的采样

| 音源 | 实现 | 说明 |
| --- | --- | --- |
| 电钢琴 `ep` | 2-op FM（body + tine 层）+ 击键瞬态 | 力度驱动 FM index、音头亮度、释音 |
| 钢琴 `piano` | 加法合成（6 个带轻微非谐分音）+ 力度亮度 | 作为常规编曲支撑，不等同采样钢琴 |
| 钢弦吉他 `guitar` | Karplus-Strong 物理建模（分数延迟 + 环路阻尼 + 拨弦激励） | 无采样授权问题；按弦序做微小起音/音高差；支持闷音奏法 |
| 合成器 `synth` | 双振荡器 polyBLEP 锯齿/方波 + 子振荡 + TPT 状态变量滤波器 + LFO | 防混叠、滤波器稳定 |
| 贝斯 `bass` | 同 synth 引擎，不同参数与音域映射 | 低频清晰度优先 |
| 鼓 `drum` | 合成鼓：kick/snare/hat/clap/tom/shaker/crash | 踩镲互斥、力度、确定性噪声 |

不使用第三方采样库。所有声音均由代码合成，避免素材授权风险；`docs/verification.md` 会如实记录“物理建模/合成，非采样”。

## 4. 工程数据与模块划分

```
src/core/project.ts     工程 schema（v1）、默认工程、深拷贝/迁移
src/core/tempo.ts       拍 <-> tick <-> 音频秒
src/core/scheduler.ts   实时调度（lookahead）与离线事件收集
src/core/audio-engine.ts 实时/离线图构建，事件投递
src/core/history.ts     快照式撤销/重做命令栈
src/core/midi.ts        MIDI 文件读写（SMF 0/1）
src/core/presets.ts     预设 schema + 内置预设库
src/core/blocks.ts      编曲块 schema + 内置块库
src/core/demos.ts       示例工程
src/core/retro.ts       回溯录制：滚动缓冲与写回当前片段（v0.7.0）
src/core/notation.ts    五线谱记谱换算：MIDI 音高 → 音名/升降/谱表步进（v0.7.0）
src/core/scales.ts      音阶、自然七和弦拼写与实时和弦建议（v0.7.0）
src/audio/studio-processor.js  DSP（无 TS，供 Worklet/Node 共用）
src/audio/wav.ts        WAV 编码（float32 -> 16/24bit PCM）
src/ui/*.ts             视图（时间轴、卷帘、混音器、浏览器、键盘、检查器）
tools/render-test.mjs   Node 端 DSP 渲染 + WAV 数值校验
```

工程 schema 关键点：

- `Project { version, name, tempo, timeSig, loop, tracks[], clips[], automation[], master }`
- `Track { id, name, color, instrument(presetId/type/params), mixer(volume/pan/mute/solo), fx(sendReverb/sendDelay/drive/chorus), automation }`
- `Clip { id, trackId, startBeat, lengthBeats, offsetBeat, transpose, notes[] }`；`Note { id, pitch, startBeat(相对片段), lengthBeats, velocity, articulation }`
- 自动化为 `{paramId, points:[{beat, value}]}`，paramId 稳定（`track.volume`、`track.cutoff`、`track.sendReverb`、`master.volume`）。
- 工程保存为 `.swproj.json`；素材全部内嵌，无外部依赖/缺失风险（后续采样包再引入素材台账）。

## 5. 调度与导出

- 实时：`setInterval(25ms)` + lookahead 150ms，把 [当前位置, +150ms] 内的音符转成 `{when, dur}` 投递；循环时按循环边界裁剪音符尾部；停止/跳转/切换预设时发送 `allNotesOff`。
- 事件时间四舍五入到 128 采样块边界（<3ms 量化误差），并记录为已知限制。
- 离线：`OfflineAudioContext(2, sampleRate*duration, sampleRate)`，时长 = 工程长度 + 效果尾音（2s），逐片段投递事件后用 `startRendering()`，WAV 由 `wav.ts` 编码。
- 分轨导出：同一图构建，仅启用目标轨，其余静音。
- 导出后自动解码校验（`decodeAudioData`）与数值检查（长度/非静音/有限值/削波）。

## 6. 依赖与版本

- Node 24.14.1 / npm 11.11.0（本机）
- Vite 7（构建与开发服务器）、TypeScript 5.9（类型检查）
- 运行时零第三方 UI/音频库：Canvas + Web Audio 原生 API。
- 锁文件 `package-lock.json` 随仓库提交。

## 7. 目标测试环境与基线

- 音源/导出：Node 24 离线渲染（48 kHz）跑数值与听感样本。
- 浏览器：Chrome/Edge 最新版（Windows 11），Web Audio + AudioWorklet + OfflineAudioContext。
- Web MIDI 为可选增强：不可用时保留电脑键盘与屏幕键盘。
- 性能基线：8 轨、常用效果、可视化同时运行；以实际 FPS/CPU 观测记录，不承诺“零延迟”。

## 8. 风险与已知限制

1. 合成/物理建模音色的写实度低于商业采样库；不做“写实”宣传，方向为“可用且有个性的音色”。
2. AudioWorklet 消息在极端 CPU 负载下可能延迟；声部上限与抢占策略需实测。
3. 浏览器首次发声需用户手势解锁；后台标签页可能被节流，调度器需处理恢复。
4. 本地持久化受浏览器配额限制；同时提供工程文件导出/导入作为兜底。
5. 不做第三方插件宿主；五线谱只提供只读显示视图（v0.7.0），不做可编辑记谱器与 MusicXML（P5 范围）。
6. 无法由 Agent 完成主观听感验收的部分，明确标注“待试听”。
