"""Reuse the tested independent timer, reporting actual iteration counts."""
import json
import os
import time
from pathlib import Path
import uuid
from writer_check_progress import LaunchMonitor as BaseMonitor, run_child


class StageProgress:
    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.state = dict(pid=os.getpid(), stage='入口', rawResponsesSaved=0, scoredResponses=0,
            featureForwardBatches=0, coldReproductions=0, completeNewObjects=0,
            semanticFeedbackSteps=0, semanticUpdates=0, choiceHeadUpdates=0,
            labelRevisions=0, generationAttempts=0, inFlight=None)

    def mark(self, stage=None, **fields):
        now=time.time(); changed=stage is not None and stage!=self.state['stage']
        if changed or 'stageStartedAt' not in self.state:
            self.state['stageStartedAt']=now
        if stage is not None:
            self.state['stage']=stage
        self.state.update(fields); self.state['updatedAt']=now
        if self.path:
            temporary=self.path.with_name(self.path.name+'.'+uuid.uuid4().hex+'.tmp')
            with temporary.open('x',encoding='utf-8') as f:
                json.dump(self.state,f,ensure_ascii=False);f.flush()
            os.replace(temporary,self.path)
        if changed:
            print('[ZIP自我提问阶段] '+self.state['stage'],flush=True)


class LaunchMonitor(BaseMonitor):
    def __init__(self):
        super().__init__(interval=10.,total_seconds=1200.)
        self.stage='准备学生自我提问与ZIP复验'

    def report(self):
        with self.lock:
            child,path,stage=self.child,self.progress_path,self.stage
        row=None
        if child is not None and path and child.poll() is None:
            try:
                saved=json.loads(path.read_text(encoding='utf-8'))
                counts=('rawResponsesSaved','scoredResponses','featureForwardBatches',
                    'coldReproductions','completeNewObjects','semanticUpdates','choiceHeadUpdates')
                if saved.get('pid')==child.pid and all(type(saved.get(k)) is int and saved[k]>=0 for k in counts):
                    row=saved;stage=saved['stage']
            except (OSError,ValueError,TypeError):
                pass
        process='子进程尚未启动' if child is None else 'PID '+str(child.pid)+(
            ' 存活' if child.poll() is None else ' 已退出('+str(child.returncode)+')')
        text='[ZIP自我提问计时] 已用 '+str(int(time.monotonic()-self.started))+' 秒 | '+stage+' | '+process
        if row:
            text+=' | 原文 '+str(row['rawResponsesSaved'])+'/76 | 特征批 '+str(row['featureForwardBatches'])+'/50'
            text+=' | 对象 '+str(row['completeNewObjects'])+'/6 | 写作更新 '+str(row['semanticUpdates'])+'/2'
            text+=' | 选择头更新 '+str(row['choiceHeadUpdates'])+'/1 | 旧复现 '+str(row['coldReproductions'])+'/8'
        print(text,flush=True)
