"""Narrated, captioned recorded-evidence walkthrough. No simulated live inference."""
from pathlib import Path
import json,subprocess,zipfile,textwrap
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/video';OUT.mkdir(parents=True,exist_ok=True)
W,H=1280,720
def font(n,b=False,mono=False):return ImageFont.truetype('/usr/share/fonts/truetype/dejavu/'+('DejaVuSansMono.ttf' if mono else 'DejaVuSans-Bold.ttf' if b else 'DejaVuSans.ttf'),n)
def wrap(draw,text,x,y,size=26,width=1130,color='#e7eff7',bold=False,mono=False):
 f=font(size,bold,mono)
 for line in text.splitlines():
  words=line.split();s=''
  for word in words:
   t=(s+' '+word).strip()
   if f.getlength(t)>width and s:draw.text((x,y),s,font=f,fill=color);y+=size+12;s=word
   else:s=t
  draw.text((x,y),s,font=f,fill=color);y+=size+12
 return y
def run(args):subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error']+args,check=True)
with zipfile.ZipFile(ROOT/'data/evidence/Lain-Zip-Frozen-Replication-Review-20261014.zip') as z:
 r=next(x for x in json.loads(z.read('evidence/result.json'))['rows'] if x['caseId']=='fixed-source-435-repeat-1')
f=r['followup'][1]['results']
SCENES=[
('Can an AI revise what it remembers?', 'Lain ZIP / Apertus research prototype',
 ['A saved error can survive across tasks.','We make each memory revision inspectable.','Model output -> formal check -> saved version -> later use'],
 'This is Lain ZIP, a research prototype using Apertus. It asks a practical question: when an agent remembers an error, can it check and revise that memory?',13),
('Start with a real inherited error.', 'Recorded Apertus 70B outputs / fixed witness',
 ['SAVED: 435 * v * v = 435^2','WITNESS: v = 0','MODEL CHECKS: left ZERO / right POSITIVE'],
 'Here is an actual archived error. At the fixed input v equals zero, separate Apertus calls identify zero on the left and a positive value on the right.',14),
('Withdraw. Rewrite. Check. Save.', 'The model writes the replacement.',
 ['ACTION: '+r['action'],'REPLACEMENT: 435 * v^2','EXACT POLYNOMIAL AUDIT: accepted','Original text preserved; revised note saved and read back.'],
 'The model retracts the note and writes a replacement. An exact polynomial auditor checks the expression. We preserve the original and save the checked revision.',13),
('Does the saved revision help later?', 'Same later task: simplify 2 * 435 * z * z',
 ['OLD NOTE: '+f['old_note']['raw'],'REVISED NOTE: '+f['new_note']['raw'],'NO NOTE: '+f['no_note']['raw']],
 'On the later task, the old note leads to a wrong answer. The revised note restores the correct answer. The no note baseline was already correct.',15),
('Report the complete pilot.', 'Five rule units / six episodes',
 ['Strict complete repairs: 3 / 4','Content correct: no 12/12 | old 10/12 | revised 12/12','The two repaired errors repeat one underlying task.','A newer smoke test also wrongly withdrew a correct note.'],
 'The frozen pilot completes three of four strict repair workflows. This is a narrow result. Two repaired errors repeat one task, and a newer test also shows a false withdrawal.',16),
('Local training shows bounded progress.', 'Apertus 0.5B / frozen base / 192 writer updates',
 ['24 periodic objects: 44.41% vs 25.02%','Final checkpoint, 4 fresh objects: 54.24% vs 53.58%','Metric: mass on verified successful method routes.','Periodic probes span checkpoints; this is not accuracy.'],
 'Separate local training changes a small adapter. Periodic route success mass improves, but the final checkpoint advantage is small. These probabilities are not measured answer accuracy.',16),
('Learning memory use is still unfinished.', 'Positive selector results; mixed summaries; failed controller',
 ['Four frozen selector batches: all favor the trained selector.','Six summary rounds: mean effect +0.75 percentage points.','128 external-controller updates: 0/8 correct; all abstain.','Useful retention and revision both need to be learned.'],
 'Four selector batches favor training, while written summaries have mixed effects. A separate controller learns only withdrawal. We report that failure alongside the progress.',15),
('Run it. Inspect it. Reproduce it.', 'Public source, report, raw evidence and seven adapters',
 ['make run     -> localhost:7860','make test audit','Archive view needs no key; live mode uses an Apertus endpoint.','epsilon-lain / lain-brain / track_2b'],
 'The public submission includes a runnable prototype, raw evidence, training source and seven adapters. Inspect the records, reproduce the checks, and help test useful memory revision.',12)]
segments=[];captions=[];elapsed=0
for i,(title,sub,items,narration,seconds) in enumerate(SCENES):
 im=Image.new('RGB',(W,H),'#0b1524');d=ImageDraw.Draw(im)
 d.text((54,30),'LAIN ZIP  /  RECORDED EVIDENCE WALKTHROUGH',font=font(17),fill='#75d6ca')
 y=wrap(d,title,54,82,39,bold=True);y=wrap(d,sub,54,y+8,23,color='#a7bbd1')
 for j,item in enumerate(items):
  top=y+17; d.rounded_rectangle((45,top,1235,top+68 if len(item)<71 else top+96),radius=12,fill='#142b3a')
  y=wrap(d,item,65,top+15,25 if len(item)<79 else 22,width=1130,mono=(i in (1,2,3) or (i==7 and j<2)))+17
 if y>600:raise ValueError((i,y))
 foot='Recorded evidence, not live inference. English narration: synthetic voice.'
 wrap(d,foot,54,633,17,color='#a7bbd1')
 d.rectangle((54,685,54+int(1170*(i+1)/len(SCENES)),690),fill='#75d6ca')
 png=OUT/f'scene-{i}.png';im.save(png)
 txt=OUT/f'voice-{i}.txt';txt.write_text(narration)
 wav=OUT/f'voice-{i}.wav'
 run(['-f','lavfi','-i',f'flite=textfile={txt}:voice=slt','-ar','48000',str(wav)])
 duration=float(subprocess.check_output(['ffprobe','-v','error','-show_entries','format=duration','-of','csv=p=0',str(wav)]))
 if duration>seconds-.3:raise ValueError(('narration too long',i,duration,seconds))
 part=OUT/f'part-{i}.mp4'
 run(['-loop','1','-i',str(png),'-i',str(wav),'-t',str(seconds),'-vf','fps=20,format=yuv420p','-af','apad','-c:v','libx264','-preset','fast','-crf','25','-c:a','aac','-b:a','80k','-ar','48000','-ac','1',str(part)])
 segments.append("file '"+str(part)+"'")
 def time(t):return f'{int(t//3600):02}:{int(t//60)%60:02}:{int(t)%60:02},000'
 captions.append(f'{i+1}\n{time(elapsed)} --> {time(elapsed+seconds)}\n'+narration+'\n');elapsed+=seconds
(OUT/'concat.txt').write_text('\n'.join(segments))
video=OUT/'Lain-ZIP-Demo.mp4'
run(['-f','concat','-safe','0','-i',str(OUT/'concat.txt'),'-c','copy','-movflags','+faststart',str(video)])
(OUT/'Lain-ZIP-Demo.srt').write_text('\n'.join(captions))
(OUT/'SCRIPT.md').write_text('# Video script\n\nRecorded-evidence walkthrough with synthetic English narration; not a live screen recording.\n\n'+'\n\n'.join(f'## {i+1}. {s[0]} ({s[-1]} seconds)\n\n{s[-2]}' for i,s in enumerate(SCENES)))
print(json.dumps({'video':str(video),'seconds':elapsed,'bytes':video.stat().st_size,'syntheticEnglishNarration':True}))
