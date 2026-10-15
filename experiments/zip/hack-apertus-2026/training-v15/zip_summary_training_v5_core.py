"""Compare student originals from one event; learn only from real TRAIN reuse.

Ratings are retrospective assessments, never task outcomes or word rewards.
Context selection is program assistance fitted on frozen TRAIN representations,
not a claim that the student autonomously retrieved a ZIP.
"""
import copy
import math
import re
import time

from zip_summary_training_v4_core import (
    BRANCHES, EVALUATION_ARMS, TRAINING_OBJECTS, HELDOUT_OBJECTS,
    SUMMARY_WRITE_OBJECTS, REWARD_OBJECTS_PER_SUMMARY, MAX_TOKENS,
    SUMMARY_LEARNING_RATE, STRUCTURE_PENALTY, REGRESSION_TOLERANCE,
    require, seal, digest, restore_head, candidate_cards, observation_messages,
    expected_pass, saved_choice, math_messages, audit_math, replay_item,
    guarded_head_update, literal_references, usage_summary)
from zip_summary_training_v3_core import audit_summary as old_audit
from zip_summary_training_v3_core import event_record as old_event
from zip_summary_training_v4_core import validate_summary as validate_older_summary

PROTOCOL = 'lain-zip-experience-summary-training-v5'
TRAINING_OBJECTS = 6
SUMMARY_WRITE_OBJECTS = (1, 4)
CANDIDATES_PER_EVENT = 3
GROUPS_PER_BRANCH = len(SUMMARY_WRITE_OBJECTS)
SUMMARIES_PER_BRANCH = GROUPS_PER_BRANCH * CANDIDATES_PER_EVENT
MAX_GENERATIONS = 98
MAX_FEATURE_BATCHES = 44
GATE_MIN_SIMILARITY = .90
GATE_MARGIN = 1e-6


def seed_for(round_number, number, slot):
    require(type(round_number) is int and 1 <= round_number <= 1000 and
        type(number) is int and 0 <= number <= 20 and type(slot) is int and 0 <= slot < 100,
        'Invalid summary training seed')
    return 4_800_000_000 + round_number * 100_000 + number * 100 + slot


def event_record(task, observation, decision, routes, prior_feedback=None):
    event = old_event(task, observation, decision, routes)
    event.pop('eventHash')
    if prior_feedback is not None:
        require(prior_feedback['rewardObjectSplit'] == 'training' and
            prior_feedback['sourceTaskId'] != task['id'] and
            prior_feedback['completedTrialObjects'] in (0, 2),
            'Only completed earlier TRAIN feedback may enter a new event')
        event['priorTrialEvidence'] = copy.deepcopy(prior_feedback)
    return seal(event, 'eventHash')


def _route_text(route):
    return '\n'.join([
        'Stored rewrite: ' + ('direct attempt' if route['selectedCandidate']['kind'] == 'direct' else
            route['selectedCandidate']['root']['rule']['input'] + ' = ' +
            route['selectedCandidate']['root']['rule']['output']),
        'Whole original response: ' + route['studentOutput']['raw'],
        'Selected-route protocol outcome: ' + ('success' if route['check']['outcomePassed'] else 'failure'),
        'Written equality true: ' + str(route['check']['mathematicallyCorrectWrittenEquality']),
        'Selected stored rule supported: ' + str(route['check']['auditFacts']['selectedToolSupported']),
        'Audited failure reasons: ' + str(route['check']['failureReasons'])])


def summary_messages(event):
    require(event['task']['split'] == 'training', 'Heldout cannot enter summary writing')
    selected = next(r for r in event['routes'] if r['recordId'] == event['selectedRouteRecordId'])
    parts = ['Completed task goal: ' + event['task']['question'],
        'Original observation, an unverified student hypothesis:', event['observation']['studentOutput']['raw']]
    for route in event['routes']:
        if route is selected:continue
        parts += ['Another program-scheduled route, not your actual selection:', _route_text(route)]
    history = event.get('priorTrialEvidence')
    if history:
        parts += ['Earlier summary-use tests, separate from this task outcome:']
        for row in history['candidateEvidence']:
            parts += ['Earlier original candidate: ' + row['studentRaw'],
                'Candidate status: ' + row['status']]
            for m in row['measurements']:
                parts += ['Later TRAIN object: ' + m['rewardTaskExpression'],
                    'Verified-success route probability without that note: ' + str(m['probabilityWithoutSummary']),
                    'With that note: ' + str(m['probabilityWithSummary'])]
        parts += ['The earlier measurements evaluate note reuse. They are not this task\'s success or failure.']
    # The current selected action and result come last. No old student score,
    # speculative causal explanation or teacher-written summary is supplied.
    parts += ['CURRENT EXPERIENCE: the route your selector actually chose:', _route_text(selected),
        'Current task: ' + event['task']['expression']]
    return [dict(role='system', content=(
        'Write one short experience note, at most 30 words, retaining a concrete detail '
        'that may help a later task. Describe the recorded action and evidence accurately. '
        'A task result and the usefulness of a note are different things. '
        'Write your own observation; an uncertain explanation is allowed. Stop after the note.')),
        dict(role='user', content='\n'.join(parts)),
        dict(role='user', content='Write a concrete short note from the CURRENT EXPERIENCE in your own words.')]


def outcome_claims(raw, event):
    """Bounded, unquoted direct assertions; unsupported prose stays unknown."""
    selected = next(r for r in event['routes'] if r['recordId'] == event['selectedRouteRecordId'])
    route_pass = selected['check']['outcomePassed']
    records = []
    subject = r'(?P<subject>(?:(?:the|this|my|current|source|selected|chosen|actual)\s+){0,3}(?:task|attempt|route))'
    outcome = r'(?P<outcome>not\s+(?:successful|solved|completed)|still\s+(?:unsolved|unresolved)|unsolved|unresolved|unsuccessful|successfully\s+(?:completed|solved|rewritten)|successful|solved|failed|passed|succeeded|a\s+failure|a\s+success)'
    pattern = r'(?:^|[.!?\n])\s*' + subject + r'\s+(?:(?:is|was|remains|remained|has\s+been)\s+)?' + outcome + r'\b'
    for match in re.finditer(pattern, raw, re.I):
        text = match['outcome'].lower(); subject_text = match['subject'].lower()
        claimed = not bool(re.search(r'not|unsolved|unresolved|unsuccessful|failed|failure', text))
        # The episode outcome binds the student's chosen route. A successful
        # unchosen counterfactual does not turn a failed chosen action into a
        # successful episode or falsify a note about that failed action.
        actual = route_pass
        records.append(dict(span=[match.start(),match.end()],literal=match.group(0),
            claimedSuccess=claimed,actualSuccess=actual,
            binds='selected_route',sourceRouteRecordIds=[selected['recordId']],
            explicitlyDisproved=claimed != actual,originalTextRepaired=False))
    for match in re.finditer(r'(?:^|[。！？\n])\s*(?:本题|这道题|当前任务|本次任务)(?:仍然|仍|尚)?(?:未解决|没有解决|成功|失败)', raw):
        text=match.group(0);unresolved='未解决' in text or '没有解决' in text
        claimed=not unresolved and '失败' not in text;actual=route_pass
        records.append(dict(span=[match.start(),match.end()],literal=text,claimedSuccess=claimed,
            actualSuccess=actual,binds='selected_route',sourceRouteRecordIds=[selected['recordId']],
            explicitlyDisproved=claimed!=actual,originalTextRepaired=False))
    return records


def audit_summary(output, event):
    audit = old_audit(output, event)
    claims = outcome_claims(output['raw'], event)
    audit['directExperienceOutcomeClaims'] = claims
    if any(c['explicitlyDisproved'] for c in claims):
        audit['reasons'].append('disproved_direct_experience_outcome')
    audit['eligibleForTrial'] = not audit['reasons']
    audit['taskResultAuditCoverage'] = 'bounded_math_results_and_direct_experience_outcome_phrases'
    audit['unknownProseIsNotTruthCertified'] = True
    return audit


def make_summary(row, event, branch):
    require(branch in BRANCHES and row['task'] == event['task'] and row['branch'] == branch and
        row['eventHash'] == event['eventHash'] and row['phase'] == 'experience_summary' and
        type(row['candidateIndex']) is int and 1 <= row['candidateIndex'] <= CANDIDATES_PER_EVENT and
        row['studentPrompt'] == summary_messages(event), 'Summary original or experience binding changed')
    return seal(dict(summaryProtocol=PROTOCOL,
        id='summary-zip-' + digest(dict(source=row['recordId'],event=event['eventHash']))[:20],
        branch=branch,candidateIndex=row['candidateIndex'],sourceRecordId=row['recordId'],
        sourceTaskId=event['task']['id'],studentRaw=row['studentOutput']['raw'],
        studentRawHash=digest(row['studentOutput']['raw']),studentOriginal=copy.deepcopy(row),
        event=copy.deepcopy(event),audit=audit_summary(row['studentOutput'],event),
        hypothesisOnly=True,mathematicalRule=False,hostAuthoredStudentSummary=False,
        programSourceBinding=True,autonomousRetrievalProved=False), 'summaryHash')


def validate_summary(note):
    if note.get('summaryProtocol') != PROTOCOL:return validate_older_summary(note)
    require(note['summaryHash'] == digest({k:v for k,v in note.items() if k!='summaryHash'}), 'Summary hash changed')
    e=note['event']
    require(e == event_record(e['task'],e['observation'],e['decision'],e['routes'],e.get('priorTrialEvidence')) and
        make_summary(note['studentOriginal'],e,note['branch'])==note, 'Summary source, audit or words changed')


def make_group(notes):
    require(len(notes)==CANDIDATES_PER_EVENT and [n['candidateIndex'] for n in notes]==[1,2,3],
        'A writing event requires three scheduled independent originals')
    for note in notes:validate_summary(note)
    first=notes[0]
    require(all(n['branch']==first['branch'] and n['event']==first['event'] and
        n['studentOriginal']['studentOutput']['sampled'] is True and
        n['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration']==
            first['studentOriginal']['studentOutput']['summaryStateHashDuringGeneration'] for n in notes),
        'Candidates must share the same event and unchanged sampled writer')
    return seal(dict(id='summary-group-'+digest([n['id'] for n in notes])[:20],branch=first['branch'],
        sourceTaskId=first['sourceTaskId'],candidateSummaryZipIds=[n['id'] for n in notes],
        sourceEventHash=first['event']['eventHash'],candidatesPerEvent=3,
        candidateSamplingIndependent=True,hostAuthoredStudentText=False), 'groupHash')


def summary_credit(note, task, without, with_note, feature_ids, observation_ids, observation_seed):
    validate_summary(note)
    require(note['audit']['eligibleForTrial'] and task['split']=='training' and task['id']!=note['sourceTaskId'],
        'Only eligible notes and later TRAIN objects may receive reuse credit')
    require(all(type(v) in (int,float) and math.isfinite(v) and 0<=v<=1 for v in (without,with_note)), 'Invalid reuse probabilities')
    require(set(feature_ids)==set(observation_ids)=={'without','withSummary'} and
        all(isinstance(v,str) and v for v in list(feature_ids.values())+list(observation_ids.values())) and
        type(observation_seed) is int,'Unbound full-path evidence')
    return dict(sourceSummaryZipId=note['id'],sourceWordRecordId=note['sourceRecordId'],sourceTaskId=note['sourceTaskId'],
        rewardTaskId=task['id'],probabilityWithoutSummary=without,probabilityWithSummary=with_note,
        signedFullReuseGain=with_note-without,rewardObjectSplit='training',
        featureIds=copy.deepcopy(feature_ids),observationIds=copy.deepcopy(observation_ids),
        pairedObservationSeed=observation_seed,sameHeadBeforeUpdates=True,
        includesObservationGenerationAndCardContext=True,observationDecodingMode='greedy',
        candidateWasIsolatedFromOperativeReplay=True,proseTruthCertified=False)


def aggregate_credit(note, measurements):
    validate_summary(note)
    require(len(measurements)==2 and len({m['rewardTaskId'] for m in measurements})==2 and
        len({m['rewardTaskFamily'] for m in measurements})==2,'Two predetermined distinct TRAIN structures required')
    for m in measurements:
        rebuilt=summary_credit(note,dict(id=m['rewardTaskId'],split=m['rewardObjectSplit']),
            m['probabilityWithoutSummary'],m['probabilityWithSummary'],m['featureIds'],m['observationIds'],m['pairedObservationSeed'])
        require(all(m.get(k)==v for k,v in rebuilt.items()),'Changed or unpaired reuse evidence')
    gain=sum(m['signedFullReuseGain'] for m in measurements)/2
    return dict(sourceSummaryZipId=note['id'],sourceWordRecordId=note['sourceRecordId'],
        sourceTaskId=note['sourceTaskId'],rewardObjectSplit='training',measurements=copy.deepcopy(measurements),
        rewardTaskIds=[m['rewardTaskId'] for m in measurements],rewardObjects=2,
        signedFullReuseGain=gain,worstFullReuseGain=min(m['signedFullReuseGain'] for m in measurements),
        eligibleForRetention=gain>REGRESSION_TOLERANCE,unconditionalMeanPositiveRequired=True,
        contextGateCannotTurnNegativeMeanIntoPositiveWritingCredit=True)


def group_credit(group, notes, measurements):
    require(make_group(notes)==group and set(measurements)=={n['id'] for n in notes}, 'Changed candidate group')
    credits={}
    for note in notes:
        if note['audit']['eligibleForTrial']:
            credits[note['id']]=aggregate_credit(note,measurements[note['id']])
        else:
            require(not measurements[note['id']], 'An ineligible original was tested as usable context')
            credits[note['id']]=dict(sourceSummaryZipId=note['id'],sourceWordRecordId=note['sourceRecordId'],
                sourceTaskId=note['sourceTaskId'],rewardObjectSplit='training',measurements=[],rewardObjects=0,
                signedFullReuseGain=None,eligibleForRetention=False,reason='separate_completion_or_disproved_fact_penalty',
                audit=copy.deepcopy(note['audit']))
    ranked=sorted((n for n in notes if n['audit']['eligibleForTrial']),
        key=lambda n:(-credits[n['id']]['signedFullReuseGain'],n['candidateIndex']))
    winner=ranked[0]['id'] if ranked and credits[ranked[0]['id']]['eligibleForRetention'] else None
    for note in notes:
        c=credits[note['id']];gain=c['signedFullReuseGain']
        if gain is None:a=STRUCTURE_PENALTY
        elif note['id']==winner or gain<0:a=max(-1.,min(1.,2*gain))
        else:a=0.
        c.update(advantage=a,selectedForContext=note['id']==winner,
            positiveCreditRequiresActualPositiveMean=True,positiveRewardFromSelfRating=False,
            positiveRewardFromCitationVolume=False)
    return dict(id=group['id'],groupId=group['id'],branch=group['branch'],sourceTaskId=group['sourceTaskId'],
        candidateSummaryZipIds=group['candidateSummaryZipIds'],candidateCredits=credits,
        rankedEligibleSummaryZipIds=[n['id'] for n in ranked],selectedSummaryZipId=winner,
        rewardObjectSplit='training',completedTrialObjects=2 if ranked else 0,
        batchAdvantages=[credits[n['id']]['advantage'] for n in notes],
        worstCandidateIsNotTeacherTarget=True,bestOfBadCandidatesCannotReceivePositiveCredit=True,
        usesHeldoutFeedback=False)


def history_evidence(notes, credit):
    return dict(groupId=credit['groupId'],sourceTaskId=credit['sourceTaskId'],rewardObjectSplit='training',
        completedTrialObjects=credit['completedTrialObjects'],selectedSummaryZipId=credit['selectedSummaryZipId'],
        candidateEvidence=[dict(summaryZipId=n['id'],studentRaw=n['studentRaw'],
            status='selected_after_positive_mean' if n['id']==credit['selectedSummaryZipId'] else
                'failed_factual_or_completion_audit' if not n['audit']['eligibleForTrial'] else 'not_selected_after_trial',
            measurements=copy.deepcopy(credit['candidateCredits'][n['id']]['measurements']))
            for n in notes if n['audit']['eligibleForTrial']],
        studentSelfScoresSuppliedToNextSummaryWriter=False)


def feature_similarity(a, b):
    require(len(a)==len(b)==3 and all(len(x)==len(y)>0 for x,y in zip(a,b)), 'Gate feature shape differs')
    values=[]
    for x,y in zip(a,b):
        require(all(type(v) in (int,float) and math.isfinite(v) for v in list(x)+list(y)), 'Nonfinite gate feature')
        nx=math.sqrt(sum(v*v for v in x));ny=math.sqrt(sum(v*v for v in y))
        values.append(sum(v*w for v,w in zip(x,y))/(nx*ny) if nx*ny else 0.)
    return sum(values)/3


def fit_context_gate(note, cases, head):
    validate_summary(note)
    require(len(cases)==2 and all(c['task']['split']=='training' for c in cases), 'Gate needs two TRAIN cases')
    evidence=[]
    for c in cases:
        p=expected_pass(head,c['without'],c['outcomes'])[0];q=expected_pass(head,c['withSummary'],c['outcomes'])[0]
        evidence.append(dict(case=copy.deepcopy(c),probabilityWithoutSummary=p,probabilityWithSummary=q,signedGain=q-p))
    mean=sum(c['signedGain'] for c in evidence)/2
    return seal(dict(id=note['id'],summaryZipId=note['id'],branch=note['branch'],
        evidence=evidence,trainingMeanGain=mean,admitted=mean>REGRESSION_TOLERANCE,
        headHashAtFit=head.state()['parameterHash'],minimumSimilarity=GATE_MIN_SIMILARITY,tieMargin=GATE_MARGIN,
        method='nearest_frozen_training_representation_with_positive_measured_gain',
        manualTaskFamilyUsed=False,studentAutonomousRetrieval=False,usesHeldoutFeedback=False,
        wholeProseTruthCertified=False), 'gateHash')


def validate_gate(gate, note=None):
    require(gate['gateHash']==digest({k:v for k,v in gate.items() if k!='gateHash'}) and
        len(gate['evidence'])==2 and all(e['case']['task']['split']=='training' for e in gate['evidence']) and
        gate['minimumSimilarity']==GATE_MIN_SIMILARITY and gate['tieMargin']==GATE_MARGIN and
        gate['manualTaskFamilyUsed'] is False and gate['usesHeldoutFeedback'] is False,
        'Context gate evidence or policy changed')
    if note:require(gate['summaryZipId']==note['id'] and gate['branch']==note['branch'], 'Gate belongs to another ZIP')


def context_decision(task, plain, gate):
    if gate is None:
        return dict(id=task['id']+'-context',taskId=task['id'],selectedSummaryZipId=None,
            gateHash=None,similarities=[],reason='no_accepted_context',currentOutcomeRead=False,
            manualTaskFamilyUsed=False,studentAutonomousRetrieval=False)
    validate_gate(gate)
    sims=[feature_similarity(plain,e['case']['without']) for e in gate['evidence']]
    positives=[i for i,e in enumerate(gate['evidence']) if e['signedGain']>REGRESSION_TOLERANCE]
    negatives=[i for i,e in enumerate(gate['evidence']) if e['signedGain']<=REGRESSION_TOLERANCE]
    best=max(positives,key=lambda i:sims[i]) if positives else None
    against=max((sims[i] for i in negatives),default=-1.)
    use=bool(gate['admitted'] and best is not None and sims[best]>=GATE_MIN_SIMILARITY and
        sims[best]>against+GATE_MARGIN)
    return dict(id=task['id']+'-context',taskId=task['id'],selectedSummaryZipId=gate['summaryZipId'] if use else None,
        gateHash=gate['gateHash'],similarities=sims,reason='positive_training_neighbour' if use else 'abstain_outside_positive_evidence',
        currentOutcomeRead=False,manualTaskFamilyUsed=False,studentAutonomousRetrieval=False)


def rating_messages(note, credit):
    selected=next(r for r in note['event']['routes'] if r['recordId']==note['event']['selectedRouteRecordId'])
    parts=['TASK RESULT (already observed, not a quality score):',
        'Source task: '+note['event']['task']['expression'],
        'Selected-route protocol outcome: '+('success' if selected['check']['outcomePassed'] else 'failure'),
        'NOTE TO ASSESS:',note['studentRaw'],'NOTE REUSE EVIDENCE ON TWO LATER TRAIN TASKS:']
    for m in credit['measurements']:
        parts += ['Object: '+m['rewardTaskExpression'],
            'Verified-success route probability without note: '+str(m['probabilityWithoutSummary']),
            'With note: '+str(m['probabilityWithSummary'])]
    return [dict(role='system',content=(
        'Briefly assess this note using its recorded reuse tests. You may optionally add '
        'Score: and a number from 0 to 1 for your assessment of this note\'s quality. '
        'The task outcome and note quality are separate. This is a retrospective student '
        'assessment, not a forecast or a certified explanation.')),
        dict(role='user',content='\n'.join(parts))]


def make_rating(note, row, credit):
    require(row['studentPrompt']==rating_messages(note,credit) and row['summaryZipId']==note['id'] and
        row['branch']==note['branch'] and row['task']==note['event']['task'] and
        row['phase']=='summary_quality_assessment', 'Quality assessment binding changed')
    raw=row['studentOutput']['raw'];ended=row['studentOutput'].get('stopReason')=='eos' and not row['studentOutput'].get('tokenCapReached')
    matches=list(re.finditer(r'(?im)(?:^|[.;\n])\s*(?:quality\s+)?score\s*:\s*([^\s,;]+)',raw))
    score=None;span=None
    if ended and len(matches)==1:
        literal=matches[0][1].rstrip('.')
        if re.fullmatch(r'(?:0(?:\.\d+)?|1(?:\.0+)?)',literal):
            score=float(literal);span=[matches[0].start(1),matches[0].start(1)+len(literal)]
    return dict(id=note['id'],branch=note['branch'],sourceSummaryZipId=note['id'],sourceRatingRecordId=row['recordId'],
        studentRaw=raw,studentRawHash=digest(raw),literalScoreSpan=span,studentQualityScore=score,
        retrospectiveAssessment=True,forecastCalibrationPerformed=False,studentRatingCertifiesQuality=False,
        ratingUsedAsReward=False,ratingUsedToSelectCandidate=False,separateRatingOptimizerUpdates=0,
        sourceTrainingTaskIds=credit['rewardTaskIds'],originalTextRepaired=False)


def run_course(plan, roots, initial_heads, ask, feature, save, learn_group, select_branch,
        store_summary, read_summary, checkpoint, deadline, round_number, initial_banks=None, initial_gates=None):
    require(len(plan['training'])==TRAINING_OBJECTS and len(plan['heldout'])==HELDOUT_OBJECTS and
        all(t['split']=='training' for t in plan['training']) and all(t['split']=='heldout' for t in plan['heldout']), 'Course split changed')
    require(all(len({plan['training'][n+i]['family'] for i in range(2)})==2 for n in SUMMARY_WRITE_OBJECTS), 'Trial schedule changed')
    heads={b:restore_head(copy.deepcopy(initial_heads[b])) for b in BRANCHES}
    banks=copy.deepcopy(initial_banks or {b:None for b in BRANCHES})
    gates=copy.deepcopy(initial_gates or {b:None for b in BRANCHES})
    for b in BRANCHES:
        require(bool(banks[b])==bool(gates[b]), 'Accepted context lacks fitted TRAIN gate')
        if gates[b]:validate_gate(gates[b],read_summary(banks[b]))
    accepted_pool={b:[copy.deepcopy(gates[b])] if gates[b] else [] for b in BRANCHES}
    pending={b:None for b in BRANCHES};feedback={b:None for b in BRANCHES};replay={b:[] for b in BRANCHES}
    objects=[];updates=[];notes=[];groups=[];results=[];ratings=[];refs=[];reviews=[]
    original_roots=copy.deepcopy(roots)

    def remaining():
        if time.monotonic()>=deadline:raise TimeoutError('Summary deadline before next action')

    def cp(label):checkpoint(label,{b:h.state() for b,h in heads.items()},banks,gates)

    def routes_for(task,number):
        rows=[]
        for card in candidate_cards(roots):
            remaining()
            row=ask('route_math',math_messages(task,card,roots),seed_for(round_number,number,20),
                mode='math',sampled=False,task=task,selectedCandidate=copy.deepcopy(card),hostSpecifiedRoute=True,
                autonomousToolUseClaimed=False)
            row=dict(row,check=audit_math(task,row['studentOutput'],card));save('scored',row);rows.append(row)
            if not row['check']['outcomePassed']:save('failure',dict(row,id=row['recordId']))
        return rows

    def finish_group(b,p,number,task):
        remaining();select_branch(b)
        credit=group_credit(p['group'],p['notes'],p['measurements'])
        update=learn_group(p['notes'],credit,'candidate_group_feedback')
        winner=credit['selectedSummaryZipId'];old=banks[b];activated=None
        if winner:
            chosen=next(n for n in p['notes'] if n['id']==winner)
            gate=fit_context_gate(chosen,p['cases'][winner],heads[b])
            save('context-gate',gate)
            if gate['admitted']:
                banks[b]=winner;gates[b]=gate;activated=winner
                accepted_pool[b].append(copy.deepcopy(gate))
        row=dict(credit,decidedAfterTrainingTaskId=task['id'],firstEligibleOperativeObjectNumber=number+1,
            activatedSummaryZipId=activated,candidatePassedCurrentHeadGuard=activated is not None,
            previousAcceptedSummaryZipId=old,activeAfterDecision=banks[b],summaryUpdate=update,
            candidateFeatureEnteredOperativeReplay=False,currentObjectDecisionUnchanged=True)
        save('group-result',row);results.append(row)
        # A read-only saved-course replay may canonicalize bounded floating
        # reductions here. Ordinary saves preserve these values unchanged.
        credit.update({k:copy.deepcopy(row[k]) for k in credit})
        feedback[b]=history_evidence(p['notes'],credit)
        # One assessment per completed eligible group, AFTER evidence exists.
        best=credit['rankedEligibleSummaryZipIds'][0] if credit['rankedEligibleSummaryZipIds'] else None
        if best:
            remaining();note=next(n for n in p['notes'] if n['id']==best)
            rating_row=ask('summary_quality_assessment',rating_messages(note,credit['candidateCredits'][best]),
                seed_for(round_number,number,40),mode='summary',sampled=False,task=note['event']['task'],
                branch=b,summaryZipId=best,sourceGroupId=credit['groupId'])
            rating=make_rating(note,rating_row,credit['candidateCredits'][best]);save('scored',dict(rating_row,check=rating))
            save('summary-rating',rating);ratings.append(rating)
        pending[b]=None
        return credit,update

    cp('initial')
    for number,task in enumerate(plan['training'],1):
        remaining();select_branch(BRANCHES[0]);cache={}
        plain_row=ask('training_observation_without_summary',observation_messages(task,roots),seed_for(round_number,number,1),
            mode='observation',sampled=False,task=task,branch='shared_without_summary',summaryZipId=None)
        save('scored',dict(plain_row,check=dict(originalPreserved=True,explanationCertified=False,sharedNoSummaryBaseline=True)))
        plain,plain_id=feature(task,plain_row,candidate_cards(roots))
        route_context=context_decision(task,plain,gates[BRANCHES[0]]);save('context-choice',route_context)

        def probe(note,b,role):
            if note is None:return plain,plain_id,plain_row
            if note['id'] not in cache:
                remaining();select_branch(b);require(read_summary(note['id'])==note,'ZIP original changed during trial')
                row=ask('training_observation_with_summary',observation_messages(task,roots,note),seed_for(round_number,number,1),
                    mode='observation',sampled=False,task=task,branch=b,summaryZipId=note['id'],contextRoleAtGeneration=role,
                    counterfactualCriticOnly=role!='operative_context')
                save('scored',dict(row,check=dict(originalPreserved=True,explanationCertified=False,counterfactualCriticOnly=role!='operative_context')))
                vec,fid=feature(task,row,candidate_cards(roots,note));cache[note['id']]=(vec,fid,row)
            vec,fid,row=cache[note['id']];ref=literal_references(note,row,role);save('zip-reference',ref);refs.append(ref)
            return vec,fid,row

        contexts={BRANCHES[0]:read_summary(route_context['selectedSummaryZipId']) if route_context['selectedSummaryZipId'] else None,
            BRANCHES[1]:None}
        operative={b:probe(contexts[b],b,'operative_context') for b in BRANCHES}
        decisions=[]
        for b in BRANCHES:
            vec,fid,row=operative[b]
            decision=saved_choice(task,b,vec,candidate_cards(roots,contexts[b]),heads[b],seed_for(round_number,number,10),1,row['recordId'],fid)
            save('decision',decision);decisions.append(decision)
        trial_probes={}
        for b in BRANCHES:
            if pending[b]:
                for note in pending[b]['notes']:
                    if note['audit']['eligibleForTrial']:trial_probes[note['id']]=probe(note,b,'candidate_trial')
        routes=routes_for(task,number);outcomes=[int(r['check']['outcomePassed']) for r in routes];math_ids=[r['recordId'] for r in routes]
        obj=dict(id=task['id'],task=copy.deepcopy(task),phase='training',routeOutcomes=outcomes,sourceMathRecordIds=math_ids,
            expectedPassByArm={b:expected_pass(heads[b],operative[b][0],outcomes)[0] for b in BRANCHES},
            featureIdsByArm={b:operative[b][1] for b in BRANCHES},observationRecordIdsByArm={b:operative[b][2]['recordId'] for b in BRANCHES},
            sourceSummaryIdsByArm={b:contexts[b]['id'] if contexts[b] else None for b in BRANCHES},
            candidateGroupIdsByBranch={b:pending[b]['group']['id'] if pending[b] else None for b in BRANCHES},
            allChoicesSavedBeforeRoutes=True,candidateTrialIsolatedFromOperativeReplay=True)
        save('object',obj);objects.append(obj)
        for b,decision in zip(BRANCHES,decisions):
            remaining();select_branch(b);p=pending[b];measurements=[];credit=None
            word_update=dict(updated=False,parameterChanged=False,reason='no_completed_candidate_group')
            if p:
                for note in p['notes']:
                    if not note['audit']['eligibleForTrial']:continue
                    vec,fid,row=trial_probes[note['id']]
                    m=summary_credit(note,task,expected_pass(heads[b],plain,outcomes)[0],expected_pass(heads[b],vec,outcomes)[0],
                        dict(without=plain_id,withSummary=fid),dict(without=plain_row['recordId'],withSummary=row['recordId']),seed_for(round_number,number,1))
                    m.update(rewardObjectNumber=number,rewardTaskFamily=task['family'],rewardTaskExpression=task['expression'],sourceMathRecordIds=math_ids)
                    p['measurements'][note['id']].append(m);measurements.append(m)
                    p['cases'][note['id']].append(dict(task=copy.deepcopy(task),without=copy.deepcopy(plain),withSummary=copy.deepcopy(vec),
                        outcomes=list(outcomes),featureIds=m['featureIds'],sourceMathRecordIds=math_ids))
                    save('group-measurement',dict(m,id=note['id']+'-'+task['id']))
                p['seenTasks'].append(task['id'])
                if len(p['seenTasks'])==2:credit,word_update=finish_group(b,p,number,task)
            replay[b].append(replay_item(task,operative[b][0],outcomes,operative[b][1],math_ids))
            head_update=guarded_head_update(heads[b],replay[b],number)
            update=dict(id=b+'-'+str(number),taskId=task['id'],branch=b,completedGroupCredit=credit,
                summaryUpdate=word_update,headUpdate=head_update,summaryMeasurements=measurements,
                operativeSummaryZipId=obj['sourceSummaryIdsByArm'][b],candidateWasIsolatedFromOperativeReplay=True)
            save('update',update);updates.append(update)
            heads[b]=restore_head(update['headUpdate']['afterState'])
            chosen=next(r for r in routes if r['selectedCandidate']['id']==decision['selectedCandidate']['id'])
            save('trial',dict(id=decision['id'],taskId=task['id'],phase='training',arm=b,decisionId=decision['id'],
                sourceMathRecordId=chosen['recordId'],outcomePassed=chosen['check']['outcomePassed']))
            if number in SUMMARY_WRITE_OBJECTS:
                require(pending[b] is None,'Writer still has unevaluated originals');new=[]
                event=event_record(task,operative[b][2],decision,routes,feedback[b])
                for index in range(1,CANDIDATES_PER_EVENT+1):
                    remaining()
                    row=ask('experience_summary',summary_messages(event),seed_for(round_number,number,30+index),mode='summary',
                        sampled=True,task=task,branch=b,eventHash=event['eventHash'],candidateIndex=index)
                    note=make_summary(row,event,b);save('scored',dict(row,check=copy.deepcopy(note['audit'])))
                    store_summary(note);save('summary',note);notes.append(note);new.append(note)
                group=make_group(new);save('summary-group',group);groups.append(group)
                pending[b]=dict(group=group,notes=new,measurements={n['id']:[] for n in new},cases={n['id']:[] for n in new},seenTasks=[])
                if not any(n['audit']['eligibleForTrial'] for n in new):finish_group(b,pending[b],number,task)
            cp('after-'+str(number)+'-'+b)
        require(roots==original_roots,'Original mathematical roots changed')
    require(all(p is None for p in pending.values()),'Incomplete scheduled candidate group window')
    for b in BRANCHES:
        banks[b]=None;gates[b]=None
        for earlier_gate in reversed(accepted_pool[b]):
            note=read_summary(earlier_gate['summaryZipId']);cases=[e['case'] for e in earlier_gate['evidence']]
            reviewed=fit_context_gate(note,cases,heads[b])
            review=dict(id=note['id'],branch=b,summaryZipId=note['id'],gate=reviewed,retainedForHeldout=reviewed['admitted'],
                usesTrainingEvidenceOnly=True,writerUpdatedAgain=False,newStudentGenerations=0,oldScoresChanged=False)
            save('summary-context-review',review);reviews.append(review)
            if review['retainedForHeldout']:
                banks[b]=note['id'];gates[b]=review['gate'];break
    cp('training-final');frozen_heads={b:h.state() for b,h in heads.items()};frozen_banks=copy.deepcopy(banks);frozen_gates=copy.deepcopy(gates)
    prior={b:restore_head(initial_heads[b]) for b in BRANCHES}
    for number,task in enumerate(plan['heldout'],TRAINING_OBJECTS+1):
        remaining();select_branch(BRANCHES[0])
        plain_row=ask('heldout_observation_without_summary',observation_messages(task,roots),seed_for(round_number,number,1),
            mode='observation',sampled=False,task=task,summaryZipId=None)
        save('scored',dict(plain_row,check=dict(originalPreserved=True,sharedNoSummaryBaseline=True,heldoutTrainingUpdates=0)))
        plain,plain_id=feature(task,plain_row,candidate_cards(roots))
        context=context_decision(task,plain,gates[BRANCHES[0]]);save('context-choice',context)
        note=read_summary(context['selectedSummaryZipId']) if context['selectedSummaryZipId'] else None
        if note:
            row=ask('heldout_observation_with_summary',observation_messages(task,roots,note),seed_for(round_number,number,1),
                mode='observation',sampled=False,task=task,summaryZipId=note['id'])
            save('scored',dict(row,check=dict(originalPreserved=True,heldoutTrainingUpdates=0)))
            noted,noted_id=feature(task,row,candidate_cards(roots,note))
            ref=literal_references(note,row,'operative_context');save('zip-reference',ref);refs.append(ref)
        else:row=plain_row;noted,noted_id=plain,plain_id
        vecs={a:noted if a==BRANCHES[0] else plain for a in EVALUATION_ARMS}
        arm_heads={BRANCHES[0]:heads[BRANCHES[0]],BRANCHES[1]:heads[BRANCHES[1]],EVALUATION_ARMS[2]:heads[BRANCHES[0]],
            EVALUATION_ARMS[3]:prior[BRANCHES[0]],EVALUATION_ARMS[4]:prior[BRANCHES[1]]}
        decisions=[]
        for index in (1,2,3):
            for arm in EVALUATION_ARMS:
                obs=row if arm==BRANCHES[0] else plain_row
                decision=saved_choice(task,arm,vecs[arm],candidate_cards(roots,note if arm==BRANCHES[0] else None),arm_heads[arm],
                    seed_for(round_number,number,50+index),index,obs['recordId'],noted_id if arm==BRANCHES[0] else plain_id)
                save('decision',decision);decisions.append(decision)
        routes=routes_for(task,number);outcomes=[int(r['check']['outcomePassed']) for r in routes]
        probabilities={a:expected_pass(arm_heads[a],vecs[a],outcomes)[1] for a in EVALUATION_ARMS}
        expected={a:sum(p*y for p,y in zip(probabilities[a],outcomes)) for a in EVALUATION_ARMS}
        obj=dict(id=task['id'],task=copy.deepcopy(task),phase='heldout',routeOutcomes=outcomes,sourceMathRecordIds=[r['recordId'] for r in routes],
            expectedPassByArm=expected,probabilitiesByArm=probabilities,primaryPairedDifference=expected[BRANCHES[0]]-expected[BRANCHES[1]],
            sameHeadSummaryAblationDifference=expected[BRANCHES[0]]-expected[EVALUATION_ARMS[2]],
            featureIdsByArm={a:noted_id if a==BRANCHES[0] else plain_id for a in EVALUATION_ARMS},
            observationRecordIdsByArm={a:row['recordId'] if a==BRANCHES[0] else plain_row['recordId'] for a in EVALUATION_ARMS},
            summaryZipId=note['id'] if note else None,allChoicesSavedBeforeRoutes=True,trainingUpdates=0)
        save('object',obj);objects.append(obj)
        for decision in decisions:
            chosen=next(r for r in routes if r['selectedCandidate']['id']==decision['selectedCandidate']['id'])
            save('trial',dict(id=decision['id'],taskId=task['id'],phase='heldout',arm=decision['arm'],seedIndex=decision['seedIndex'],
                decisionId=decision['id'],sourceMathRecordId=chosen['recordId'],outcomePassed=chosen['check']['outcomePassed'],noExtraGenerationForSeedTrial=True))
        require({b:h.state() for b,h in heads.items()}==frozen_heads and banks==frozen_banks and gates==frozen_gates,
            'Heldout changed learned states or fitted context gate')
    cp('final')
    return dict(finalHeads={b:h.state() for b,h in heads.items()},finalBanks=banks,finalGates=gates,objects=objects,
        updates=updates,summaries=notes,groups=groups,groupResults=results,ratings=ratings,references=refs,
        retentionReviews=reviews,heldoutStateUnchanged=True)


def summarize(objects,trials,notes,updates,group_results,ratings=(),references=(),retention_reviews=()):
    held=[o for o in objects if o['phase']=='heldout'];n=len(held)
    means={a:sum(o['expectedPassByArm'][a] for o in held)/n if n else None for a in EVALUATION_ARMS}
    def difference(a,b):return means[a]-means[b] if n else None
    credits=[c for g in group_results for c in g['candidateCredits'].values()]
    return dict(primaryMetric='probability mass on all actually verified successful method routes',heldoutObjects=n,
        expectedPassByArm=means,reuseMinusSeal=difference(*BRANCHES),sameHeadWithMinusWithoutSummary=difference(BRANCHES[0],EVALUATION_ARMS[2]),
        preRoundHeadGapWithoutSummaries=difference(EVALUATION_ARMS[3],EVALUATION_ARMS[4]),
        branchGapChangeFromFrozenPreRoundHeads=(difference(*BRANCHES)-difference(EVALUATION_ARMS[3],EVALUATION_ARMS[4])) if n else None,
        reuseHeadChangeWithSummaryRemoved=difference(EVALUATION_ARMS[2],EVALUATION_ARMS[3]),
        sealHeadChangeWithoutSummary=difference(BRANCHES[1],EVALUATION_ARMS[4]),
        heldoutByFamily={f:dict(objects=len(rows),expectedPassByArm={a:sum(o['expectedPassByArm'][a] for o in rows)/len(rows) for a in EVALUATION_ARMS})
            for f in sorted({o['task']['family'] for o in held}) if (rows:=[o for o in held if o['task']['family']==f])},
        byObject=[dict(taskId=o['id'],expression=o['task']['expression'],routeOutcomes=o['routeOutcomes'],
            primaryPairedDifference=o['primaryPairedDifference'],sameHeadSummaryAblationDifference=o['sameHeadSummaryAblationDifference'],summaryZipId=o['summaryZipId']) for o in held],
        studentWrittenSummaries=len(notes),eligibleHypothesisZips=sum(n['audit']['eligibleForTrial'] for n in notes),
        distinctCandidateOriginalTexts=len({n['studentRaw'] for n in notes}),uniqueSummarySourceTasks=len({n['sourceTaskId'] for n in notes}),
        candidateSamplesAreNotIndependentExperienceEvents=True,
        completedCandidateGroups=len(group_results),completedTwoTaskGroups=sum(g['completedTrialObjects']==2 for g in group_results),
        candidatesPerEvent=CANDIDATES_PER_EVENT,writingEventsPerBranch=GROUPS_PER_BRANCH,
        completionOrFactPenaltyCredits=sum(c['signedFullReuseGain'] is None for c in credits),
        measuredPositiveCandidateCredits=sum(c['signedFullReuseGain'] is not None and c['advantage']>1e-12 for c in credits),
        measuredNegativeCandidateCredits=sum(c['signedFullReuseGain'] is not None and c['advantage']<-1e-12 for c in credits),
        neutralCandidateCredits=sum(abs(c['advantage'])<=1e-12 for c in credits),
        selectedCandidateGroups=sum(g['selectedSummaryZipId'] is not None for g in group_results),
        activatedCandidateGroups=sum(g['activatedSummaryZipId'] is not None for g in group_results),
        cappedSummaries=sum(not n['audit']['actualEos'] for n in notes),
        summariesWithKnownContradictions=sum(any('disproved' in r or 'conflict' in r for r in n['audit']['reasons']) for n in notes),
        taskResultAuditCoverage='bounded_literal_results_and_direct_outcome_phrases; unknown prose remains unverified',
        candidateTrials=sum(r['scheduledCriticProbe'] for r in references),operativeSummaryContextUses=sum(r['operativeContextUse'] for r in references),
        studentExplicitReferences=len({r['sourceObservationRecordId'] for r in references if r['studentExplicitReference']}),autonomousZipSelections=0,
        summaryQualityAssessmentsReturned=len(ratings),literalStudentQualityScores=sum(r['studentQualityScore'] is not None for r in ratings),
        ratingsAreRetrospectiveNotForecasts=True,separateRatingOptimizerUpdates=0,citationVolumeUsedAsPositiveReward=False,selfRatingUsedAsPositiveReward=False,
        choiceHeadUpdatesByBranch={b:sum(u['headUpdate']['updated'] for u in updates if u['branch']==b) for b in BRANCHES},
        actualSummaryOptimizerUpdatesByBranch={b:sum(g['summaryUpdate']['updated'] for g in group_results if g['branch']==b) for b in BRANCHES},
        candidateTrialsIsolatedFromOperativeReplay=True,contextGateLearnedFromFrozenTrainingFeatures=True,manualFamilyUsedForGate=False,
        positiveCreditRequiresPositiveUngatedMean=True,contextGateCannotCreatePositiveWordCreditFromNegativeMean=True,
        finalRetentionUsesTrainingEvidenceUnderFinalHead=True,uniqueZipEncodingEffectIsolated=False,wholeProseTruthCertified=False,
        sampledHeldoutOutcomesByArm={a:dict(trials=len(ts),passes=sum(t['outcomePassed'] for t in ts)) for a in EVALUATION_ARMS
            if (ts:=[t for t in trials if t['phase']=='heldout' and t['arm']==a]) or True},
        seedSamplesNotIndependentObjects=True,independentTrainingReplications=0,trainingAndHeldoutObservationDecodingMode='greedy',
        autonomousRetrievalProved=False,fullAutonomousLearningProved=False,structuralGeneralizationProved=False,statisticalSignificanceClaimed=False,
        newStandaloneMathematicalRules=0,oldScoresChanged=False,matchedTrainingOpportunityBudgets=True,actualUpdateCountsMayDiffer=True,
        branchGapIncludesCumulativeHistory=True,byGroup=[dict(groupId=g['groupId'],branch=g['branch'],selectedSummaryZipId=g['selectedSummaryZipId'],
            candidates=[dict(summaryZipId=i,meanGain=c['signedFullReuseGain'],advantage=c['advantage'],eligibleForRetention=c['eligibleForRetention'])
                for i,c in g['candidateCredits'].items()]) for g in group_results])
