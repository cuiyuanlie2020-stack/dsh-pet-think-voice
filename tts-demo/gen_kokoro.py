import os, sys, traceback
import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

MODEL = r"C:\Users\MSI\.workbuddy\models\kokoro-onnx\kokoro-v1.0.onnx"
VOICES = r"C:\Users\MSI\.workbuddy\models\kokoro-onnx\voices-v1.0.bin"
OUT = r"C:\Users\MSI\WorkBuddy\2026-10-11-06-15-07\tts-demo"

k = Kokoro(MODEL, VOICES)
print("model loaded; available voices (sample):", k.get_voices()[:12])
zhv = [v for v in k.get_voices() if v.startswith("zf_") or v.startswith("zm_")]
print("chinese voices:", zhv)

text = "powersell又想咬我了"
for lang in ["cmn", "zh", "zh-cn", "yue"]:
    try:
        audio, sr = k.create(text, voice="zf_xiaoyi", speed=1.0, lang=lang)
        dur = len(audio) / sr
        path = os.path.join(OUT, f"kokoro_xiaoyi_{lang.replace('-','')}.wav")
        sf.write(path, audio, sr)
        peak = float(np.max(np.abs(audio)))
        print(f"[OK] lang={lang:6s} dur={dur:.2f}s sr={sr} peak={peak:.3f} -> {os.path.basename(path)}")
    except Exception as e:
        print(f"[ERR] lang={lang}: {type(e).__name__}: {e}")
        traceback.print_exc(limit=1)
