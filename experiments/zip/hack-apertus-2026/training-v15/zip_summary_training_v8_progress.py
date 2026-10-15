"""Actual saved management choices, histories and optimizer transitions."""
import json
import os
from pathlib import Path
import time
import uuid
from writer_check_progress import LaunchMonitor as BaseMonitor,run_child

class StageProgress:
    def __init__(self,path=None):
        self.path=Path(path) if path else None
        self.state=dict(pid=os.getpid(),stage='入口',rawResponsesSaved=0,completeNewObjects=0,
            managementUpdates=0,summaryUpdates=0,revisions=0,validManagementActions=0,inFlight=None)
    def mark(self,stage=None,**fields):
        change=stage is not None and stage!=self.state['stage']
        if stage:self.state['stage']=stage
        self.state.update(fields);self.state['updatedAt']=time.time()
        if self.path:
            tmp=self.path.with_name(self.path.name+'.'+uuid.uuid4().hex+'.tmp')
            tmp.write_text(json.dumps(self.state,ensure_ascii=False));os.replace(tmp,self.path)
        if change:print('[总结管理ZIP阶段] '+self.state['stage'],flush=True)

class LaunchMonitor(BaseMonitor):
    def __init__(self,total_seconds=1200):
        super().__init__(interval=10.,total_seconds=total_seconds)
        self.stage='准备学生管理与总结修订训练'
    def report(self):
        with self.lock:child,path,stage=self.child,self.progress_path,self.stage
        row=None
        if child is not None and path and child.poll() is None:
            try:
                value=json.loads(path.read_text())
                if value.get('pid')==child.pid:row=value;stage=value['stage']
            except (OSError,ValueError):pass
        process='子进程尚未启动' if child is None else 'PID '+str(child.pid)+(' 存活' if child.poll() is None else ' 已退出('+str(child.returncode)+')')
        line='[总结管理ZIP计时] 已用 '+str(int(time.monotonic()-self.started))+' 秒 | '+stage+' | '+process
        if row:line+=' | 原文 '+str(row['rawResponsesSaved'])+'/102 | 管理更新 '+str(row['managementUpdates'])+'/8 | 写作更新 '+str(row['summaryUpdates'])+'/2 | 完成题 '+str(row['completeNewObjects'])+'/12'
        print(line,flush=True)
