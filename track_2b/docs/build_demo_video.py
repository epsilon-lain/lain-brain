"""Captioned evidence walkthrough, not a simulated live screen recording.

Requires Pillow and ffmpeg for authoring only. Application runtime does not.
"""
import argparse,json,subprocess,zipfile,textwrap
from pathlib import Path
from PIL import Image,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[1]
P=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',30)
B=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',48)
C=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',35)
SM=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',22)
def lines(draw,text,xy,font,width,color='#e5eef8'):
    x,y=xy
    for line in text.splitlines():
        words=line.split();current=''
        for word in words:
            candidate=(current+' '+word).strip()
            if font.getlength(candidate)>width and current:
                draw.text((x,y),current,font=font,fill=color);y+=font.size+14;current=word
            else:current=candidate
        draw.text((x,y),current,font=font,fill=color);y+=font.size+14
    return y
def build(destination):
    destination=Path(destination).resolve();frames=destination.parent/'demo-frames';frames.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(ROOT/'data/evidence/Lain-Zip-Frozen-Replication-Review-20261014.zip') as z:
        result=json.loads(z.read('evidence/result.json'));r=next(x for x in result['rows'] if x['caseId']=='fixed-source-435-repeat-1')
    f=r['followup'][1]['results']
    cards=[
      ('Memory worth checking.', 'Lain ZIP / Apertus / Track 2B',
       'An agent can remember an error.\nCan it challenge that note, save a checked revision, and use the revision later?',
       'Captioned recorded-evidence walkthrough. No live inference is represented.',12),
      ('Run the research prototype.', 'Docker + a local English browser interface',
       'make run\nhttp://localhost:7860\n\nArchive view: no key needed.\nLive button: configure LLM_NAME, LLM_BASE_URL, LLM_API_KEY on the server.',
       'Python HTTP and new API runs were tested. Docker validation is tracked separately.',15),
      ('An inherited rule meets a counterexample.', 'The witness was fixed before the experiment.',
       'Saved rule: 435 * v * v = 435^2\nFixed input: v = 0\n\nModel left check: ZERO\nModel right check: POSITIVE',
       'Actual archived Apertus outputs. This does not demonstrate autonomous witness search.',15),
      ('The model withdraws and rewrites.', 'Actual action: '+str(r['action']),
       'Model-written replacement:\n'+r['replacementRaw']+'\n\nExact polynomial audit: accepted\nThe revised note was saved and read back.',
       'The host checked the expression; it did not supply a replacement formula.',14),
      ('Compare the later task.', 'Simplify: 2 * 435 * z * z',
       'OLD NOTE: '+f['old_note']['raw']+'\n\nREVISED NOTE: '+f['new_note']['raw']+'\n\nNO NOTE: '+f['no_note']['raw'],
       'Bad-memory interference was removed. The no-note baseline was already correct.',18),
      ('Report both success and failure.', 'Frozen evidence / unchanged denominators',
       'Repair: 3/4 strict complete workflows\nContent correct: no / old / revised notes\n12/12       10/12       12/12\n\nLearning: 128 external-controller updates\n0/8 correct; 8/8 abstentions\nNo gain over constant withdrawal.',
       'Five rule units, six episodes. The two repaired errors repeat one underlying task.',20),
      ('Inspect the evidence. Then improve the objective.', '245 archived API responses / no model call needed for review',
       'make audit\nmake replay\n\nRaw outputs, memory versions and training receipts are preserved.\nNext: learn useful retention AND revision on unseen tasks.',
       'Lain Brain / epsilon-lain / AI-assisted development / limited pilot, no broad learning claim.',16)]
    listing=[]
    for i,(title,subtitle,text,foot,seconds) in enumerate(cards):
        im=Image.new('RGB',(1600,900),'#0b1524');d=ImageDraw.Draw(im)
        d.text((70,35),'LAIN ZIP  /  RECORDED EVIDENCE WALKTHROUGH',font=SM,fill='#75d6ca')
        y=lines(d,title,(70,105),B,1450);y=lines(d,subtitle,(70,y+13),P,1450,color='#a7bbd1')
        d.rounded_rectangle((60,y+20,1540,760),radius=18,fill='#142339',outline='#29435f',width=2)
        end=lines(d,text,(88,y+43),C if i in (2,3,4,5) else P,1420)
        if end>751:raise ValueError('Video card exceeds layout: '+str(i))
        lines(d,foot,(70,792),SM,1450,color='#a7bbd1');d.rectangle((70,868,70+int(1460*(i+1)/7),873),fill='#75d6ca')
        path=frames/('card-'+str(i)+'.png');im.save(path)
        listing+=['file '+str(path),'duration '+str(seconds)]
    listing.append('file '+str(path));index=frames/'concat.txt';index.write_text('\n'.join(listing)+'\n')
    subprocess.run(['ffmpeg','-y','-hide_banner','-loglevel','error','-f','concat','-safe','0','-i',str(index),'-t','110','-vf','fps=25,format=yuv420p','-c:v','libx264','-preset','fast','-crf','22','-movflags','+faststart',str(destination)],check=True)
    print(json.dumps({'video':str(destination),'durationSeconds':110,'audio':False,'recordedEvidenceNotLive':True}))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path,required=True);args=parser.parse_args();build(args.out)
