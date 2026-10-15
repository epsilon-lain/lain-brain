"""Assemble actual prototype captures, Jenny Neural audio and timed captions.

Input assets: scene-0..7.png from the prior evidence cards, detail-*.png from
the local prototype, jenny-0..7.mp3 and sentence boundary JSON from edge-tts.
No live inference or training is depicted by the walkthrough.
"""
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
import argparse,subprocess,json,textwrap,math

def font(size,bold=False):
 return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans'+('-Bold' if bold else '')+'.ttf',size)
def run(a):subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error']+a,check=True)
def duration(p):return float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(p)]))
def timestamp(t):
 ms=round(t*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02},{ms%1000:03}'

def build(assets,out):
 out.mkdir(parents=True,exist_ok=True);elapsed=0;captions=[];parts=[];metrics=[]
 titles={1:'Challenge a saved rule.',2:'Inspect the decision and saved revision.',3:'Compare later use of the saved memory.'}
 shots={1:'detail-checks.png',2:'detail-repair.png',3:'detail-later.png'}
 for i in range(8):
  voice=assets/f'jenny-{i}.mp3';seconds=round(duration(voice)+.8,3)
  if i in shots:
   im=Image.new('RGB',(1280,720),'#0b1524');d=ImageDraw.Draw(im)
   d.text((48,22),'LAIN ZIP / ACTUAL PROTOTYPE VIEW / RECORDED EVIDENCE',font=font(16),fill='#75d6ca')
   d.text((48,64),titles[i],font=font(33,True),fill='#e7eff7')
   shot=Image.open(assets/shots[i]).convert('RGB');shot.thumbnail((1184,440),Image.Resampling.LANCZOS)
   im.paste(shot,((1280-shot.width)//2,132+(440-shot.height)//2))
  else:
   im=Image.open(assets/f'scene-{i}.png').convert('RGB');d=ImageDraw.Draw(im)
  # Clear the old footer to reserve an unambiguous subtitle lane.
  d.rectangle((0,594,1280,720),fill='#09121e')
  d.rectangle((48,698,48+int(1184*(i+1)/8),702),fill='#75d6ca')
  frame=out/f'frame-{i}.png';im.save(frame)
  for b in json.loads((assets/f'jenny-{i}.json').read_text()):
   start=elapsed+b['offset']/10000000
   end=min(elapsed+seconds-.05,start+b['duration']/10000000)
   text='\n'.join(textwrap.wrap(b['text'],width=88))
   assert len(text.splitlines())<=2,text
   captions.append(f'{len(captions)+1}\n{timestamp(start)} --> {timestamp(end)}\n{text}\n')
  part=out/f'neural-part-{i}.mp4'
  run(['-loop','1','-i',str(frame),'-i',str(voice),'-t',str(seconds),'-vf','fps=20,format=yuv420p','-af','loudnorm=I=-16:TP=-1.5:LRA=9,apad','-c:v','libx264','-preset','fast','-crf','24','-c:a','aac','-b:a','128k','-ar','48000','-ac','1',str(part)])
  metrics.append({'scene':i,'voiceSeconds':duration(voice),'sceneSeconds':seconds});parts.append("file '"+str(part.resolve())+"'");elapsed+=seconds
 srt=out/'Lain-ZIP-Demo.srt';srt.write_text('\n'.join(captions))
 index=out/'neural-concat.txt';index.write_text('\n'.join(parts))
 assembled=out/'neural-without-subtitles.mp4'
 run(['-f','concat','-safe','0','-i',str(index),'-c','copy',str(assembled)])
 final=out/'Lain-ZIP-Demo.mp4'
 style='FontName=DejaVu Sans,FontSize=10,PrimaryColour=&H00FFFFFF,OutlineColour=&H0009121E,BorderStyle=1,Outline=1,Shadow=0,MarginV=15,Alignment=2'
 run(['-i',str(assembled),'-vf',f"subtitles=filename={srt}:force_style='{style}'",'-c:v','libx264','-preset','fast','-crf','24','-c:a','copy','-movflags','+faststart',str(final)])
 meta={'voice':'en-US-JennyNeural','voiceProvider':'Microsoft Edge online neural TTS via edge-tts','rate':'-8%','syntheticNarration':True,'recordedEvidenceNotLive':True,'actualPrototypeViews':3,'burnedInSentenceSubtitles':True,'normalizationTargetLUFS':-16,'truePeakTargetDBTP':-1.5,'durationSeconds':duration(final),'scenes':metrics}
 assert meta['durationSeconds']<120
 (out/'voice-config.json').write_text(json.dumps(meta,indent=2)+'\n')
 print(json.dumps({'video':str(final),'bytes':final.stat().st_size,**meta}),flush=True)

if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--assets',type=Path,required=True);p.add_argument('--out',type=Path,required=True);a=p.parse_args();build(a.assets.resolve(),a.out.resolve())
