import os, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
from misaki import zh

MODEL = r"C:\Users\MSI\.workbuddy\models\kokoro-onnx\kokoro-v1.0.onnx"
VOICES = r"C:\Users\MSI\.workbuddy\models\kokoro-onnx\voices-v1.0.bin"
OUT = r"C:\Users\MSI\WorkBuddy\2026-10-11-06-15-07\tts-demo"

LONG = "powersell又想咬我了，这已经是第三次了，我把参数改小了一点，希望这次能跑通。"

k = Kokoro(MODEL, VOICES)
g2p = zh.ZHG2P()
ps = g2p(LONG)
print("phonemes:", repr(ps))
audio, sr = k.create(ps, voice="zf_xiaoyi", speed=1.0, is_phonemes=True)
sf.write(os.path.join(OUT, "long_kokoro_xiaoyi.wav"), audio, sr)
print(f"[OK] kokoro dur={len(audio)/sr:.2f}s")
print("TARGET:", LONG)
