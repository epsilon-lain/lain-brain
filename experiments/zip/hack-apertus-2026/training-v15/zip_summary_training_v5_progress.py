"""Display actual candidates, group optimizer steps and frozen evaluations."""
import json
import os
from pathlib import Path
import time
import uuid
from writer_check_progress import LaunchMonitor as BaseMonitor, run_child


class StageProgress:
    def __init__(self,path=None):
        self.path=Path(path) if path else None
        self.state=dict(pid=os.getpid(),stage='入口',rawResponsesSaved=0,scoredResponses=0,
            generationAttempts=0,featureForwardBatches=0,completeNewObjects=0,summaryUpdates=0,
            choiceHeadUpdates=0,studentSummaries=0,usableSummaryZips=0,coldReproductions=0,
            qualityAssessments=0,candidateActivations=0,inFlight=None)
    def mark(self,stage=None,**fields):
        changed=stage is not None and stage!=self.state['stage']
        if stage is not None:self.state['stage']=stage
        self.state.update(fields);self.state['updatedAt']=time.time()
        if self.path:
            temp=self.path.with_name(self.path.name+'.'+uuid.uuid4().hex+'.tmp')
            with temp.open('x',encoding='utf-8') as f:json.dump(self.state,f,ensure_ascii=False);f.flush()
            os.replace(temp,self.path)
        if changed:print('[总结候选ZIP阶段] '+self.state['stage'],flush=True)


class LaunchMonitor(BaseMonitor):
    def __init__(self):
        super().__init__(interval=10.,total_seconds=1200.)
        self.stage='准备同经历多候选总结训练'
    def phase(self,stage):
        with self.lock:self.stage=stage
        self.report()
        if time.monotonic()>=self.deadline:raise TimeoutError('总结训练二十分钟总上限已到')
    def report(self):
        with self.lock:child,path,stage=self.child,self.progress_path,self.stage
        row=None
        if child is not None and path and child.poll() is None:
            try:
                value=json.loads(path.read_text())
                if value.get('pid')==child.pid and all(type(value.get(k)) is int and value[k]>=0 for k in
                    ('rawResponsesSaved','scoredResponses','summaryUpdates','choiceHeadUpdates','studentSummaries')):
                    row=value;stage=row['stage']
            except (OSError,ValueError,TypeError):pass
        process='子进程尚未启动' if child is None else 'PID '+str(child.pid)+(' 存活' if child.poll() is None else ' 已退出('+str(child.returncode)+')')
        message='[总结候选ZIP计时] 已用 '+str(int(time.monotonic()-self.started))+' 秒 | '+stage+' | '+process
        if row:message+=' | 原文 '+str(row['rawResponsesSaved'])+'/98 | 总结候选 '+str(row['studentSummaries'])+'/12 | 入选组 '+str(row.get('candidateActivations',0))+' | 写作更新 '+str(row['summaryUpdates'])+'/4 | 选择头更新 '+str(row['choiceHeadUpdates'])+'/12'
        print(message,flush=True)
