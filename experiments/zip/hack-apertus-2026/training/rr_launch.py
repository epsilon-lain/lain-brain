"""Notebook child monitor: bounded waits, readable heartbeat, recoverable interrupts."""
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time


class LaunchMonitor:
    def __init__(self,seconds):
        self.start=time.monotonic();self.deadline=self.start+seconds
        self.stage='准备';self.process=None;self.live=None;self.stop=threading.Event()
        self.thread=threading.Thread(target=self._heartbeat,daemon=True);self.thread.start()

    def phase(self,stage):self.stage=stage;self.show()

    def show(self):
        stage=self.stage;counts=''
        if self.live and self.live.is_file():
            try:
                value=json.loads(self.live.read_text());stage=value['stage']
                counts=' | 已提交 '+str(value['committedSteps'])+' | 动作 '+str(value['decisions'])+' | 原文 '+str(value['raws'])
            except (OSError,ValueError,KeyError):pass
        process=self.process
        status='尚未启动' if process is None else 'PID '+str(process.pid)+(' 存活' if process.poll() is None else ' 已退出('+str(process.returncode)+')')
        print('[反思奖励ZIP] 已用 '+str(int(time.monotonic()-self.start))+' 秒 | '+stage+' | '+status+counts,flush=True)

    def _heartbeat(self):
        while not self.stop.wait(20):self.show()

    def close(self):self.stop.set();self.thread.join(timeout=1.)


def run_child(command,env,monitor,log_path=None,live=None):
    logfile=None;process=None;paused=False;reason=None
    try:
        if log_path:
            log_path=Path(log_path);log_path.parent.mkdir(parents=True,exist_ok=True)
            logfile=log_path.open('w',encoding='utf-8')
        process=subprocess.Popen(command,env=env,stdout=logfile,stderr=subprocess.STDOUT if logfile else None,
            start_new_session=True)
        monitor.process=process;monitor.live=Path(live) if live else None;monitor.show()
        try:
            while process.poll() is None:
                if time.monotonic()>=monitor.deadline:
                    paused=True;reason='parent_time_budget';break
                time.sleep(.25)
        except KeyboardInterrupt:paused=True;reason='notebook_interrupt'
        if paused and process.poll() is None:
            print('暂停请求：等待子进程保存已提交步骤；重跑会接上断点。',flush=True)
            os.killpg(process.pid,signal.SIGTERM);grace=time.monotonic()+45
            try:
                while process.poll() is None and time.monotonic()<grace:time.sleep(.25)
            except KeyboardInterrupt:pass
            if process.poll() is None:
                os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        process.wait(timeout=5);monitor.show()
        return dict(exitCode=process.returncode,paused=paused,reason=reason,
            elapsedSeconds=time.monotonic()-monitor.start,logPath=str(log_path) if log_path else None)
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid,signal.SIGKILL);process.wait(timeout=5)
        if logfile is not None:logfile.close()
