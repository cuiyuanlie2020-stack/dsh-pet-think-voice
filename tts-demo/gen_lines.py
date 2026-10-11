# -*- coding: utf-8 -*-
"""用最终定死的音色（晓伊 Xiaoyi + pitch=+30Hz）生成贴近真实场景的思考台词样音。"""
import asyncio
import edge_tts

VOICE = "zh-CN-XiaoyiNeural"
PITCH = "+30Hz"

LINES = [
    ("line1", "等等，这个正则怎么写都不对，我是不是把方向搞反了？"),
    ("line2", "哦——原来 param 是必填的，难怪一直报 undefined。"),
    ("line3", "powersell 又想咬我了，这已经是第三次了。"),
    ("line4", "嗯……这个 bug 藏得真深，我绕了一大圈才找到。"),
    ("line5", "好，思路清晰了，let me 把这个 function 重写一下。"),
]


async def main():
    for name, text in LINES:
        c = edge_tts.Communicate(text, VOICE, pitch=PITCH)
        out = f"{name}.mp3"
        await c.save(out)
        print(f"[ok] {out}  <- {text}")


if __name__ == "__main__":
    asyncio.run(main())
