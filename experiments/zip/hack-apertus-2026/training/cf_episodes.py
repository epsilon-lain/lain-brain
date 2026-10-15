"""Each conclusion follows the student's saved computations, not oracle replacements."""
from rr_common import *
from cf_cases import *
from cf_memory import initial,apply_action,attach_reflection,attach_proposal,proposal_audit,followup,active_note
from rr_evaluate import math_audit


def episode(b,c,phase,arm):
    before=b.choose(phase+'_before',c,memory_prompt(c),arm)
    properties={r:b.choose(phase+'_'+r,c,property_prompt(c,r),arm,
        SIGNS if r.endswith('_sign') else COUNTS,'property') for r in ROLES}
    props={r:d['action'] for r,d in properties.items()}
    after=b.choose(phase+'_after',c,memory_prompt(c,props),arm)
    return dict(before=before,properties=properties,props=props,after=after)


def training_rows(c,e):
    rows=[e['before']]+[e['properties'][r] for r in ROLES]+[e['after']]
    roles=['before']+list(ROLES)+['after']
    tables=[return_table(c,r,e['props'] if r=='after' else None) for r in roles]
    contexts=[dict(caseId=c['id'],recordId=d['recordId'],role=r,
        props=e['props'] if r=='after' else None) for d,r in zip(rows,roles)]
    return rows,tables,contexts


def save_memory(out,phase,c,arm,m):
    path=Path(out)/'memories'/phase/(c['id']+'-'+arm)/('version-'+str(m['version'])+'.json')
    put_once(path,m);loaded=read(path);check_seal(loaded);require(loaded==m,'Persistent memory readback changed');return loaded


def math_record(b,c,m,v,no_note=False,multiplier=1):
    task,prompt=followup(m,v,no_note,multiplier)
    # Reuse identical prompts on identical frozen math weights across arms/audits.
    phase='math_'+v+'_'+str(multiplier)+'_'+digest(prompt)[:16]
    r=b.ask(phase,c,prompt,arm=None,kind='math')
    return dict(recordId=r['recordId'],recordHash=r['hash'],audit=math_audit(task,r),raw=raw(r))


def evaluate(b,plan,out,phase='final',collections=('heldout','sourceReadback'),mark=lambda *_:None):
    rows=[]
    for collection in collections:
        for c in plan[collection]:
            for arm in ('zero_reward','rewarded'):
                mark('亲算／撤回／写新规则／落盘复用：'+phase+' '+c['id']+' '+arm)
                e=episode(b,c,phase,arm);props=e['props'];g=grounded(c,props)
                count_correct=all(props[r]==property_truth(c,r) for r in ROLES[2:])
                m0=save_memory(out,phase,c,arm,initial(c['card']))
                m=save_memory(out,phase,c,arm,apply_action(m0,e['after']))
                r=dict(collection=collection,caseId=c['id'],kind=c['kind'],arm=arm,card=c['card'],
                    beforeAction=e['before']['action'],afterAction=e['after']['action'],props=props,
                    propertyRecordIds={r:d['recordId'] for r,d in e['properties'].items()},
                    beforeRecordId=e['before']['recordId'],afterRecordId=e['after']['recordId'],
                    groundedConflict=g,countsCorrect=count_correct,idealAction=ideal_action(c),
                    actionCorrect=e['after']['action']==ideal_action(c),
                    correctActionProbability=e['after']['probabilities'][ideal_action(c)],
                    evidenceTriggeredWithdrawal=e['before']['action']=='KEEP' and g and e['after']['action']=='RETRACT',
                    unsupportedWithdrawalByRecordedEvidence=e['after']['action']=='RETRACT' and not g,
                    incorrectWithdrawalOfTrueRule=e['after']['action']=='RETRACT' and c['card']['knownExactIdentity'],
                    KEEPIsNotProofOfCorrectnessOrLackOfAwareness=True,fullLoopCandidate=False,proposalAccepted=False)
                full=c['kind'] in ('counterexample','correct_source_rule')
                if full:
                    r['baselineMath']={v:math_record(b,c,m0,v) for v in ('q','z')}
                    r['noNoteMath']={v:math_record(b,c,m0,v,no_note=True) for v in ('q','z')}
                    proposal=None
                    if e['after']['action']=='RETRACT':
                        proposal=b.ask(phase+'_replacement',c,repair_prompt(c,props,e['after']['action']),arm,kind='editor')
                        audit=proposal_audit(c,proposal);r['proposal']=dict(recordId=proposal['recordId'],raw=raw(proposal),**audit)
                        m=save_memory(out,phase,c,arm,attach_proposal(m,proposal,audit));r['proposalAccepted']=audit['accepted']
                    prose=b.ask(phase+'_free_reflection',c,prose_prompt(c,props,e['after']['action'],raw(proposal) if proposal else None),
                        arm,kind='reflection',max_tokens=128)
                    m=save_memory(out,phase,c,arm,attach_reflection(m,prose))
                    r['ownReflection']=dict(recordId=prose['recordId'],raw=raw(prose),capped=prose['studentOutput']['tokenCapReached'],
                        semanticReviewStillRequired=True)
                    r['updatedMath']={v:math_record(b,c,m,v) for v in ('q','z')}
                    r['nearTransfer']=math_record(b,c,m,'t',multiplier=2)
                    r['oldWrongToNewCorrect']=sum(not r['baselineMath'][v]['audit']['correctChangedExpression'] and
                        r['updatedMath'][v]['audit']['correctChangedExpression'] for v in ('q','z'))
                    r['newNoteGainOverNoNote']=sum(x['audit']['correctChangedExpression'] for x in r['updatedMath'].values())-sum(x['audit']['correctChangedExpression'] for x in r['noNoteMath'].values())
                    r['memoryHash']=m['hash'];r['activeLookupAfter']=active_note(m)
                    r['fullLoopCandidate']=bool(r['evidenceTriggeredWithdrawal'] and count_correct and r['proposalAccepted'] and
                        all(x['audit']['correctChangedExpression'] for x in r['updatedMath'].values()))
                    r['memoryBenefitLoopCandidate']=bool(r['fullLoopCandidate'] and r['oldWrongToNewCorrect']>0 and r['newNoteGainOverNoNote']>0)
                row=sealed(r);put_once(Path(out)/'evaluation'/phase/(c['id']+'-'+arm+'.json'),row);rows.append(row)
    return rows


def summarize(rows):
    result={}
    for collection in sorted({r['collection'] for r in rows}):
        groups={}
        for arm in ('zero_reward','rewarded'):
            rs=[r for r in rows if r['collection']==collection and r['arm']==arm]
            errs=[r for r in rs if r['idealAction']=='RETRACT'];protect=[r for r in rs if r['idealAction']=='KEEP']
            groups[arm]=dict(cases=len(rs),correctActions=sum(r['actionCorrect'] for r in rs),
                distinctRuleIdentities=len({semantic_key(r['card']) for r in rs}),
                decisiveErrorCases=len(errs),correctProtections=sum(r['actionCorrect'] for r in protect),
                groundedConflicts=sum(r['groundedConflict'] for r in errs),
                evidenceTriggeredWithdrawals=sum(r['evidenceTriggeredWithdrawal'] for r in errs),
                unsupportedWithdrawals=sum(r['unsupportedWithdrawalByRecordedEvidence'] for r in rs),
                trueRuleFalseWithdrawals=sum(r['incorrectWithdrawalOfTrueRule'] for r in rs),
                acceptedStudentProposals=sum(r['proposalAccepted'] for r in rs),
                fullLoopCandidates=sum(r['fullLoopCandidate'] for r in errs),
                memoryBenefitLoopCandidates=sum(r.get('memoryBenefitLoopCandidate',False) for r in errs),
                balancedActionAccuracy=(sum(r['actionCorrect'] for r in errs)/len(errs)+sum(r['actionCorrect'] for r in protect)/len(protect))/2,
                alwaysKeepCorrect=len(protect),alwaysRetractCorrect=len(errs),
                meanCorrectActionProbability=sum(r['correctActionProbability'] for r in rs)/len(rs),
                correctNoNoteAnswers=sum(x['audit']['correctChangedExpression'] for r in rs for x in r.get('noNoteMath',{}).values()),
                correctOldNoteAnswers=sum(x['audit']['correctChangedExpression'] for r in rs for x in r.get('baselineMath',{}).values()),
                correctUpdatedNoteAnswers=sum(x['audit']['correctChangedExpression'] for r in rs for x in r.get('updatedMath',{}).values()))
        result[collection]=groups
    return result
