"""TRAIN-only invertible diagonal conditioning of frozen representations.

Reparameterization preserves every starting logit, including unseen inputs.
No rewards, family tags, current outcomes or heldout features fit this transform.
"""
import copy
import math
from zip_management_head_core import require,digest,numeric,representation,validate_head,update

RIDGE_RATIO=.1


def fit_transform(rows):
    require(len(rows)>=2 and len({r['task']['id'] for r in rows})==len(rows),'Unique TRAIN representations required')
    require(all(r['task']['split']=='training' for r in rows),'Heldout cannot fit feature transform')
    vectors=[representation(r['features']) for r in rows];d=len(vectors[0]);n=len(vectors)
    require(all(len(v)==d for v in vectors),'Feature dimensions differ')
    mean=[sum(v[j] for v in vectors)/n for j in range(d)]
    variance=[sum((v[j]-mean[j])**2 for v in vectors)/n for j in range(d)]
    average_variance=sum(variance)/d
    ridge=max(average_variance*RIDGE_RATIO,1e-18)
    base_scale=[math.sqrt(v+ridge) for v in variance]
    # Average TRAIN residual norm squared is 2, matching the two unit-norm
    # action vectors. Zero-variation data remain zero; no distinction invented.
    average_norm=sum(variance[j]/(base_scale[j]**2) for j in range(d))
    magnitude=math.sqrt(average_norm/2) if average_norm>1e-12 else 1.
    scales=[s*magnitude for s in base_scale]
    value=dict(protocol='train-only-diagonal-geometry-v1',mean=mean,scale=scales,
        ridgeRatio=RIDGE_RATIO,ridge=ridge,trainAverageVariance=average_variance,
        trainAverageTransformedNormSquared=2. if average_norm>1e-12 else 0.,
        trainingTaskIds=[r['task']['id'] for r in rows],
        trainingFeatureIds=[r['featureId'] for r in rows],fitUsesRewardValues=False,
        fitUsesFamilyLabels=False,fitUsesHeldoutFeatures=False,invertible=True)
    value['transformHash']=digest(value);return value


def validate_transform(transform):
    require(transform['transformHash']==digest({k:v for k,v in transform.items() if k!='transformHash'}),
            'Changed feature transform')
    require(len(transform['mean'])==len(transform['scale'])>0 and
        all(numeric(v) for v in transform['mean']) and
        all(numeric(v) and v>0 for v in transform['scale']) and
        transform['fitUsesHeldoutFeatures'] is False,'Invalid finite TRAIN transform')


def transformed_features(features,transform):
    validate_transform(transform);v=representation(features)
    require(len(v)==len(transform['mean']),'Transform dimension differs')
    result=[(x-m)/s for x,m,s in zip(v,transform['mean'],transform['scale'])]
    require(all(numeric(x) for x in result),'Nonfinite transformed feature')
    half=len(features[0]);return [result[:half],result[half:]]


def reparameterize(head,transform):
    validate_head(head);validate_transform(transform)
    require(len(head['weights'])==len(transform['mean']),'Transform/head dimension differs')
    # w*x+b == (w*s)*[(x-m)/s] + (b+w*m).
    return dict(weights=[w*s for w,s in zip(head['weights'],transform['scale'])],
        bias=head['bias']+sum(w*m for w,m in zip(head['weights'],transform['mean'])))


def export_raw_head(head,transform):
    validate_head(head);validate_transform(transform)
    raw_weights=[w/s for w,s in zip(head['weights'],transform['scale'])]
    return dict(weights=raw_weights,bias=head['bias']-sum(w*m for w,m in zip(raw_weights,transform['mean'])))


def update_conditioned(head,case,features,learning_rate=2.):
    vector=representation(features);norm2=sum(x*x for x in vector)
    # Keep the current example's effective logit step matched to the raw and
    # global controls: lr * 3 * advantage * p*(1-p). Fixed, reward-independent.
    local_rate=learning_rate*3/(1+norm2)
    row=update(head,case,features,local_rate)
    row.update(baseLearningRate=learning_rate,inputNormSquared=norm2,
        gradientNormCompensation=3/(1+norm2),conditioningFitUsesHeldout=False)
    return row


def geometry_diagnostic(rows,transform):
    def cosine(a,b):
        norms=math.sqrt(sum(x*x for x in a)*sum(x*x for x in b))
        return sum(x*y for x,y in zip(a,b))/norms if norms>1e-18 else None
    raw=[representation(r['features']) for r in rows]
    changed=[representation(transformed_features(r['features'],transform)) for r in rows]
    def stats(vectors):
        values=[cosine(vectors[i],vectors[j]) for i in range(len(vectors)) for j in range(i)]
        finite=[v for v in values if v is not None]
        return dict(pairs=len(values),undefinedZeroVectorPairs=len(values)-len(finite),
            minimum=min(finite) if finite else None,maximum=max(finite) if finite else None,
            mean=sum(finite)/len(finite) if finite else None)
    return dict(trainingObjects=len(rows),rawPairCosines=stats(raw),conditionedPairCosines=stats(changed),
        labelsUsedToFitTransform=False,heldoutIncluded=False,diagnosisProvesUsefulRepresentation=False)
