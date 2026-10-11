import whisper, os, glob
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
m = whisper.load_model("base", download_root=r"C:\Users\MSI\.workbuddy\models\whisper")
D = r"C:\Users\MSI\WorkBuddy\2026-10-11-06-15-07\tts-demo"
files = sorted(glob.glob(os.path.join(D, "*.mp3")) + glob.glob(os.path.join(D, "*.wav")))
print("TARGET: powersell又想咬我了")
for f in files:
    try:
        r = m.transcribe(f, language="zh", fp16=False)
        print(f"{os.path.basename(f):30s} -> {r['text'].strip()}")
    except Exception as e:
        print(f"{os.path.basename(f):30s} -> ERR {type(e).__name__}: {e}")
