"""Small entry/receipt helpers, shared by the delivered launcher and offline checks."""
from pathlib import Path

def require(value,message):
    if not value:raise ValueError(message)

def main_once(namespace,key,runner):
    states=namespace.setdefault('_LAIN_ZIP_MEMORY_RUNS',{})
    earlier=states.get(key)
    if earlier and earlier['status']=='completed':
        print('本单元格已运行完毕；重复入口直接返回已有结果，不再次训练。',flush=True)
        return earlier['result']
    if earlier and earlier['status']=='running':raise RuntimeError('Same-cell training entry is already active')
    state=dict(status='running',result=None);states[key]=state
    try:
        outcome=runner();state.update(status='completed',result=outcome);return outcome
    except BaseException:state['status']='interrupted';raise


def validate_completed(result):
    require(result.get('protocol')=='lain-zip-memory-management-training-v8' and result.get('fixtureOnly') is False and
        not result.get('fixtureGenerations') and not result.get('teacherCalls') and not result.get('offlineFixtureFactory'),
        'Fixture/teacher metadata cannot admit a real course')
    require(result.get('stopReason')=='completed' and result.get('error') is None and result.get('completeTrainingExperiment') is True and
        result['completedTrainingObjects']==8 and result['completedHeldoutObjects']==4 and result['coldReproductions']==8 and
        result['studentWrittenSummaryZips']==6 and 90<=result['actualStudentGenerations']<=102 and
        0<=result['managementOptimizerUpdates']<=8 and 0<=result['summaryOptimizerUpdates']<=2 and
        result['trainingUpdates']==result['managementOptimizerUpdates']+result['summaryOptimizerUpdates'] and
        result['choiceHeadTrainingUpdates']==0 and
        all(result[k] is True for k in ('baseWeightsUnchanged','mathematicalWriterUnchanged','originalSemanticWriterUnchanged',
            'methodHeadsUnchanged','originalFilesUnchanged','heldoutLearnedStateUnchanged')),
        'Only a complete frozen-checked management course can continue')


def small_review_paths(folder):
    folder=Path(folder)
    for name in ('result.json','protocol.json','zip-summary-questions.json','source-checkpoint.json','run-file-manifest.json'):
        path=folder/name
        if path.is_file():yield path
    for name in ('responses','management-choice','management-feedback','reuse-history','revision-feedback',
            'revision-measurement','object','trial'):
        for path in sorted((folder/name).glob('*.json')):
            if name=='responses' and not path.name.endswith('-raw.json'):continue
            yield path
