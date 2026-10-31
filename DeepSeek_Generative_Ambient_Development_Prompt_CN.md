# DeepSeek 开发提示词：Generative Ambient 模块

> 用途：直接复制给 DeepSeek / DeepSeek Coder，在现有音乐宿主仓库中开发生成式 Ambient 子系统。
> 原则：先读仓库、适配现有架构、分阶段实现，不另造独立 DAW。

你现在要在一个已经存在的音乐宿主/DAW 类软件中，开发“Generative Ambient”子系统。不要另写一个独立 DAW，也不要重构与本任务无关的部分。第一步必须阅读仓库并确认现有架构，再制定最小侵入式集成方案。

【产品目标】
1. 用户可以导入 1–10 首 WAV/FLAC/MP3 作为小样本参考。系统本地分析后生成一个可编辑 StylePreset。
2. 软件自带多种非艺术家命名的 Ambient 风格预设。
3. 用户按 StylePreset 随机生成有限长度作品，或进入 Infinite Radio 模式无限、非短周期地持续生成。
4. 每首作品必须保留可编辑“谱子”：pitched material 生成到宿主的 MIDI/钢琴卷帘轨道，可导出 .mid。
5. 但系统不能局限为 MIDI：必须支持 Performance 层和 Sound/Texture 层，例如 microtiming、CC/MPE、pitch drift、drone、noise、granular texture、sample events、空间/混响/效果器自动化。
6. 最终通过宿主现有音源、插件、混音、总线与导出引擎渲染 WAV/FLAC；可选 stems。
7. 用户可以 Lock/Frozen 某轨或某时间段，再局部 Regenerate。
8. 所有生成都可通过 seed、StylePreset、RuleGraph、GeneratorState 追踪和复现。

【最重要的设计原则】
音乐表示分三层：
A. Composition：NoteEvent、PitchField、RhythmProcess、Agent、RuleGraph、Form/Target curves。
B. Performance：microtiming、velocity envelope、pedal/CC、pitch bend/MPE、articulation、bounded drift。
C. Sound：Instrument/Sampler/Synth、TextureEvent、Drone/Noise、sample selection、FX automation、mix/spatial profile。
MIDI 是 A/B 层的可导出子集，不是最终音乐的唯一表示。

【生成器架构】
实现：
State -> Agents/Rules propose candidates -> Evaluator 计算软能量 -> stochastic Selector -> Scheduler -> Host EventBridge -> state update -> Homeostasis。
不要永远选择最低能量；使用带 temperature 的 softmax/Boltzmann 选择。
Evaluator 至少包含：
- acoustic roughness / harmonicity
- voice-leading cost
- tonal center attraction
- repetition penalty
- density target error
- tension target error
- novelty reward
Homeostasis 维持 density、dissonance、brightness、tonal stability、repetition、novelty、silence ratio 等指标在 StylePreset 目标区间。

Pitch processes MVP：
- weighted pitch field
- bounded random walk
- irrational rotation
- voice-leading walker
Rhythm processes MVP：
- fixed/near-fixed clock
- phase drift
- renewal/Poisson
- Euclidean rhythm
Agent 间允许 coupling，例如密度互补、共同音、call-response、相位/节奏关联。

【StylePreset】
StylePreset 不是固定 pattern，而是：
- 参数分布
- 关系规则
- 软约束
- Invariants / Weak Constraints / Free Dimensions
- structure/pitch/rhythm/interaction/sound/mix/freedom
必须带 schemaVersion，支持序列化、复制、编辑、morph、版本迁移。

【参考学习】
不要训练一个“从音频直接吐音频”的神经网络作为核心。优先实现可解释的小样本路线：
audio -> multi-scale features -> ReferenceProfile -> inverse procedural fitting -> set of acceptable rule/parameter families -> StylePreset。

分析尺度：
- micro 10–500ms：spectral centroid/rolloff、roughness、attack、RMS、spectral flux
- meso 1–30s：onset density、duration、chroma/pitch stability、stereo width、local dynamics
- macro 30s–5min：density drift、tension drift、recurrence、tonal center drift、long-term brightness/loudness
可选做 onset/pitch/beat 的符号估计，但失败不能阻塞参考学习。

拟合不要只保留一个 best parameter set。使用随机搜索/ABC/CMA-ES/进化式黑箱搜索，并建立 Quality-Diversity archive（可用 MAP-Elites 思路），保留不同密度、周期性、和声稳定性、纹理粗糙度区域的多个可接受解释。
1–3 首参考时提高不确定度，不要把单曲偶然特征当成 invariant。
生成后做 reference-similarity guard，检测长旋律/节奏 n-gram 或显著 motif 过近则重生成。

【Infinite Radio】
实现 rolling horizon，不一次生成无限事件。
- 始终提前生成未来 10–60 秒
- 保存 Agent phase、memory、pitch center、homeostasis state、RNG state
- recurrence guard 防短循环
- macro environment 以分钟/小时尺度漂移
- checkpoint/resume
- “Capture Last N Minutes” 将刚才生成的一段固化为普通可编辑工程

【宿主集成】
先扫描仓库找出现有：
Transport/Clock/TempoMap
Track/Clip/MIDI/PianoRoll
Instrument/Sampler/Plugin
Mixer/Bus/Send
Automation
Project serialization
Offline render/export
然后实现 IAmbientHostAdapter 或与现有模式等价的适配层。不得建立第二套互相竞争的 Transport、Mixer 或 Plugin Host。
生成事件插入宿主普通轨道；Texture Track 也必须成为宿主工程对象。
用户手动修改的混音/插件参数允许 Lock，Regenerate 不覆盖。

【线程与性能】
Audio callback 禁止：
- 文件 I/O
- 网络
- 动态分配
- reference analysis
- 复杂搜索
- 锁等待
建议：
- audio thread：现有实时 DSP
- generation worker：滚动生成未来事件
- analysis worker pool：参考音频特征/逆向拟合
- UI：只读 snapshot/message passing
Radio 模式必须有 memory/history 上限。

【输出】
- MIDI：note、tempo、CC、pedal、pitch bend；宿主支持时保留 MPE
- WAV/FLAC：走宿主现有 offline render
- 可选 stems
- 保存 sidecar/project state：seed、StylePreset、RuleGraph、Texture/Automation 等 MIDI 无法表达的信息
- 插件或样本缺失时明确报错，不静默替换

【UI】
Generative 面板至少包含：
1. Reference Lab：拖入参考、分析、显示强共性/弱共性/不确定度、Create Style Preset
2. Style Browser：Builtin / Learned / User
3. Generate：Length/Infinite、Seed、Density、Tension、Brightness、Tonality、Exploration、Humanization
4. Inspector：density/tension/roughness/novelty/pitch center/agent activity
5. 区域操作：Regenerate Region、Variate、Freeze、Lock
6. Radio：Play Infinite、Save Current State、Capture Last N Minutes

【内置预设】
至少 4 个，且算法不同：
- Sparse Fog：低密度 renewal/Poisson + 长静默
- Phase Garden：near-periodic + phase drift
- Still Room：drone + 极慢 pitch/spectral drift
- Pentatonic Weather：weighted pitch field + voice-leading + sparse clocks
可以增加 Tape Estuary / Spectral Weather，但不要把预设只是换乐器。

【开发顺序】
M0：只做仓库勘探和 HostAdapter 设计，列出将复用的现有类/文件。
M1：Procedural Core + MIDI 多轨生成 + deterministic seed + tests。
M2：Performance/Sound/Texture + 宿主音源/FX + WAV/FLAC。
M3：AudioAnalyzer + ReferenceProfile + 手工映射到 StylePreset。
M4：Inverse fitting + Quality Diversity。
M5：Infinite Radio + checkpoint + capture。
M6：可选用户 A/B 偏好适配。

【质量要求】
- 不要创建一个巨型 AmbientGenerator 类。
- 模块边界清晰，算法与 UI/宿主解耦。
- 新增核心类型都写单元测试。
- 固定 seed 应可复现。
- 进行 2 小时 Radio 模拟测试，确保无事件爆炸、内存增长、时间倒退、NaN。
- StylePreset 必须版本化。
- 生成结果必须能解释来源：选中事件能追踪到 Agent/Rule/seed。
- 不要用 placeholder 假装完成音频分析或宿主渲染。
- 如果现有宿主架构与本文命名不同，遵循现有架构，只保持职责边界。

【你第一轮回复必须做什么】
不要立刻大规模写代码。
先：
1. 扫描仓库并总结现有宿主架构。
2. 列出现有可复用类型/模块/文件。
3. 指出本文需求与现有架构的映射。
4. 提出 M0/M1 的具体文件修改清单。
5. 指出风险与未知点，但不要因为一般性未知点停工；能通过代码读取确认的就自行确认。
6. 然后开始实现最小可运行 M1，并在每个阶段运行测试/构建。
