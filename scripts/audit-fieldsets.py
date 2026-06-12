#!/usr/bin/env python3
# Audit every sparse-fieldset constant in src/ against Apple's OFFICIAL
# OpenAPI spec — catches "Apple deleted a field from the live contract"
# drift (the kidsAgeBand class of bug: every call to the tool 400s with
# "'X' is not a valid field name" until the fieldset is fixed).
#
# Usage:
#   curl -sfL "https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip" -o /tmp/asc-spec.zip
#   unzip -o -q /tmp/asc-spec.zip -d /tmp
#   python3 scripts/audit-fieldsets.py /tmp/openapi.oas.json
#
# Run when bumping versions, after Apple's WWDC spec refresh, or whenever a
# previously-working list tool starts 400ing.

import glob
import json
import os
import re
import sys

spec_path = sys.argv[1] if len(sys.argv) > 1 else '/tmp/openapi.oas.json'
spec = json.load(open(spec_path))

valid = {}
for path, methods in spec.get('paths', {}).items():
    for method, op in methods.items():
        if not isinstance(op, dict):
            continue
        for param in op.get('parameters', []):
            name = param.get('name', '')
            if not name.startswith('fields['):
                continue
            enum = (param.get('schema', {}).get('items', {}) or {}).get('enum', [])
            valid.setdefault(name, set()).update(enum)

consts = {}
for f in glob.glob('src/**/*.ts', recursive=True):
    src = open(f).read()
    for m in re.finditer(r"const (\w+) =\s*\n?\s*[`']([^`']+)[`']", src):
        consts[m.group(1)] = m.group(2)


def resolve(val):
    return re.sub(r"\$\{(\w+)\}", lambda m: consts.get(m.group(1), ''), val)


problems = []
checked = 0
for f in glob.glob('src/**/*.ts', recursive=True):
    src = open(f).read()
    for m in re.finditer(r"params\.set\(\s*['\"](fields\[[^\]]+\])['\"]\s*,\s*([^)]+?)\s*\)", src):
        key, expr = m.group(1), m.group(2).strip()
        if expr.startswith(("'", '"', '`')):
            value = resolve(expr.strip("'\"`"))
        elif expr in consts:
            value = resolve(consts[expr])
        else:
            continue  # dynamic expression — add a manual pair below
        checked += 1
        if key not in valid:
            problems.append(f"{os.path.basename(f)}: {key} — key not in spec at all")
            continue
        for field in value.split(','):
            field = field.strip()
            if field and field not in valid[key]:
                problems.append(f"{os.path.basename(f)}: {key} field '{field}' NOT in spec")

# Dynamic fieldsKey cases the regex can't resolve (beta-feedback ternary).
MANUAL = [
    ('fields[betaFeedbackScreenshotSubmissions]', 'SCREENSHOT_SUBMISSION_FIELDS'),
    ('fields[betaFeedbackCrashSubmissions]', 'CRASH_SUBMISSION_FIELDS'),
]
for key, const in MANUAL:
    checked += 1
    for field in resolve(consts.get(const, '')).split(','):
        field = field.strip()
        if field and field not in valid.get(key, set()):
            problems.append(f"(manual) {key} field '{field}' NOT in spec")

print(f"checked {checked} fieldset usages against spec ({len(valid)} fields keys in spec)")
if problems:
    print("\nPROBLEMS:")
    for p in sorted(set(problems)):
        print(f"  - {p}")
    sys.exit(1)
print("ALL CLEAN — no stale fields")
