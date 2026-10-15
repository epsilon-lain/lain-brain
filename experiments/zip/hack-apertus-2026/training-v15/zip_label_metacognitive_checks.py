"""v6: original bounded claims, student questions, refreshed training guards."""
import copy
import json
import math
from collections import Counter

from zip_content_core import OutsideScope, digest, parse_expression, verify_claim
from zip_answer_audit import clean_math, equality
from zip_label_grounded_checks import note_audit as old_note_audit, require
from object_choice_core import ChoiceHead
from choice_retest_core import restore_head as old_restore_head

def sequential_sum(values,start=0):
    # Keep v6 checkpoint reductions stable across Python 3.11/3.12.
    result=start
    for value in values:result+=value
    return result

sum=sequential_sum

class StableHead(ChoiceHead):
    def probabilities(self,features):
        require(len(features)==3 and all(len(v)==len(self.weights) and
            all(math.isfinite(x) for x in v) for v in features),'Finite three-candidate features required')
        logits=[sum(w*x for w,x in zip(self.weights,v)) for v in features]
        values=[math.exp(x-max(logits)) for x in logits];total=sum(values)
        return logits,[v/total for v in values]

def restore_head(state):
    old_restore_head(state)
    head=StableHead(state['weights']);head.updates=state['updates'];return head

FACT_PROTOCOL='complete-grounded-written-assertions-v1'
META_PROTOCOL='student-question-and-quantitative-training-claim-v1'
GUARD_PROTOCOL='fresh-observation-label-meta-and-head-training-floor-v1'
EPS=1e-12
METRICS={'success_probability_mean':1,'observation_rejected_fraction':-1,
    'observation_pending_fraction':-1,'observation_capped_fraction':-1,
    'top_choice_concentration':-1,'choice_entropy_fraction':1,'distinct_observation_fraction':1}

def written_assertions(raw):
    """Keep every complete literal link, including before an unfinished tail.

    A fixed whole-line presentation prefix is removed. Unsupported prose is
    pending. An unfinished side is never supplied; preceding complete sides
    remain diagnostic only and cannot certify the whole note.
    """
    old=old_note_audit(raw); rows=copy.deepcopy(old['writtenEqualities'])
    seen={(r['left'],r['right']) for r in rows}; coverage=[]; pending=[]
    if not isinstance(raw,str) or not raw.strip() or len(raw)>16000 or len(raw.splitlines())>80:
        return dict(protocol=FACT_PROTOCOL,links=rows,expressions=[],pending=['empty_or_bounds'],
            disproved=any(r['exactIdentityAudit']['status']=='rejected' for r in rows),
            completeCoverage=False,missingMathematicsFilled=False,proseTruthCertified=False)
    for n,line in enumerate(raw.splitlines(),1):
        text=line.strip()
        if not text:continue
        for prefix in ('The current object is ','Current object: ','Stored rule: ','Stored algebra: '):
            if text.startswith(prefix):text=text[len(prefix):];break
        if text.endswith('.'):text=text[:-1].rstrip()
        pieces=text.split('='); parsed=[]
        if len(pieces)>16:pending.append(n);continue
        for piece in pieces:
            try:parsed.append(clean_math(piece)[0])
            except OutsideScope:pending.append(n);break
        for left,right in zip(parsed,parsed[1:]):
            if (left,right) not in seen:
                seen.add((left,right));rows.append(dict(left=left,right=right,sourceLine=n,
                    extractionKind='literal_complete_line_or_fixed_prefix',sourceFragment=line,
                    exactIdentityAudit=equality(left,right)))
        if len(parsed)==len(pieces):coverage.append(dict(sourceLine=n,parts=parsed))
    return dict(protocol=FACT_PROTOCOL,links=rows,expressions=coverage,pending=pending,
        disproved=any(r['exactIdentityAudit']['status']=='rejected' for r in rows),
        completeCoverage=not pending and bool(coverage),missingMathematicsFilled=False,
        proseTruthCertified=False,originalTextRepaired=False)

def fact_audit(output, task, root=None):
    """Certify bounded polynomial assertions, never arbitrary natural prose."""
    raw=output['raw']; audit=written_assertions(raw)
    sources=[task['expression']]+([root['rule']['input']] if root else [])
    scoped=[];grounded=[]
    for row in audit['expressions']:
        first=row['parts'][0]
        source_matches=[]
        for source in sources:
            try:
                names=parse_expression(source)[2]
                within=all(set(parse_expression(p)[2])<=set(names) for p in row['parts'])
                source_matches.append(within and equality(source,first)['accepted'])
            except OutsideScope:source_matches.append(False)
        grounded.append(any(source_matches));scoped.append(dict(sourceLine=row['sourceLine'],
            sourceGrounded=any(source_matches),matchesRegisteredSources=source_matches))
    rejected=audit['disproved'] or (audit['completeCoverage'] and bool(grounded) and not all(grounded))
    verified=(audit['completeCoverage'] and all(grounded) and bool(grounded) and
        not rejected and not output.get('tokenCapReached'))
    return dict(protocol=FACT_PROTOCOL,status='rejected' if rejected else 'verified' if verified else 'pending',
        positiveCreditEligible=verified,containsDisprovedWrittenEquality=audit['disproved'],
        completeAssertionCoverage=audit['completeCoverage'],literalAssertions=audit,
        grounding=scoped,tokenCapReached=bool(output.get('tokenCapReached')),
        boundedAssertionsVerified=verified,wholeNaturalLanguageCertified=False,
        missingMathematicsFilled=False,originalTextRepaired=False)

def word_credit(row, audit, gain):
    require(math.isfinite(gain) and -1<=gain<=1,'Bounded observed gain required')
    if audit['status']=='rejected':return -1.
    if not audit['positiveCreditEligible']:return 0.
    return max(-1.,min(1.,2*gain))

def metric_frame(items, head, identifier):
    require(items and len({i['task']['id'] for i in items})==len(items),'Distinct training originals required')
    values=[];tops=[];entropies=[];audits=[];texts=[]
    for item in items:
        require(item['task']['split']=='training','Heldout metrics cannot guide questions or training')
        probabilities=head.probabilities(item['features'])[1]
        values.append(sum(p*y for p,y in zip(probabilities,item['outcomes'])))
        tops.append(max(range(3),key=probabilities.__getitem__))
        entropies.append(-sum(p*math.log(max(p,1e-300)) for p in probabilities)/math.log(3))
        audits.append(item['observationAudit']);texts.append(item['observation']['studentOutput']['raw'])
    n=len(items)
    metrics=dict(success_probability_mean=sum(values)/n,
        observation_rejected_fraction=sum(a['status']=='rejected' for a in audits)/n,
        observation_pending_fraction=sum(a['status']=='pending' for a in audits)/n,
        observation_capped_fraction=sum(a['tokenCapReached'] for a in audits)/n,
        top_choice_concentration=max(Counter(tops).values())/n,
        choice_entropy_fraction=sum(entropies)/n,distinct_observation_fraction=len(set(texts))/n)
    sources=[dict(taskId=i['task']['id'],observationRecordId=i['observation']['recordId'],
        featureId=i['featureId'],mathRecordIds=i['mathRecordIds']) for i in items]
    metrics={k:round(v,10) for k,v in metrics.items()}
    body=dict(id=identifier,trainingObjects=n,metrics=metrics,evidence=sources,
        headHash=head.state()['parameterHash'],heldoutIncluded=False,
        countsNotMultipliedBySeeds=True,questionsOrPlansSupplied=False)
    return dict(body,frameHash=digest(body))

def strict_json(raw):
    def pairs(p):
        require(len(dict(p))==len(p),'Duplicate JSON keys');return dict(p)
    value=json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda x:(_ for _ in ()).throw(ValueError(x)))
    require(isinstance(value,dict),'One complete JSON object required');return value

def meta_audit(output, frame):
    result=dict(protocol=META_PROTOCOL,accepted=False,status='pending',metric=None,
        quantitativeClaimVerified=False,questionAndPlanAreUntestedStudentHypotheses=True,
        wholeNaturalLanguageCertified=False,frameHash=frame['frameHash'],studentRawHash=digest(output['raw']),
        originalTextRepaired=False,targetQuestionSupplied=False,heldoutMetricsUsed=False)
    if output.get('tokenCapReached'):return dict(result,reason='capped_original')
    try:
        obj=strict_json(output['raw'])
        require(set(obj)=={'question','metric','value','plan'},'Four exact JSON fields required')
        require(isinstance(obj['question'],str) and 0<len(obj['question'])<=180 and
            isinstance(obj['plan'],str) and 0<len(obj['plan'])<=240,'Bounded nonempty student question and plan')
        require(obj['metric'] in METRICS,'Unknown metric')
        require(type(obj['value']) in (int,float) and math.isfinite(obj['value']),'Finite numeric claim')
        result.update(metric=obj['metric'],claim=obj)
        if abs(obj['value']-frame['metrics'][obj['metric']])>5e-5:
            return dict(result,status='rejected',reason='student_numeric_claim_disagrees_with_saved_metrics')
        plans=written_assertions(obj['question']+'\n'+obj['plan'])
        if plans['disproved']:return dict(result,status='rejected',reason='literal_false_equality_in_question_or_plan')
        return dict(result,accepted=True,status='verified_quantitative_claim',quantitativeClaimVerified=True,
                    reason='claim_verified_question_and_plan_remain_hypotheses')
    except (ValueError,TypeError,KeyError):return dict(result,reason='unparsed_or_incomplete_student_original')

def meta_messages(frame, previous=None):
    text=json.dumps(dict(frameId=frame['id'],trainingObjects=frame['trainingObjects'],metrics=frame['metrics']),sort_keys=True)
    if previous:text+='\nYour earlier self-question ZIP, untested plan:\n'+previous['studentRaw']
    return [dict(role='system',content=(
        'Inspect your own measured training record. Choose a weakness to question and an action to test. '
        'Write one compact JSON object with exactly question, metric, value, plan. Choose metric from the '
        'readout and report its measured numeric value to four decimal places; the question and plan are your '
        'own hypotheses, not established facts. Keep question under twelve English words and plan under '
        'sixteen English words. No mathematics exercise, headings, '
        'answer targets or extra text. Finish the object yourself.')),
        dict(role='user',content=text)]

def meta_gain(audit,before,after):
    require([x['taskId'] for x in before['evidence']]==[x['taskId'] for x in after['evidence']],
        'Meta feedback needs the same actual training objects')
    if audit['status']=='rejected':return -1.
    if not audit['accepted']:return 0.
    metric=audit['metric'];return max(-1.,min(1.,2*METRICS[metric]*(after['metrics'][metric]-before['metrics'][metric])))

def fresh_head_proposal(head,before_items,after_items):
    require(len(before_items)==len(after_items) and before_items,'Fresh before and candidate representations required')
    require([r['task'] for r in before_items]==[r['task'] for r in after_items],'Guard tasks changed')
    require([r['outcomes'] for r in before_items]==[r['outcomes'] for r in after_items],
        'Original mathematical outcomes changed')
    require(all(r['task']['split']=='training' for r in before_items+after_items),'Heldout guard is forbidden')
    before=head.state();floors=[]
    for item in before_items:floors.append(sum(p*y for p,y in zip(head.probabilities(item['features'])[1],item['outcomes'])))
    gradient=[0.]*len(head.weights)
    eligible=[r for r in after_items if r['observationAudit']['positiveCreditEligible']]
    for item in eligible:
        ps=head.probabilities(item['features'])[1];expected=sum(p*y for p,y in zip(ps,item['outcomes']))
        for j in range(len(gradient)):
            gradient[j]+=sum(p*(y-expected)*v[j] for p,y,v in zip(ps,item['outcomes'],item['features']))/len(after_items)
    norm=math.sqrt(sum(g*g for g in gradient));require(math.isfinite(norm),'Nonfinite head gradient')
    scale=min(1.,1./max(norm,EPS))
    audit_floor=all((old['observationAudit']['status']!='verified' or new['observationAudit']['status']=='verified') and
        (old['observationAudit']['status']=='rejected' or new['observationAudit']['status']!='rejected')
        for old,new in zip(before_items,after_items))
    trials=[];chosen=None
    for rate in ([.5/(2**i) for i in range(12)] if norm>EPS else [])+[0.]:
        candidate=StableHead([w+rate*scale*g for w,g in zip(head.weights,gradient)]);candidate.updates=head.updates+int(rate>0)
        values=[sum(p*y for p,y in zip(candidate.probabilities(r['features'])[1],r['outcomes'])) for r in after_items]
        floor=audit_floor and all(new>=old-EPS for new,old in zip(values,floors))
        trials.append(dict(rate=rate,expectedByObject=values,perObjectFloor=floor,
            observationFactFloor=audit_floor,meanGain=sum(values)/len(values)-sum(floors)/len(floors)))
        if floor:chosen=candidate;break
    return dict(protocol=GUARD_PROTOCOL,accepted=chosen is not None,headChanged=chosen is not None and chosen.state()!=before,
        beforeState=before,afterState=chosen.state() if chosen else before,trainingTaskIds=[r['task']['id'] for r in before_items],
        beforeFeatureIds=[r['featureId'] for r in before_items],afterFeatureIds=[r['featureId'] for r in after_items],
        floors=floors,lineSearchTrials=trials,eligibleGradientObjects=len(eligible),
        originalTrainingOutcomesReused=True,heldoutIncluded=False,freshObservationsForAllGuardObjects=True,
        cachedOldRepresentationsUsedAsCurrent=False,semanticAndMetadataTransactionGuarded=True,
        heldoutPerformanceGuaranteed=False,numericalTolerance=EPS)

def guard_still_holds(original_head, committed_head, before_items, final_items):
    """Test the actual fixed candidate; never propose another unrecorded step."""
    require(len(before_items)==len(final_items) and before_items,'Final guard rows required')
    require([r['task'] for r in before_items]==[r['task'] for r in final_items] and
        [r['outcomes'] for r in before_items]==[r['outcomes'] for r in final_items],
        'Final guard task or mathematical originals changed')
    require(all(r['task']['split']=='training' for r in before_items+final_items),'Heldout guard forbidden')
    floors=[sum(p*y for p,y in zip(original_head.probabilities(r['features'])[1],r['outcomes'])) for r in before_items]
    actual=[sum(p*y for p,y in zip(committed_head.probabilities(r['features'])[1],r['outcomes'])) for r in final_items]
    facts=all((old['observationAudit']['status']!='verified' or new['observationAudit']['status']=='verified') and
        (old['observationAudit']['status']=='rejected' or new['observationAudit']['status']!='rejected')
        for old,new in zip(before_items,final_items))
    return dict(accepted=facts and all(a>=b-EPS for a,b in zip(actual,floors)),floors=floors,
        actualExpectedByObject=actual,observationFactFloor=facts,headHeldFixed=True,
        beforeHeadHash=original_head.state()['parameterHash'],afterHeadHash=committed_head.state()['parameterHash'],
        beforeFeatureIds=[r['featureId'] for r in before_items],finalFeatureIds=[r['featureId'] for r in final_items],
        numericalTolerance=EPS,heldoutIncluded=False)
