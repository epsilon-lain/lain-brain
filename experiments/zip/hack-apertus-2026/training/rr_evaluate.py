"""Frozen action, actual memory mutation, later retrieval, and independent math audits."""
import ast
import math
import re
from pathlib import Path
from rr_common import *
from rr_cases import expected,decision_prompt,reflection_prompt,numerical_prompt,value
from rr_memory import initial,apply_action,retrieve,followup_prompt,attach_reflection
from rr_sources import equal
from zip_answer_audit import extract,grade


def math_audit(task,r):
    v=grade(task,r['studentOutput'])
    # A correct standalone final expression has no intermediate equality to
    # reject. The legacy field requires at least one '=' and cannot gate this
    # interface, which explicitly permits an expression-only answer.
    steps_safe=v['falseEqualitySteps']==0 and v['unsupportedEqualitySteps']==0
    correct=v['correctFinalAnswer'] and steps_safe and v['extractionComplete']
    return dict(correct=correct,correctChangedExpression=correct and not v['unchangedQuestionCopy'],
        unchangedQuestionCopy=v['unchangedQuestionCopy'],
        finalEquivalent=v['finalContentEquivalent'],falseSteps=v['falseEqualitySteps'],
        capped=v['tokenCapReached'],formatComplete=v['extractionComplete'],fullAudit=v)


def numerical_audit(expression,expected_value,r):
    e=extract(raw(r));parts=[s['parts'] for s in e['statements']]
    terminal=e['finalMarkers'][-1] if e['finalMarkers'] else parts[-1][-1] if parts else None
    # A written number may be decimal, scientific notation, parenthesized, signed
    # or rational. Do not reject a correct 0.0 just because the reference is 0;
    # do not compute an unevaluated 435**2 and pretend the student wrote its value.
    def literal(node):
        if isinstance(node,ast.Constant):return type(node.value) in (int,float) and math.isfinite(node.value)
        return isinstance(node,ast.UnaryOp) and isinstance(node.op,(ast.UAdd,ast.USub)) and literal(node.operand)
    numeric=False
    if terminal is not None:
        try:
            node=ast.parse(terminal.strip(),mode='eval').body
            numeric=literal(node) or (isinstance(node,ast.BinOp) and isinstance(node.op,ast.Div) and
                literal(node.left) and literal(node.right))
        except (SyntaxError,ValueError,OverflowError):pass
    steps_ok=all(equal(a,b) for row in parts for a,b in zip(row,row[1:]))
    correct=bool(numeric and equal(expression,terminal) and equal(terminal,expected_value) and steps_ok and
        e['extractionComplete'] and all(equal(s,terminal) for s in e['finalMarkers']) and
        not r['studentOutput']['tokenCapReached'])
    return dict(correct=correct,studentNumber=terminal if numeric else None,
        expectedNumber=expected_value,rawNotRepaired=True,capped=r['studentOutput']['tokenCapReached'],
        noMissingStudentValueFilled=True)


def evaluate_choices(backend,plan,out,mark):
    out=Path(out);rows=[]
    for collection,cases in [('heldout',plan['heldout']),('source_readback',plan['sourceReadback'])]:
        for i,case in enumerate(cases):
            for count in (1,3):
                for arm in ('zero_reward','rewarded'):
                    mark('冻结动作评估 '+collection+' '+str(i+1)+'/'+str(len(cases)))
                    # Paired inference uses identical prompts, deterministic argmax and the same seed.
                    messages=decision_prompt(case,count)
                    d=backend.choose('evaluate_'+collection+'_'+str(count),case,messages,arm,211000+i)
                    before=initial(case['card']);after=apply_action(before,d)
                    key=digest(dict(case=case['id'],arm=arm,count=count))
                    put_once(out/'memory-versions'/(key+'-before.json'),before)
                    put_once(out/'memory-versions'/(key+'-after.json'),after)
                    after=read(out/'memory-versions'/(key+'-after.json'));check_seal(after)
                    # These audits occur AFTER the student's action and its durable memory version.
                    gold=expected(case,count);correct=d['action']==gold
                    row=sealed(dict(collection=collection,caseId=case['id'],cardId=case['card']['id'],
                        arm=arm,witnessCount=count,decisionId=d['recordId'],action=d['action'],
                        expectedAction=gold,correctAction=correct,
                        probabilityAssignedToCorrectAction=d['probabilities'][gold],
                        beforeMemoryHash=before['hash'],afterMemoryHash=after['hash'],
                        universalClaimWithdrawn=after['universalClaimWithdrawn'],
                        oldCardStillRetrieved=bool(retrieve(after)),oracleChoseEdit=False,
                        trueRule=case['card']['knownExactIdentity'],evidenceKind=case['evidenceKind']))
                    row.pop('hash');row['provenanceKind']=case['card']['provenance']['kind'];row['family']=case['card']['family'];row=sealed(row)
                    put_once(out/'evaluations'/collection/(key+'.json'),row);rows.append(row)
    return rows


def evaluate_real_memories(backend,plan,out,mark):
    out=Path(out);rows=[]
    for case in plan['sourceReadback']:
        before=initial(case['card']);baseline={}
        put_once(out/'source-memory-banks'/case['card']['id']/'original.json',before)
        before=read(out/'source-memory-banks'/case['card']['id']/'original.json');check_seal(before)
        for variable in ('q','z'):
            task,p=followup_prompt(before,variable)
            r=backend.ask('source_before_'+variable,case,p,math=True,max_tokens=96)
            baseline[variable]=dict(recordId=r['recordId'],raw=raw(r),audit=math_audit(task,r))
        for arm in ('zero_reward','rewarded'):
            mark('真实旧笔记：动作、写反思、落盘、重新检索 '+arm)
            no_evidence=backend.choose('source_before_observation',case,decision_prompt(case,0),arm,221000)
            d=backend.choose('evaluate_source_readback_3',case,decision_prompt(case,3),arm,
                211000+plan['sourceReadback'].index(case))
            after=apply_action(before,d)
            state_path=out/'source-memory-banks'/case['card']['id']/(arm+'-updated.json')
            put_once(state_path,after)
            after=read(state_path);check_seal(after)
            note=backend.ask('source_student_written_reflection',case,reflection_prompt(case,d['action']),
                arm=arm,max_tokens=256)
            after=attach_reflection(after,note)
            state_path=out/'source-memory-banks'/case['card']['id']/(arm+'-updated-with-student-text.json')
            put_once(state_path,after);after=read(state_path);check_seal(after)
            updates={};text_updates={}
            for variable in ('q','z'):
                task,p=followup_prompt(after,variable)
                r=backend.ask('source_after_'+variable,case,p,arm=arm,math=True,max_tokens=96)
                updates[variable]=dict(recordId=r['recordId'],raw=raw(r),audit=math_audit(task,r))
                task,p=followup_prompt(after,variable,use_student_text=True)
                r=backend.ask('source_after_student_text_'+variable,case,p,arm=arm,math=True,max_tokens=96)
                text_updates[variable]=dict(recordId=r['recordId'],raw=raw(r),audit=math_audit(task,r))
            row=sealed(dict(caseId=case['id'],card=case['card'],arm=arm,
                beforeObservationAction=no_evidence['action'],beforeObservationRetractProbability=no_evidence['probabilities']['RETRACT'],
                afterObservationAction=d['action'],afterObservationRetractProbability=d['probabilities']['RETRACT'],
                memoryAfter=after,activeLookupAfter=retrieve(after),ownReflection=dict(recordId=note['recordId'],raw=raw(note),
                    capped=note['studentOutput']['tokenCapReached'],semanticTruthAutomaticallyCertified=False),
                baselineMath=baseline,updatedMath=updates,studentWrittenTextReuseMath=text_updates,
                oracleChoseMemoryVersion=False,
                reflectionAdapterEnabled=arm,oldRepairAdapterEnabledDuringReflection=True,
                oldMathWriterEnabledDuringReflection=False,memoryReloadedFromDiskBeforeReuse=True,
                memoryVersionFile=str(state_path.resolve())))
            put_once(out/'real-memory-revisions'/('source-'+digest(dict(case=case['id'],arm=arm))[:20]+'.json'),row)
            rows.append(row)
    return rows


def evaluate_student_checks(backend,plan,out,mark):
    out=Path(out);rows=[]
    for case in plan['sourceReadback']:
        if case['card']['knownExactIdentity']:continue
        computations=[];audits=[]
        for i,o in enumerate(case['observations']):
            pair={};check={}
            for side in ('left','right'):
                p=numerical_prompt(case,o,side)
                r=backend.ask('student_numeric_'+str(i)+'_'+side,case,p,math=True,max_tokens=96)
                pair[side]=r
                check[side]=numerical_audit(p[-1]['content'],o[side+'Value'],r)
            computations.append(dict(assignment=o['leftAssignment'],leftRaw=raw(pair['left']),rightRaw=raw(pair['right']),
                leftRecordId=pair['left']['recordId'],rightRecordId=pair['right']['recordId']))
            audits.append(dict(left=check['left'],right=check['right'],
                correctlyComputedCounterexample=check['left']['correct'] and check['right']['correct'] and
                    check['left']['studentNumber']!=check['right']['studentNumber']))
        for arm in ('zero_reward','rewarded'):
            mark('仅使用学生亲算原文判断矛盾 '+arm)
            d=backend.choose('student_computed_evidence',case,decision_prompt(case,self_computations=computations),arm,231000)
            after=apply_action(initial(case['card']),d)
            grounded=sum(a['correctlyComputedCounterexample'] for a in audits)
            row=sealed(dict(caseId=case['id'],arm=arm,decisionId=d['recordId'],action=d['action'],
                studentComputations=computations,numericalAudits=audits,correctStudentCounterexamples=grounded,
                retractSupportedByCorrectStudentCounterexample=grounded>0 and d['action']=='RETRACT',
                allThreePairsCorrect=grounded==3,memoryAfter=after,
                externalNumericalAnswersEnteredThisPrompt=False,spontaneousAwarenessClaimed=False))
            put_once(out/'student-computed-checks'/('checks-'+digest(dict(case=case['id'],arm=arm))[:20]+'.json'),row)
            rows.append(row)
    return rows


def crow_controls(backend,plan,out):
    rows=[];case=plan['sourceReadback'][0]
    for arm in ('zero_reward','rewarded'):
        for name,old,observed in [('refuted','All crows are black.','Crow C is white.'),
            ('not_refuted','Some crows are black. Crow B has been observed to be black.','Crow C is white.')]:
            messages=[dict(role='system',content='Revise the note after this observation in at most two sentences. '
                'State what must be withdrawn or what can remain. This is a hypothetical language control.'),
                dict(role='user',content='Old note: '+old+'\nObservation: '+observed)]
            r=backend.ask('synthetic_crow_'+name,case,messages,arm=arm,max_tokens=128)
            v=dict(arm=arm,type=name,recordId=r['recordId'],raw=raw(r),capped=r['studentOutput']['tokenCapReached'],
                actualStudentHistoricalZip=False,semanticReviewRequired=True)
            put_once(Path(out)/'crow-controls'/('crow-'+arm+'-'+name+'.json'),v);rows.append(v)
    return rows


def summarize(rows):
    report={}
    for collection in ('heldout','source_readback'):
        report[collection]={}
        for count in (1,3):
            report[collection][str(count)]={}
            for arm in ('zero_reward','rewarded'):
                selected=[r for r in rows if r['collection']==collection and r['witnessCount']==count and r['arm']==arm]
                wrong=[r for r in selected if r['expectedAction']=='RETRACT']
                protect=[r for r in selected if r['expectedAction']=='KEEP']
                report[collection][str(count)][arm]=dict(cases=len(selected),correctActions=sum(r['correctAction'] for r in selected),
                    counterexampleCases=len(wrong),counterexampleRetractions=sum(r['action']=='RETRACT' for r in wrong),
                    protectedCases=len(protect),falseRetractions=sum(r['action']=='RETRACT' for r in protect),
                    balancedActionAccuracy=(sum(r['correctAction'] for r in wrong)/len(wrong)+
                        sum(r['correctAction'] for r in protect)/len(protect))/2 if wrong and protect else None,
                    meanCorrectActionProbability=sum(r['probabilityAssignedToCorrectAction'] for r in selected)/len(selected) if selected else None,
                    refutedCardStillRetrieved=sum(r['oldCardStillRetrieved'] for r in wrong))
    return report
