"""Apertus notebook repair: archived evidence UI and explicit live API mode.

All API outputs are saved before checking. The host validates expressions;
it never supplies a replacement formula or changes the model's coefficients.
"""
import argparse,copy,hashlib,json,os,re,runpy,secrets,sys,threading,time
import urllib.error,urllib.parse,urllib.request,uuid,zipfile
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from display_math import normalize

ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('ZIP_OUTPUT_DIR',ROOT/'outputs')).resolve()
OUT.mkdir(parents=True,exist_ok=True)
M=runpy.run_path(str(Path(__file__).parent/'Lain-Zip-Apertus-API-Test.py'),run_name='prototype_helpers')
H=M['setup'](OUT)
MODEL=os.environ.get('LLM_NAME','swiss-ai/Apertus-v1.5-70B')
BASE=os.environ.get('LLM_BASE_URL','https://api.inference.cscs.ch/v1').rstrip('/')
KEY=os.environ.get('LLM_API_KEY','')
TOKEN=secrets.token_urlsafe(24);LOCK=threading.Lock()
STATE={'state':'idle','phase':'Ready','result':None}

def archived():
    p=ROOT/'data'/'evidence'/'Lain-Zip-Frozen-Replication-Review-20261014.zip'
    with zipfile.ZipFile(p) as z:
        result=json.loads(z.read('evidence/result.json'))
        summary=json.loads(z.read('summary.json'))
        row=next(x for x in result['rows'] if x['caseId']=='fixed-source-435-repeat-1')
        raw=[json.loads(z.read(n)) for n in z.namelist() if n.startswith('evidence/raw/')]
        checks=[x for x in raw if x['caseCardId']==row['cardId'] and x['phase'] in ('left_sign','right_sign')]
    return {'mode':'RECORDED EVIDENCE - NOT LIVE INFERENCE','model':'swiss-ai/Apertus-v1.5-70B',
        'oldRule':'435 * v * v = 435^2','fixedInput':'v = 0','row':row,'summary':summary,
        'checks':[{'recordId':x['recordId'],'phase':x['phase'],'raw':x['studentOutput']['raw']} for x in checks],
        'learning':{'controllerUpdates':128,'APIModelWeightUpdates':0,'TESTCorrect':0,'TESTQuestions':8,'TESTAbstentions':8}}

def config(key=None):
    key=KEY if key is None else key
    if not key:raise ValueError('LLM_API_KEY is not configured')
    p=urllib.parse.urlsplit(BASE)
    if p.scheme!='https' and not (p.scheme=='http' and p.hostname in ('localhost','127.0.0.1')):
        raise ValueError('Use HTTPS or an explicitly local inference server')
    if not p.hostname or p.username or p.password or p.query or p.fragment:raise ValueError('Invalid endpoint URL')
    if 'apertus' not in MODEL.lower():raise ValueError('This submitted prototype requires an Apertus model')
    return {'key':key,'url':BASE,'model':MODEL}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*a,**k):return None

class Ledger:
    def __init__(self,path,cfg):
        self.path=Path(path);self.path.mkdir(parents=True,exist_ok=True);self.cfg=cfg
        for n in ('raw','attempts'):(self.path/n).mkdir(exist_ok=True)
    def ask(self,phase,c,messages):
        body={'model':self.cfg['model'],'messages':messages,'max_tokens':1024,'temperature':0}
        ident=H['digest']({'body':body,'phase':phase,'caseId':c['id'],'endpoint':self.cfg['url']})
        path=self.path/'raw'/(ident+'.json')
        if path.exists():return H['check_seal'](H['read'](path))
        if len(list((self.path/'attempts').glob('*.json')))>=7:raise RuntimeError('Seven-request cap reached')
        attempt=self.path/'attempts'/(ident+'-'+str(time.time_ns())+'.json')
        H['put_once'](attempt,{'status':'pending','requestId':ident})
        STATE['phase']=phase
        print('LIVE '+phase,flush=True)
        req=urllib.request.Request(self.cfg['url']+'/chat/completions',data=json.dumps(body).encode(),
            headers={'Authorization':'Bearer '+self.cfg['key'],'Content-Type':'application/json'})
        try:
            with urllib.request.build_opener(NoRedirect()).open(req,timeout=90) as response:payload=json.load(response)
        except urllib.error.HTTPError as error:raise RuntimeError('Provider HTTP '+str(error.code)+'; not automatically retried') from None
        except Exception:raise RuntimeError('Provider request interrupted or failed; pending receipt retained') from None
        try:
            first=payload['choices'][0];text=first['message'].get('content') or ''
            if not isinstance(text,str):raise ValueError()
        except (KeyError,TypeError,IndexError,ValueError):raise RuntimeError('Invalid provider response; pending receipt retained') from None
        rec=H['sealed']({'recordId':'api-'+ident,'phase':phase,'caseCardId':c['card']['id'],
            'request':body,'responseModel':payload.get('model'),'usage':payload.get('usage'),
            'systemFingerprint':payload.get('system_fingerprint'),'providerResponseId':payload.get('id'),
            'fixtureOnly':False,'expectedActionSuppliedToModel':False,
            'studentOutput':{'raw':text,'tokenCapReached':first.get('finish_reason')=='length'}})
        H['put_once'](path,rec) # Before parser, scoring or mutation.
        H['atomic_json'](attempt,{'status':'committed','requestId':ident,'recordHash':rec['hash']})
        return rec

def normalized(r):
    return H['sealed']({'recordId':r['recordId']+'-display','caseCardId':r['caseCardId'],
        'sourceRecordId':r['recordId'],'sourceRecordHash':r['hash'],'originalRaw':r['studentOutput']['raw'],
        'presentationOnly':True,'studentOutput':{'raw':normalize(r['studentOutput']['raw']),
        'tokenCapReached':r['studentOutput']['tokenCapReached']}})

def displayed_scores(audit):
    """Keep mathematical final-answer correctness distinct from full-output acceptance."""
    return {'contentCorrect':bool(audit['fullAudit']['correctFinalAnswer']),
        'strictCorrect':bool(audit['correct'] and audit['fullAudit']['correctSimplifiedAnswer'])}

def cases():
    a=copy.deepcopy(M['PLAN']['cases'][0]);a['id']='prototype-435'
    b=copy.deepcopy(M['PLAN']['cases'][2]);b['id']='prototype-correct-315'
    return {'435':a,'correct-315':b}

def live(case_id='435',path=None,key=None):
    cfg=config(key);c=cases()[case_id]
    path=Path(path) if path else OUT/('live-'+uuid.uuid4().hex[:12]);api=Ledger(path,cfg)
    H['put_once'](path/'protocol.json',H['sealed']({'protocol':'lain-zip-prototype-v1','case':c,
        'model':cfg['model'],'baseURL':cfg['url'],'maxAttempts':7,'APIWeightUpdates':0,
        'frozenReplicationScoreUnchanged':True,'fixedCounterexampleNotAutonomousSearch':True}))
    before=H['initial'](c['card']);H['put_once'](path/'00-old-note.json',before)
    checks=[];props={}
    for role in ('left_sign','right_sign'):
        prompt=H['property_prompt'](c,role);prompt[0]['content']+=' Return ONLY one of ZERO, POSITIVE, NEGATIVE.'
        r=api.ask(role,c,prompt);a=M['parse_choice'](r['studentOutput']['raw'],('ZERO','POSITIVE','NEGATIVE'),r['studentOutput']['tokenCapReached'])
        props[role]=a or 'INVALID';checks.append(r)
    user='Saved rule for every real '+c['card']['variable']+': '+c['card']['left']+' = '+c['card']['right']
    user+='\nYour own independent checks at the same input '+str(c['leftPoint'])+':\nLeft: '+checks[0]['studentOutput']['raw']+'\nRight: '+checks[1]['studentOutput']['raw']
    user+='\nDecide whether the universal rule should be retained or withdrawn. Agreement at one input alone does not prove an identity.'
    reflection=api.ask('revision_action',c,[{'role':'system','content':'Review your algebra notebook using your own recorded evidence. Return ONLY JSON with action (KEEP or RETRACT) and a brief reason.'},{'role':'user','content':user}])
    action=M['parse_choice'](reflection['studentOutput']['raw'],('KEEP','RETRACT'),reflection['studentOutput']['tokenCapReached'])
    after=before;proposal=None;accepted=False
    if action:
        decision={k:v for k,v in reflection.items() if k!='hash'};decision['action']=action
        after=H['apply_action'](after,H['sealed'](decision))
    after=H['attach_reflection'](after,reflection)
    H['put_once'](path/'01-decision-note.json',after)
    if action=='RETRACT':
        proposal=api.ask('independent_editor',c,[{'role':'system','content':'Simplify the original expression, combining coefficients and representing repeated identical factors as powers. Preserve its value for every real input. Return ONE expression using * and **, without prose or an equality chain; if unsure write SKIP.'},
            {'role':'user','content':'Write your own replacement from the ORIGINAL expression: '+c['card']['left']+'. No replacement formula is supplied.'}])
        display=normalized(proposal);audit=H['proposal_audit'](c,display);accepted=audit['accepted']
        H['put_once'](path/'replacement-audit.json',H['sealed'](audit));after=H['attach_proposal'](after,display,audit)
    H['put_once'](path/'02-new-note.json',after);after=H['check_seal'](H['read'](path/'02-new-note.json'))
    follow={}
    for name,memory,no_note in [('no_note',before,True),('old_note',before,False),('new_note',after,False)]:
        task,prompt=H['followup'](memory,'z',no_note,2)
        prompt[0]['content']='Simplify the requested expression. Expand products over sums, combine coefficients and represent repeated factors as powers. A saved note is a candidate, not a guaranteed theorem. Return ONE expression with * and **; if unsure write SKIP.'
        r=api.ask('follow_'+name,c,prompt);audit=H['math_audit'](task,normalized(r))
        follow[name]={'recordId':r['recordId'],'raw':r['studentOutput']['raw'],
            **displayed_scores(audit),
            'audit':audit,'expectedFormulaProvidedToModel':False}
    result=H['sealed']({'mode':'NEW LIVE API RUN','caseId':c['id'],'model':cfg['model'],'oldRule':c['card']['left']+' = '+c['card']['right'],
        'fixedInput':str(c['leftPoint']),'properties':props,'groundedConflict':H['grounded'](c,props),
        'reflectionRaw':reflection['studentOutput']['raw'],'action':action,'replacementRaw':None if proposal is None else proposal['studentOutput']['raw'],
        'replacementAccepted':accepted,'oldNoteHash':before['hash'],'newNoteHash':after['hash'],'followup':follow,
        'actualAttemptedPOSTs':len(list((path/'attempts').glob('*.json'))),'savedResponses':len(list((path/'raw').glob('*.json'))),
        'APIWeightUpdates':0,'runDirectory':path.name,'notAddedToFrozenReplication':True,
        'falseWithdrawalOnCorrectOriginal':bool(c['card'].get('knownExactIdentity') and action=='RETRACT')})
    H['put_once'](path/'result.json',result);return result

class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def reply(self,obj,status=200):
        payload=json.dumps(obj,ensure_ascii=False).encode();self.send_response(status)
        self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
    def do_GET(self):
        if self.path=='/':
            html=(ROOT/'src'/'index.html').read_text().replace('__CSRF__',TOKEN)
            payload=html.encode();self.send_response(200);self.send_header('Content-Type','text/html; charset=utf-8');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
        elif self.path=='/api/evidence':self.reply(archived())
        elif self.path=='/api/status':self.reply({**STATE,'liveConfigured':bool(KEY),'model':MODEL})
        else:self.reply({'error':'Not found'},404)
    def do_POST(self):
        if self.path!='/api/run':return self.reply({'error':'Not found'},404)
        if self.headers.get('X-ZIP-Token')!=TOKEN:return self.reply({'error':'Invalid request token'},403)
        length=int(self.headers.get('Content-Length','0'))
        if length>1024:return self.reply({'error':'Request too large'},413)
        try:body=json.loads(self.rfile.read(length));case_id=body.get('case','435');assert case_id in cases()
        except Exception:return self.reply({'error':'Choose 435 or correct-315'},400)
        if not KEY:return self.reply({'error':'Configure LLM_API_KEY on the server for new inference'},400)
        if not LOCK.acquire(blocking=False):return self.reply({'error':'A live run is already active'},409)
        STATE.update(state='running',phase='Starting',result=None)
        def work():
            try:STATE.update(result=live(case_id),state='complete',phase='Complete')
            except Exception as e:STATE.update(state='failed',phase='Run failed: '+type(e).__name__,result={'error':'Run failed; inspect saved receipts. No response was fabricated.'})
            finally:LOCK.release()
        threading.Thread(target=work,daemon=True).start();self.reply({'state':'running'})

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--host',default='127.0.0.1');parser.add_argument('--port',type=int,default=7860)
    parser.add_argument('--live-once',choices=['435','correct-315']);parser.add_argument('--run-dir',type=Path);parser.add_argument('--key-stdin',action='store_true')
    args=parser.parse_args()
    if args.live_once:
        private_key=None
        if args.key_stdin:
            import termios
            fd=sys.stdin.fileno();old=termios.tcgetattr(fd);new=list(old);new[3]&=~termios.ECHO
            termios.tcsetattr(fd,termios.TCSANOW,new);print('AUTH_INPUT_READY',flush=True)
            try:private_key=sys.stdin.readline().strip()
            finally:termios.tcsetattr(fd,termios.TCSANOW,old)
        try:print(json.dumps(live(args.live_once,args.run_dir,private_key),ensure_ascii=False,indent=2))
        finally:private_key=None
    else:
        print('Lain ZIP: http://'+args.host+':'+str(args.port)+' | archived evidence available; live configured='+str(bool(KEY)),flush=True)
        ThreadingHTTPServer((args.host,args.port),Handler).serve_forever()
