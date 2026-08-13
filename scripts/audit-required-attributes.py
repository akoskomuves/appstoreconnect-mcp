#!/usr/bin/env python3
# Audit request-body builders in src/ against Apple's OFFICIAL OpenAPI spec —
# catches "attribute is required on the wire but our builder can omit it"
# drift (the numberOfPeriods class of bug: every PAY_UP_FRONT intro-offer
# create 409'd ENTITY_ERROR.ATTRIBUTE.REQUIRED because a client-side gate
# only emitted the spec-required attribute for PAY_AS_YOU_GO).
#
# Usage:
#   curl -sfL "https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip" -o /tmp/asc-spec.zip
#   unzip -o -q /tmp/asc-spec.zip -d /tmp   # note: zip may name the file "openapi.oas (2).json"
#   python3 scripts/audit-required-attributes.py "/tmp/openapi.oas.json"
#
# For every POST/PATCH we issue via client.request, this resolves the spec's
# request schema, collects the required attributes + relationships (including
# on `included[]` resources of atomic creates), then classifies each required
# name against the code that builds the body:
#   ALWAYS   — plain object-literal key ("name: ..." with no ternary on the line)
#   COND     — only ever set behind a guard ("attributes.name =", or a
#              "...( ? { name: ... } : {})" conditional spread)
#   MISSING  — never mentioned where that body is built
# COND and MISSING are findings to review by hand, not proven bugs: Apple's
# required-ness is sometimes mode-conditional (FREE_TRIAL intro offers create
# fine without numberOfPeriods) and a zod .default() can make a guarded key
# always-present in practice. The audit is a lead generator.
#
# Run when bumping versions, after Apple's WWDC spec refresh, or after adding
# any new write surface.

import glob
import json
import re
import sys

spec_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/openapi.oas.json'
spec = json.load(open(spec_path))
schemas = spec['components']['schemas']


def deref(node):
    while isinstance(node, dict) and '$ref' in node:
        node = schemas[node['$ref'].rsplit('/', 1)[1]]
    return node


def required_of(schema_name):
    """(required attrs, required rels, [(included label, attrs, rels)]) for a request schema."""
    schema = deref(schemas.get(schema_name, {}))
    data = deref(schema.get('properties', {}).get('data', {}))
    if data.get('type') == 'array':  # linkage request (data: [{type,id}]) — nothing to audit
        return [], [], []
    attrs = deref(data.get('properties', {}).get('attributes', {})).get('required', [])
    rels = deref(data.get('properties', {}).get('relationships', {})).get('required', [])
    included = []
    inc = deref(schema.get('properties', {}).get('included', {}))
    items = inc.get('items', {})
    for variant in items.get('oneOf', [items] if items else []):
        v = deref(variant)
        label = v.get('properties', {}).get('type', {}).get('enum', ['?'])[0]
        v_attrs = deref(v.get('properties', {}).get('attributes', {})).get('required', [])
        v_rels = deref(v.get('properties', {}).get('relationships', {})).get('required', [])
        if v_attrs or v_rels:
            included.append((label, v_attrs, v_rels))
    return attrs, rels, included


# path -> {method -> request schema name}
spec_requests = {}
for path, methods in spec.get('paths', {}).items():
    for method, op in methods.items():
        if method not in ('post', 'patch') or not isinstance(op, dict):
            continue
        content = op.get('requestBody', {}).get('content', {})
        ref = content.get('application/json', {}).get('schema', {}).get('$ref')
        if ref:
            spec_requests.setdefault(path, {})[method] = ref.rsplit('/', 1)[1]


files = {f: open(f).read() for f in glob.glob('src/**/*.ts', recursive=True)}
# builder name -> defining file. Whole-file corpus (not the extracted function
# body): TS inline object-type annotations defeat naive brace matching, and
# domain files are small enough that the extra text mostly adds COND-classified
# patch-builder guards, which still surface as findings rather than hiding any.
builder_files = {}
for f, src in files.items():
    for name in re.findall(r'(?:export )?(?:async )?function (build\w+Body)\(', src):
        builder_files[name] = f


# Lines that are zod schema declarations or TS type annotations mention every
# attribute name without emitting anything on the wire — they must not count
# as evidence, or every name classifies as ALWAYS and the audit goes blind.
TYPE_ANNOTATION = re.compile(r':\s*(?:string|number|boolean|Date)\b[^,{]*;?\s*$')


def is_evidence_line(line):
    ls = line.strip()
    if ls.startswith(('//', '*', '/*')):
        return False
    if 'Schema' in line or re.search(r'\bz\s*\.', line):
        return False
    return True


def classify(name, corpus):
    always = cond = False
    for line in corpus.splitlines():
        if not is_evidence_line(line):
            continue
        if re.search(rf'\b(?:attributes|relationships)\.{name}\s*=', line) or re.search(
            rf'\?\s*\{{[^}}]*\b{name}\s*:', line
        ):
            cond = True
            continue
        # Config-driven builders emit relationship keys computed from data
        # (`[input.relKey]: ...`), invisible to a key-grep — but the call site
        # then carries the name as an exact quoted string (relKey:
        # 'inAppPurchaseV2'), which is equally strong evidence.
        if re.search(rf'[\'"]{name}[\'"]', line):
            always = True
            continue
        if not re.search(rf'\b{name}\s*:', line):
            continue
        if '?' in line or TYPE_ANNOTATION.search(line):
            continue  # optional interface field, ternary, or plain type line
        always = True
    if always:
        return 'ALWAYS'
    if cond:
        return 'COND'
    return 'MISSING'


# Reviewed mode-conditional exceptions: the spec flat-marks these Required but
# the live API enforces per-offerMode (FREE_TRIAL intro/promo creates succeed
# without numberOfPeriods; builders default PAY_UP_FRONT to 1 — see
# tests/intro-offer-body.test.ts). Listed so they don't drown real findings;
# re-review if Apple's enforcement changes.
ACCEPTED = {
    ('/v1/subscriptionIntroductoryOffers', 'post', 'attr', 'numberOfPeriods'),
    ('/v1/subscriptionPromotionalOffers', 'post', 'attr', 'numberOfPeriods'),
}


# Find every POST/PATCH call site: path literal + method within the call window.
call_sites = []  # (file, spec_path, method, corpus)
for f, src in files.items():
    for m in re.finditer(r'[\'"`](/v\d+/[^\'"`\s?]+)', src):
        raw = m.group(1)
        window = src[m.end() : m.end() + 400]
        method_m = re.search(r"method:\s*['\"](POST|PATCH)['\"]", window)
        if not method_m:
            continue
        method = method_m.group(1).lower()
        # Normalize interpolated IDs: cut at `${`, then map trailing slash to /{id}.
        prefix = raw.split('${')[0]
        candidates = [prefix.rstrip('/'), prefix.rstrip('/') + '/{id}']
        spec_match = next(
            (c for c in candidates if c in spec_requests and method in spec_requests[c]), None
        )
        if spec_match is None:
            continue
        # Corpus: the 4000 chars before the call (inline bodies) plus any
        # build*Body helpers referenced there (bodies built in another file).
        window_before = src[max(0, m.start() - 4000) : m.end() + 400]
        corpus = window_before
        for b in set(re.findall(r'\b(build\w+Body)\s*\(', window_before)):
            if b in builder_files:
                corpus += '\n' + files[builder_files[b]]
        call_sites.append((f, spec_match, method, corpus))

# Classify every required name at every call site. The same endpoint can be
# hit from several files (domain tool + PPP apply path); each call site is
# audited independently — one site delegating to a clean builder does not
# excuse another site hand-rolling a body that drops the attribute.
results = {}  # (spec_path, method, schema label, kind, name) -> {file: classification}
checked = set()
for f, spec_path_matched, method, corpus in call_sites:
    schema_name = spec_requests[spec_path_matched][method]
    attrs, rels, included = required_of(schema_name)
    checked.add((spec_path_matched, method))
    targets = [(schema_name, 'attr', attrs), (schema_name, 'rel', rels)]
    for label, i_attrs, i_rels in included:
        targets.append((f'{schema_name}[{label}]', 'incl-attr', i_attrs))
        targets.append((f'{schema_name}[{label}]', 'incl-rel', i_rels))
    for schema_label, kind, names in targets:
        for name in names:
            if name == 'type':
                continue
            key = (spec_path_matched, method, schema_label, kind, name)
            results.setdefault(key, {})[f] = classify(name, corpus)

findings, accepted = [], []
for key, per_file in sorted(results.items()):
    if all(c == 'ALWAYS' for c in per_file.values()):
        continue
    sp, method, schema_label, kind, name = key
    bucket = accepted if (sp, method, kind, name) in ACCEPTED else findings
    bucket.append((key, per_file))

if findings:
    print(f'{len(findings)} required-name finding(s) to review '
          f'(COND/MISSING are leads, not proven bugs):\n')
    for (sp, method, schema_label, kind, name), per_file in findings:
        print(f'  {method.upper():5} {sp}')
        print(f'        {schema_label} {kind} `{name}`')
        for f, c in sorted(per_file.items()):
            print(f'          {c:8} at {f}')
else:
    print('No findings.')
if accepted:
    print(f'\n{len(accepted)} reviewed mode-conditional exception(s) (see ACCEPTED in this script):')
    for (sp, method, schema_label, kind, name), per_file in accepted:
        print(f'  {method.upper():5} {sp} — {kind} `{name}`')

tally = {'ALWAYS': 0, 'COND': 0, 'MISSING': 0}
for per_file in results.values():
    for c in per_file.values():
        tally[c] += 1
print(
    f'\nChecked {len(checked)} endpoint+method pairs against spec {spec["info"]["version"]}: '
    f'{len(results)} required names, {sum(tally.values())} site-classifications '
    f'({tally["ALWAYS"]} ALWAYS / {tally["COND"]} COND / {tally["MISSING"]} MISSING).'
)

# Coverage: write endpoints in the spec whose resource name never appears in
# src at all are fine (not implemented); ones that appear but weren't matched
# above may be called through dynamic/factory paths — flag for manual eyes.
matched_paths = {sp for sp, _ in checked}
unmatched = []
for path, methods in spec_requests.items():
    if path in matched_paths:
        continue
    head = path.split('/')[2]
    if any(f"/{head}" in src or f"'{head}'" in src for src in files.values()):
        unmatched.append((path, ','.join(methods)))
if unmatched:
    print(f'\n{len(unmatched)} spec write endpoint(s) whose resource appears in src but no '
          f'literal call site matched (factory/dynamic paths — audit by hand):')
    for path, methods in sorted(unmatched):
        print(f'  {methods:11} {path}')
