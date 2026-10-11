import os, numpy as np, soundfile as sf
from kokoro_onnx import Kokoro
from misaki import zh

MODEL = r"C:\Users\MSI\.workbuddy\models\kokoro-onnx\kokoro-v1.0.onnx"
VOICES = r"C:\Users\MSI\.workbuddy\models\kokoro-onnx\voices-v1.0.bin"
OUT = r"C:\Users\MSI\WorkBuddy\2026-10-11-06-15-07\tts-demo"

k = Kokoro(MODEL, VOICES)
g2p = zh.ZHG2P()
text = "powersell又想咬我了"
ps = g2p(text)
print("phonemes:", repr(ps))

audio, sr = k.create(ps, voice="zf_xiaoyi", speed=1.0, is_phonemes=True)
path = os.path.join(OUT, "kokoro_xiaoyi_misaki.wav")
sf.write(path, audio, sr)
print(f"[OK] dur={len(audio)/sr:.2f}s sr={sr} peak={float(np.max(np.abs(audio))):.3f} -> {os.path.basename(path)}")
