"""Pause is a saved state, not a red Notebook exception."""
import json
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
import uuid
from writer_check_progress import LaunchMonitor as BaseMonitor


class LaunchMonitor(BaseMonitor):
    def __init__(self,total_seconds=2880):
        super().__init__(interval=10.,total_seconds=total_seconds)
        self.stage='准备冻结表征上的显式管理头训练'

    def report(self):
        with self.lock:child,path,stage=self.child,self.progress_path,self.stage
        row=None
        if child is not None and path and child.poll() is None:
            try:
                value=json.loads(Path(path).read_text())
                if value.get('pid')==child.pid:row=value;stage=value['stage']
            except (OSError,ValueError):pass
        process='子进程尚未启动' if child is None else 'PID '+str(child.pid)+(' 存活' if child.poll() is None else ' 已退出('+str(child.returncode)+')')
        message='[管理头ZIP计时] 已用 '+str(int(time.monotonic()-self.started))+' 秒 | '+stage+' | '+process
        if row:message+=' | 原文 '+str(row.get('rawResponsesSaved',0))+'/28 | 管理头更新 '+str(row.get('headUpdates',0))+' | 冻结题 '+str(row.get('completeNewObjects',0))+'/4'
        print(message,flush=True)


def request_stop(folder,reason):
    if folder is None:return
    folder=Path(folder);folder.mkdir(parents=True,exist_ok=True)
    path=folder/'stop-request.json';temp=path.with_name(path.name+'.'+uuid.uuid4().hex+'.tmp')
    with temp.open('x',encoding='utf-8') as f:
        json.dump(dict(reason=reason,requestedAt=time.time()),f,ensure_ascii=False)
        f.flush();os.fsync(f.fileno())
    os.replace(temp,path)


def run_child(command,environment,monitor,progress_path=None,out=None,log_path=None):
    child=subprocess.Popen(command,env=environment,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,
                           text=True,bufsize=1)
    with monitor.lock:monitor.child=child;monitor.progress_path=Path(progress_path) if progress_path else None
    monitor.report();lines=queue.Queue()
    def collect():
        log=None
        try:
            if log_path:
                path=Path(log_path);path.parent.mkdir(parents=True,exist_ok=True)
                log=path.open('x',encoding='utf-8')
            for line in child.stdout:
                if log is not None:log.write(line);log.flush()
                lines.put(line)
        finally:
            if log is not None:log.close()
            lines.put(None)
    reader=threading.Thread(target=collect,daemon=True);reader.start()
    closed=False;exceeded=False;paused=False;grace=None
    try:
        while not (closed and child.poll() is not None):
            if time.monotonic()>=monitor.deadline and child.poll() is None:
                if not exceeded:
                    exceeded=True;grace=time.monotonic()+180
                    request_stop(out,'parent_total_budget');child.terminate()
                    print('总时限已到；正在保存原文与断点。',flush=True)
                elif time.monotonic()>=grace:child.kill()
            try:line=lines.get(timeout=.2)
            except queue.Empty:continue
            if line is None:closed=True
            else:print(line,end='',flush=True)
    except KeyboardInterrupt:
        paused=True
        request_stop(out,'notebook_interrupt')
        if child.poll() is None:
            child.terminate()
            try:child.wait(timeout=60)
            except subprocess.TimeoutExpired:
                print('仍在收尾；继续保留已落盘证据。',flush=True)
                try:child.wait(timeout=60)
                except subprocess.TimeoutExpired:child.kill();child.wait(timeout=5)
        print('已暂停；正在生成小审阅包，下次复用原文与管理头步骤。',flush=True)
    finally:
        reader.join(timeout=1)
        while not lines.empty():
            line=lines.get_nowait()
            if line is not None:print(line,end='',flush=True)
        if not reader.is_alive():child.stdout.close()
    return dict(exitCode=child.returncode,paused=paused,parentTotalBudgetReached=exceeded,childPid=child.pid)
