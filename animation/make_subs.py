# Builds subs.srt + subs.ass for the final cut. Cue times come from measured pauses in each clip.
LEAD, GAP = 0.6, 0.5
clips = [
  (5.23, [(0.00, 2.06, "หากการสูญเสียความทรงจำ"), (2.37, 4.63, "หมายถึงการลืมทุกสิ่งที่เคยรู้จัก...")]),
  (3.25, [(0.00, 0.88, "แล้วทำไม..."), (1.16, 2.89, "ฉันถึงยังคิดถึงนายอยู่ล่ะ?")]),
  (5.01, [(0.00, 4.74, "นี่... ถ้าวันหนึ่งเธอลืมฉันขึ้นมาจริง ๆ\nจะทำยังไงเหรอ?")]),
  (3.55, [(0.00, 1.09, "อะไรของนายเนี่ย..."), (1.54, 3.05, "ฉันไม่มีทางลืมนายหรอก")]),
]
cues, off = [], LEAD
for dur, cs in clips:
    for a, b, t in cs: cues.append((off + a, off + b + 0.12, t))
    off += dur + GAP
def srt_ts(t):
    ms = round(t*1000); h, ms = divmod(ms, 3600000); m, ms = divmod(ms, 60000); s, ms = divmod(ms, 1000); return f"{h:02}:{m:02}:{s:02},{ms:03}"
def ass_ts(t):
    cs = round(t*100); h, cs = divmod(cs, 360000); m, cs = divmod(cs, 6000); s, cs = divmod(cs, 100); return f"{h}:{m:02}:{s:02}.{cs:02}"
open("subs.srt", "w", encoding="utf-8").write("\n".join(f"{i+1}\n{srt_ts(a)} --> {srt_ts(b)}\n{t}\n" for i, (a, b, t) in enumerate(cues)))
hdr = """[Script Info]
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Loma,36,&H00F4F0FF,&H000000FF,&H00301830,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,46,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
open("subs.ass", "w", encoding="utf-8").write(hdr + "\n".join(f"Dialogue: 0,{ass_ts(a)},{ass_ts(b)},Default,,0,0,0,,{t.replace(chr(10), chr(92)+'N')}" for a, b, t in cues) + "\n")
print(len(cues), "cues; last ends", round(cues[-1][1], 2))
