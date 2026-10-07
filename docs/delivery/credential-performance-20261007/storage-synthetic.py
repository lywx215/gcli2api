import ast, asyncio, json, os, pathlib, subprocess, sys, types
ROOT = pathlib.Path(r'G:/code/gemini30/gcli2api-master-integration')

def source(ref, path):
    return subprocess.check_output(['git', '-C', str(ROOT), 'show', ref + ':' + path], text=True, encoding='utf-8', stderr=subprocess.DEVNULL)

def extract(src, names, class_name=None):
    tree=ast.parse(src)
    body=next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name==class_name).body if class_name else tree.body
    nodes=[n for n in body if isinstance(n,(ast.FunctionDef,ast.AsyncFunctionDef)) and n.name in names]
    return compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])), '<extracted-read-only-source>', 'exec')

# Pure error helper module has standard-library imports only; no application imports.
errors={}
exec(source('HEAD','src/error_classification.py'), errors)

async def one(ref,n,k):
    pure=types.ModuleType('src.antigravity_model_access')
    try:
        exec(source(ref,'src/antigravity_model_access.py'), pure.__dict__)
        # Normalization is irrelevant for these fixed canonical synthetic model names.
        pure.access_model=lambda model: model
        sys.modules['src.antigravity_model_access']=pure
    except subprocess.CalledProcessError:
        pass
    metrics={'ref':ref,'accounts':n,'page_size':20,'accounts_with_403':k,'permission_reads':0,'permission_rows':0,'error_rows_loaded':0}
    checkns={'os':types.SimpleNamespace(getenv=lambda _:None),'Optional':__import__('typing').Optional,'valid_tiers_for_mode':lambda _:('free','pro','ultra')}
    exec(extract(source(ref,'src/storage/sqlite_manager.py'), {'_bounded_summary_enabled','_supports_bounded_summary_path'},'SQLiteManager'),checkns)
    class Check: pass
    check=Check()
    check._bounded_summary_enabled=types.MethodType(checkns['_bounded_summary_enabled'],check)
    check._supports_bounded_summary_path=types.MethodType(checkns['_supports_bounded_summary_path'],check)
    items=[dict(filename=f'synthetic-{i}',disabled=False,error_codes=[403] if i<k else [],last_success=None,user_email='',model_cooldowns={},tier='free',quota_groups={},quota_state_invalid=False) for i in range(n)]
    async def loader(names):
        metrics['error_rows_loaded']+=len(names)
        return {name:{} for name in names}
    class Backend:
        SUPPORTS_QUOTA_GROUP_FILTER=True
        model_access_storage_ready=True
        async def get_credentials_summary(self,**kw):
            metrics['backend_limit']=kw['limit']
            bounded=check._supports_bounded_summary_path(**{key:kw[key] for key in ('offset','limit','status_filter','mode','error_code_filter','cooldown_filter','preview_filter','tier_filter','remark_filter')})
            metrics['sqlite_bounded_path']=bounded
            # Model only row materialization; do not open any actual database.
            rows=items[kw['offset']:kw['offset']+kw['limit']] if bounded else items
            metrics['summary_rows_materialized']=len(rows)
            selected,total=await errors['paginate_and_classify_summaries'](rows,offset=0 if bounded else kw['offset'],limit=kw['limit'],error_code_filter=kw['error_code_filter'],include_error_classifications=kw['include_error_classifications'],load_error_messages=loader)
            return dict(items=selected,total=n,stats={},quota_group_filter_supported=True)
        async def model_access_list_public(self):
            metrics['permission_reads']+=1
            metrics['permission_rows']+=n
            return {}
        async def model_access_list_family_public(self):
            return await self.model_access_list_public()
    class Adapter:
        _backend=Backend()
        async def get_backend_info(self):return {'backend_type':'synthetic'}
    async def get_storage_adapter():return Adapter()
    ns=dict(JSONResponse=lambda **kw:kw['content'],validate_mode=lambda x:x,get_storage_adapter=get_storage_adapter,valid_tiers_for_mode=lambda _:('free','pro','ultra'),default_tier_for_mode=lambda _:'free',GROUP_FILTERS=set(),GROUP_FILTER_CAPABILITY='synthetic',os=os)
    exec(extract(source(ref,'src/panel/creds.py'), {'get_creds_status_common'}),ns)
    result=await ns['get_creds_status_common'](offset=0,limit=20,status_filter='all',mode='antigravity')
    metrics['returned_rows']=len(result['items'])
    print(json.dumps(metrics))

async def main():
    for ref in ('170d989','0ff4b2f','10d9313','0c589f4','d9b65ba'):
        for k in (0,10000):
            await one(ref,10000,k)

if __name__=='__main__': asyncio.run(main())
