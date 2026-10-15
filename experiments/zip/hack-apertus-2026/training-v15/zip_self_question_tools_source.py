"""Bind the v4 experience journal to all original, independently audited routes."""
import copy
from pathlib import Path

from draft_inspect_runtime import read
from zip_label_feedback_audit import audit_math
from zip_label_metacognitive_checks import fact_audit, require
from zip_self_question_tools_core import make_bundle


def load_bundle(resume):
    parent = Path(resume['folder'])
    routes = {}
    provenance = {}
    for anchor in resume['anchors']:
        require(anchor['task']['split'] == 'training', 'Heldout cannot enter an experience journal')
        require(fact_audit(anchor['observation']['studentOutput'], anchor['task']) == anchor['observationAudit'],
                'Saved observation audit differs')
        for rid in anchor['mathRecordIds']:
            paths = list((parent / 'responses').glob(rid + '-scored.json'))
            paths += list((parent / 'parent-iteration-originals').rglob(rid + '-scored.json'))
            matched = [(p, read(p)) for p in sorted(paths) if read(p).get('task') == anchor['task']]
            require(bool(matched), 'Original training route missing: ' + rid)
            row = matched[0][1]
            require(all(other == row for _, other in matched), 'Ambiguous nonidentical route originals')
            require(audit_math(row['task'], row['studentOutput'], row['selectedCandidate']) == row['check'],
                    'Original route check cannot be reproduced')
            key = anchor['task']['id'] + '/' + rid
            require(key not in routes, 'Repeated route original')
            routes[key] = copy.deepcopy(row)
            relative = str(matched[0][0].relative_to(parent))
            require(relative in resume['sourceHashes'], 'Route is outside audited source manifest')
            provenance[key] = dict(sourceRelativePath=relative, sourceSha256=resume['sourceHashes'][relative])
    bundle = make_bundle(resume['anchors'], resume['final']['head'], resume['sourceFrame'], routes)
    return bundle, provenance
