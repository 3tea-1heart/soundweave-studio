# 采样音源来源与授权

本项目 v0.7.2 起为钢琴、钢弦吉他、电贝斯与原声鼓组引入**真实录音采样**。所有采样均可再分发，授权与出处逐项列在下方，并由 `src/samples/manifest.json` 逐条记录。

## 1. 采样库

| 库 id | 乐器 | 素材 | 授权 | 来源 |
| --- | --- | --- | --- | --- |
| `piano-kw` | 立式钢琴（Kawai） | 31 个音高 × 强弱 2 层，共 63 个采样，含延音循环点 | **CC0 1.0**（公有领域） | FreePats · [Upright Piano KW 2022-02-21](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) |
| `guitar-fss` | 钢弦民谣吉他 | 逐半音采样，中/强两层，共 59 个采样 | **GPLv3 + FreePats 采样例外** | FreePats · [FSS Steel-String Acoustic Guitar 2020-05-21](https://freepats.zenvoid.org/Guitar/steel-acoustic-guitar.html)（FlameStudios 录制） |
| `bass-yr` | 指弹电贝斯（Yamaha RBX） | 12 个音高（逐半音） | **CC0 1.0** | FreePats · [Finger Bass YR 2019-09-30](https://freepats.zenvoid.org/ElectricGuitar/clean-electric-bass.html)（Andrea Biasior 录制） |
| `drums-muldjord` | 原声套鼓 | 底鼓 / 军鼓 / 通鼓 ×2 / 闭&开踩镲 / 镲片，3 个力度层，共 21 个采样 | **CC BY 4.0** | FreePats · [MuldjordKit 2020-10-18](https://freepats.zenvoid.org/Percussion/acoustic-drum-kit.html)（Lars Muldjord 录制） |

> FreePats 的 GPL“采样例外”明确允许把这些采样用于任意项目（含非 GPL 项目）。CC BY 4.0 要求署名，本项目在此处署名并保留原始下载链接。

## 2. 处理方式（可复现）

原始包与最终文件之间存在以下修改，均由 [tools/sample-build.py](../tools/sample-build.py) 脚本完成：

1. 解析 SFZ 的 region / group 继承，取出每个采样的根音、力度层、循环点；
2. 重采样到 48 kHz（`scipy.signal.resample_poly`），单声道、16-bit PCM；
3. 有循环点的采样（钢琴）截到 `loop_end + 1.2 s`，无循环的截到 4.2 s 并在末尾 80 ms 淡出；
4. 峰值过低的采样提升到 0.55，超过 0.92 的压到 0.9（避免刺耳与削波）；
5. 生成 `src/samples/manifest.json`（根音 / 力度范围 / 循环点）。

重新生成：

```powershell
# 1) 下载原始包到 assets/raw/（该目录不入库）
# 2) 解压到 assets/raw/extracted/
uv run --with soundfile --with numpy --with scipy python tools/sample-build.py
```

最终文件在 `public/samples/<bank>/`，随 `npm run build` 复制进 `dist/`，Web 版与 EXE 都从这里读取。

## 3. 已知取舍

- 单声道：失去原始录音的立体声像，由轨道声像与总线混响补回空间感。
- 无 release 采样：松键使用 140 ms 包络淡出，不是真正的“离键录音”。
- 钢琴与吉他只保留 2 个力度层（原始包为 2–3 层），极弱/极强力度的过渡略硬。
- 鼓组只有底鼓、军鼓、通鼓、踩镲与镲片是采样；拍手、沙锤、打击垫（`perc`）仍由合成器发声。
- 采样音域：钢琴约 C1–C7，吉他 E2–E5，贝斯 D1–D4；超出范围时自动回退到同类型合成音源，不会静音。
