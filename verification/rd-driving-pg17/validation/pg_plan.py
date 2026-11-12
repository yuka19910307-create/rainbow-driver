"""Pure preparation helpers: never starts a process or opens a database."""
import hashlib, json, pathlib, re

SQL_FILES = [
 'sql/01-rd-operations-REVIEW-ONLY.sql',
 'sql/02-legacy-writer-guard-REVIEW-ONLY.sql',
 'sql/03-route-consent-REVIEW-ONLY.sql',
 'sql/04-termination-plans-REVIEW-ONLY.sql',
 'sql/05-settlement-observation-REVIEW-ONLY.sql',
 'sql/06-terminal-finalization-REVIEW-ONLY.sql',
 'sql/07-operation-terminal-results-REVIEW-ONLY.sql',
]
GATES = [
 "DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_OPS_REVIEW_ONLY_NO_APPROVED_DB_EXECUTION'; END $approval_gate$;",
 "DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_OPS_LEGACY_WRITER_GUARD_REVIEW_ONLY'; END $approval_gate$;",
 "DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_ROUTE_V7_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;",
 "DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_TERMINATION_V8_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;",
 "DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_SETTLEMENT_OBSERVATION_REVIEW_ONLY_NO_APPROVED_EXECUTION'; END $approval_gate$;",
 "DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_TERMINAL_V10_REVIEW_ONLY_UNAPPROVED'; END $approval_gate$;",
 "DO $approval_gate$ BEGIN RAISE EXCEPTION 'RD_OPS_OPERATION_TERMINAL_REVIEW_ONLY'; END $approval_gate$;",
]
FILES = SQL_FILES + ['validation/fixture.sql','validation/run-isolated.py',
                   'validation/pg_plan.py','validation/outbox_scenarios.py']
REQUIRED_SCENARIOS = ['E-PG-%02d'%i for i in [*range(1,13),*range(16,25)]]
EXCLUDED_SCENARIOS = ['E-PG-13','E-PG-14','E-PG-15','E-PG-25']
MARKER = '-- Owner-approved isolated fixture execution; review marker omitted once.'

def sha(data): return hashlib.sha256(data).hexdigest()

def sql_mask(text):
    """Keep only top-level SQL tokens, preserving offsets and semicolons.
    Reject unterminated comments/quotes. Dollar bodies and quoted identifiers are
    blanked so function BEGIN/END and literals cannot become transaction markers.
    This is a narrow transaction-boundary validator, not a SQL grammar parser.
    """
    out=list(text);i=0;n=len(text)
    def blank(a,b):
        for p in range(a,b):
            if out[p]!='\n':out[p]=' '
    while i<n:
        if text.startswith('--',i):
            end=text.find('\n',i);end=n if end<0 else end;blank(i,end);i=end
        elif text.startswith('/*',i):
            start=i;depth=1;i+=2
            while i<n and depth:
                if text.startswith('/*',i):depth+=1;i+=2
                elif text.startswith('*/',i):depth-=1;i+=2
                else:i+=1
            if depth:raise ValueError('Unterminated SQL comment')
            blank(start,i)
        elif text[i] in "'\"":
            start=i;quote=text[i];i+=1
            while i<n:
                if text[i]==quote:
                    if i+1<n and text[i+1]==quote:i+=2;continue
                    i+=1;break
                i+=1
            else:raise ValueError('Unterminated SQL quote')
            blank(start,i)
        elif text[i]=='$' and (match:=re.match(r'\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$',text[i:])):
            start=i;tag=match.group();end=text.find(tag,i+len(tag))
            if end<0:raise ValueError('Unterminated dollar quote')
            i=end+len(tag);blank(start,i)
        else:i+=1
    return ''.join(out)

def migration_body(text,index):
    gate=GATES[index]
    if text.count(gate)!=1:raise ValueError('Review marker differs: stop and reapprove extraction')
    # The gate must be the first top-level statement, not a literal inside another function.
    mask=sql_mask(text);first_end=mask.find(';')
    if first_end<0 or text[:first_end+1].strip().split('\n')[-1]!=gate:
        raise ValueError('Review marker is not the first top-level statement')
    transformed=text.replace(gate,MARKER,1);mask=sql_mask(transformed)
    spans=[];start=0
    for match in re.finditer(';',mask):
        end=match.end()
        segment=mask[start:end]
        if segment.strip():spans.append((start+len(segment)-len(segment.lstrip()),end,segment.strip()))
        start=end
    if mask[start:].strip():raise ValueError('Trailing SQL without terminator')
    if len(spans)<3 or spans[0][2].upper()!='BEGIN;' or spans[-1][2].upper()!='COMMIT;':
        raise ValueError('Expected exactly one outer BEGIN/COMMIT')
    for _,_,statement in spans[1:-1]:
        if re.match(r'(?i)(BEGIN|START|COMMIT|END|ROLLBACK|ABORT|SAVEPOINT|RELEASE|PREPARE)\b',statement):
            raise ValueError('Unexpected transaction control')
        if '\\' in statement:raise ValueError('psql meta-command forbidden')
    a,b,_=spans[0];c,d,_=spans[-1]
    return transformed[:a]+transformed[b:c]+transformed[d:]

def load_inputs(root):
    data={};missing=[]
    for name in FILES:
        p=root/name
        if not p.exists():missing.append(name);continue
        if p.is_symlink() or not p.is_file():raise ValueError('Input must be a regular non-symlink file: '+name)
        data[name]=p.read_bytes()
    return data,missing

def plan(root):
    data,missing=load_inputs(root);errors=[]
    for i,name in enumerate(SQL_FILES):
        if name in data:
            try:migration_body(data[name].decode(),i)
            except ValueError as e:errors.append(name+': '+str(e))
    return {'format':'rd-isolated-pg-plan-2','status':'PREPARED_NOT_EXECUTED',
      'postgresVersion':'17.11','scope':'new private local Unix-socket synthetic cluster only',
      'inputs':{k:sha(v) for k,v in data.items()},'missingInputs':missing,'preparationErrors':errors,
      'requiredScenarios':REQUIRED_SCENARIOS,'notCoveredScenarios':EXCLUDED_SCENARIOS,
      'executionReady':not missing and not errors,'ownerApprovalRecorded':False},data

def verify_manifest(root,path,expected_sha):
    if not path or not path.is_absolute() or path.is_symlink():raise ValueError('Absolute regular manifest required')
    if not re.fullmatch('[0-9a-f]{64}',expected_sha or ''):raise ValueError('Fixed manifest SHA-256 required')
    raw=path.read_bytes()
    if sha(raw)!=expected_sha:raise ValueError('Manifest SHA mismatch')
    approved=json.loads(raw);observed,data=plan(root)
    if approved!=observed:raise ValueError('Approved input manifest differs from current exact plan')
    if not observed['executionReady']:raise ValueError('Preparation incomplete; refusing PG startup')
    return observed,data

def object_contract(sources):
    tables=set();functions=set();triggers=set()
    for text in sources:
        # Names are unquoted, known candidate identifiers. Function bodies are masked.
        mask=sql_mask(text)
        tables.update(re.findall(r'(?i)CREATE\s+TABLE\s+(rd_private\.[a-z_][a-z_0-9]*)',mask))
        functions.update(re.findall(r'(?i)CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+((?:public|rd_private)\.[a-z_][a-z_0-9]*)',mask))
        triggers.update(re.findall(r'(?i)CREATE\s+TRIGGER\s+(rd_[a-z_0-9]+)',mask))
    if not tables or not functions or not triggers:raise ValueError('Object inventory incomplete')
    return {'tables':sorted(tables),'functions':sorted(functions),'triggers':sorted(triggers)}

def catalog_assertions(contract):
    checks=[]
    for role in ['anon','authenticated']:
        checks.append((f"NOT has_schema_privilege('{role}','rd_private','USAGE')",'private schema '+role+' denied'))
    for name in contract['tables']:
        checks.append((f"EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('{name}') AND relrowsecurity)",name+' RLS'))
        for role in ['anon','authenticated']:
            checks.append((f"NOT has_table_privilege('{role}','{name}','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')",name+' '+role+' denied'))
    for name in contract['functions']:
        schema,fn=name.split('.')
        pred=f"n.nspname='{schema}' AND p.proname='{fn}'"
        checks.append((f"EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE {pred})",name+' exists'))
        for role in ['anon','authenticated']:
            checks.append((f"NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE {pred} AND has_function_privilege('{role}',p.oid,'EXECUTE'))",name+' '+role+' denied'))
        if schema=='public':
            checks.append((f"NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE {pred} AND NOT has_function_privilege('service_role',p.oid,'EXECUTE'))",name+' service role grant'))
    for name in contract['triggers']:
        checks.append((f"EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='{name}' AND NOT tgisinternal AND tgenabled IN('O','A'))",name+' enabled'))
    checks.append(("EXISTS(SELECT 1 FROM rd_private.ops_settings WHERE id=1 AND NOT enabled AND NOT identity_intake_enabled AND NOT terminal_terms_enabled)",'all business switches stay off'))
    return "DO $rd_catalog_assert$ BEGIN\n"+'\n'.join("IF NOT ("+condition+") THEN RAISE EXCEPTION 'RD_CATALOG_ASSERT_FAILED: "+label+"'; END IF;" for condition,label in checks)+"\nEND $rd_catalog_assert$;"

def bundle(data,fail_after=None):
    sources=[data[name].decode() for name in SQL_FILES]
    bodies=[migration_body(text,i) for i,text in enumerate(sources)]
    if fail_after is not None and fail_after not in range(1,len(SQL_FILES)+1):raise ValueError('Bad failure boundary')
    parts=['BEGIN;','SET LOCAL statement_timeout = \'20s\';','SET LOCAL lock_timeout = \'10s\';']
    for i,body in enumerate(bodies,1):
        parts.extend(['-- BEGIN APPROVED INPUT '+SQL_FILES[i-1],body])
        if fail_after==i:
            parts.append("DO $$ BEGIN RAISE EXCEPTION 'RD_INJECTED_BOUNDARY_%d'; END $$;"%i)
            break
    if fail_after is None:parts.append(catalog_assertions(object_contract(sources)))
    parts.append('COMMIT;')
    return '\n'.join(parts)

class Coverage:
    def __init__(self,evidence):self.evidence=evidence;self.results={};self.save()
    def save(self):
        pending=[x for x in REQUIRED_SCENARIOS if x not in self.results]
        (self.evidence/'scenario-results.json').write_text(json.dumps({'required':REQUIRED_SCENARIOS,'completed':self.results,'pending':pending,'complete':not pending},indent=2))
    def mark(self,case,detail):
        if case not in REQUIRED_SCENARIOS or case in self.results:raise AssertionError('Unexpected/duplicate scenario '+case)
        self.results[case]={'status':'PASS','detail':detail};self.save()
    def require_complete(self):
        pending=set(REQUIRED_SCENARIOS)-set(self.results)
        if pending:raise AssertionError('Required scenarios incomplete: '+','.join(sorted(pending)))
