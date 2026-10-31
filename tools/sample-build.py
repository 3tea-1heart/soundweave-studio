"""把下载的乐器采样（SFZ 包）裁剪、重采样、归一化为应用内采样库。

用法：uv run --with soundfile --with numpy --with scipy python tools/sample-build.py

输出：
  public/samples/<bank>/*.wav   48 kHz / 16-bit / 单声道
  src/samples/manifest.json     采样清单（音高、力度层、循环点、授权）

素材来源与授权见 docs/samples.md。
"""

import json
import math
import pathlib
import re
import sys

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / "assets/raw/extracted"
OUT = ROOT / "public/samples"
MANIFEST = ROOT / "src/samples/manifest.json"
TARGET_SR = 48000
MAX_SECONDS = 4.2
FADE_OUT = 0.08


def parse_sfz(path: pathlib.Path):
    """解析 SFZ 的 group/region，返回 region 字典列表（含 group 继承值）。"""
    regions = []
    group = {}
    region = None
    for raw in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw.strip()
        if not line or line.startswith("//"):
            continue
        if line.startswith("<group>"):
            region = None
            group = {}
            continue
        if line.startswith("<region>"):
            if region:
                regions.append({**group, **region})
            region = {}
            continue
        if line.startswith("<") and line.endswith(">"):
            continue
        for token in line.split():
            if "=" not in token:
                continue
            key, val = token.split("=", 1)
            if region is None:
                group[key] = val
            else:
                region[key] = val
    if region:
        regions.append({**group, **region})
    return regions


def load_audio(path: pathlib.Path):
    data, rate = sf.read(path, dtype="float32", always_2d=False)
    if data.ndim > 1:
        data = data.mean(axis=1)
    if rate != TARGET_SR:
        g = math.gcd(TARGET_SR, rate)
        data = resample_poly(data, TARGET_SR // g, rate // g).astype(np.float32)
    return np.ascontiguousarray(data), rate


def normalize(x: np.ndarray) -> np.ndarray:
    peak = float(np.max(np.abs(x))) or 1e-9
    if peak < 0.35:
        x = x * (0.55 / peak)
    elif peak > 0.92:
        x = x * (0.9 / peak)
    return x.astype(np.float32)


def fade_out(x: np.ndarray) -> np.ndarray:
    n = min(len(x), int(FADE_OUT * TARGET_SR))
    if n > 1:
        x[-n:] *= np.linspace(1.0, 0.0, n, dtype=np.float32)
    return x


def build_pitched(bank_id: str, sfz: pathlib.Path, meta: dict, tail: float):
    regions = parse_sfz(sfz)
    base = sfz.parent
    seen = {}
    out = []
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / bank_id).mkdir(exist_ok=True)
    for r in regions:
        if "sample" not in r:
            continue
        src = base / r["sample"].replace("\\", "/")
        if not src.exists():
            print("  ! missing", src)
            continue
        lokey = int(r.get("key", r.get("lokey", 60)))
        hikey = int(r.get("key", r.get("hikey", lokey)))
        center = int(r["pitch_keycenter"]) if "pitch_keycenter" in r else (lokey + hikey) // 2
        lovel = int(r.get("lovel", 0))
        hivel = int(r.get("hivel", 127))
        loop_start = int(r["loop_start"]) if "loop_start" in r else None
        loop_end = int(r["loop_end"]) if "loop_end" in r else None
        key = (src.name, center, lovel, hivel, loop_start, loop_end)
        if key in seen:
            continue
        audio, src_rate = load_audio(src)
        src_frames_to_sec = 1.0 / TARGET_SR  # 已重采样到目标采样率
        end_frame = len(audio)
        if loop_end is not None:
            # 循环点按原速率的帧数给出，重采样后按相同比例换算
            ratio = TARGET_SR / src_rate
            loop_s = loop_start * ratio
            loop_e = loop_end * ratio
            end_frame = min(len(audio), int(loop_e + tail * TARGET_SR))
            audio = fade_out(audio[:end_frame])
        else:
            end_frame = min(len(audio), int(MAX_SECONDS * TARGET_SR))
            audio = fade_out(audio[:end_frame])
        audio = normalize(audio)
        dst_rel = f"{bank_id}/{src.stem}.wav"
        sf.write(OUT / dst_rel, audio, TARGET_SR, subtype="PCM_16")
        seen[key] = dst_rel
        out.append({
            "file": f"samples/{dst_rel}",
            "pitch": center,
            "velMin": round(lovel / 127, 3),
            "velMax": round(hivel / 127, 3),
            "loopStart": round(loop_s / TARGET_SR, 4) if loop_end is not None else None,
            "loopEnd": round(loop_e / TARGET_SR, 4) if loop_end is not None else None,
        })
    out.sort(key=lambda s: (s["pitch"], s["velMin"]))
    print(f"{bank_id}: {len(out)} samples, {sum((OUT / s['file'].replace('samples/', '')).stat().st_size for s in out)/1e6:.1f} MB")
    return {
        "id": bank_id,
        "name": meta["name"],
        "kind": "pitched",
        "type": meta["type"],
        "license": meta["license"],
        "source": meta["source"],
        "samples": out,
    }


def build_drums(bank_id: str, root: pathlib.Path, mapping: dict, meta: dict):
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / bank_id).mkdir(exist_ok=True)
    out = []
    for pitch, (folder, cap) in mapping.items():
        files = sorted((root / "samples" / folder).glob("*.flac"))
        if not files:
            print("  ! no files for", folder)
            continue
        picks = [files[int(len(files) * frac)] for frac in (0.2, 0.55, 0.9)]
        for i, f in enumerate(picks):
            audio, _ = load_audio(f)
            audio = audio[: int(cap * TARGET_SR)]
            audio = normalize(fade_out(audio))
            dst_rel = f"{bank_id}/{f.stem}.wav"
            sf.write(OUT / dst_rel, audio, TARGET_SR, subtype="PCM_16")
            out.append({
                "file": f"samples/{dst_rel}",
                "pitch": pitch,
                "velMin": [0.0, 0.45, 0.8][i],
                "velMax": [0.45, 0.8, 1.0][i],
                "loopStart": None,
                "loopEnd": None,
            })
    print(f"{bank_id}: {len(out)} samples, {sum((OUT / s['file'].replace('samples/', '')).stat().st_size for s in out)/1e6:.1f} MB")
    return {
        "id": bank_id,
        "name": meta["name"],
        "kind": "drums",
        "type": "drum",
        "license": meta["license"],
        "source": meta["source"],
        "samples": out,
    }


def main():
    piano_sfz = next((RAW / "pianoFull").rglob("*.sfz"), None)
    guitar_sfz = next(RAW.glob("FSS*/**/*.sfz"), None)
    if guitar_sfz is None:
        guitar_sfz = next(RAW.glob("guitarFSS/**/*.sfz"), None)
    bass_sfz = next((RAW / "bassYR").rglob("*.sfz"), None)
    drum_root = next((RAW / "muldjord").rglob("*.sfz")).parent
    if not (piano_sfz and guitar_sfz and bass_sfz and drum_root):
        sys.exit("缺少解压后的采样目录，请先解压到 assets/raw/extracted/")

    banks = [
        build_pitched("piano-kw", piano_sfz, {
            "name": "立式钢琴 KW",
            "type": "piano",
            "license": "CC0 1.0",
            "source": "FreePats · Upright Piano KW 2022-02-21（Kawai 立式钢琴实录）",
        }, tail=1.2),
        build_pitched("guitar-fss", guitar_sfz, {
            "name": "钢弦民谣吉他 FSS",
            "type": "guitar",
            "license": "GPLv3 + FreePats 采样例外",
            "source": "FreePats · FSS Steel-String Acoustic Guitar 2020-05-21（FlameStudios 录制）",
        }, tail=0.0),
        build_pitched("bass-yr", bass_sfz, {
            "name": "指弹电贝斯 YR",
            "type": "bass",
            "license": "CC0 1.0",
            "source": "FreePats · Finger Bass YR 2019-09-30（Yamaha RBX 实录）",
        }, tail=0.0),
        build_drums("drums-muldjord", drum_root, {
            36: ("KdrumL", 0.55),
            38: ("Snare1", 0.55),
            41: ("Tom2", 0.6),
            45: ("Tom4", 0.6),
            42: ("HihatClosed", 0.3),
            44: ("HihatOpen", 0.9),
            51: ("CrashL", 1.8),
        }, {
            "name": "原声鼓组 Muldjord",
            "license": "CC BY 4.0",
            "source": "FreePats · MuldjordKit 2020-10-18（Lars Muldjord 录制）",
        }),
    ]

    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST.write_text(json.dumps({"version": 1, "sampleRate": TARGET_SR, "banks": banks}, ensure_ascii=False, indent=2), encoding="utf-8")
    total = sum(f.stat().st_size for f in OUT.rglob("*.wav"))
    print(f"manifest -> {MANIFEST.relative_to(ROOT)}；采样总量 {total/1e6:.1f} MB")


if __name__ == "__main__":
    main()
