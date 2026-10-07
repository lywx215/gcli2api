import asyncio, contextlib, json, math, pathlib, sqlite3, statistics, sys, tempfile, time, tracemalloc
ROOT = pathlib.Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))
import os
os.environ['ENABLE_LOG'] = '0'
os.environ['ANTIGRAVITY_PANEL_TIMING_SAMPLE_RATE'] = '0'
import aiosqlite
from src.storage.sqlite_manager import SQLiteManager
from src.antigravity_model_access import filter_summaries
from src.storage import antigravity_panel as panel

async def run(n):
    with tempfile.TemporaryDirectory(prefix='synthetic-panel-index-') as tmp:
        path=str(pathlib.Path(tmp)/'synthetic.db')
        db=sqlite3.connect(path)
        db.execute('CREATE TABLE antigravity_credentials(filename TEXT PRIMARY KEY, rotation_order INTEGER, credential_data TEXT, disabled INTEGER, permanent_disabled INTEGER, tier TEXT, remark TEXT, error_codes TEXT,error_messages TEXT,model_cooldowns TEXT,quota_group_states TEXT,quota_credential_generation TEXT,model_access_state TEXT,user_email TEXT,last_success REAL,success_count INTEGER,failure_count INTEGER,cycle_stats TEXT,last_cycle_stats TEXT,enable_credit INTEGER)')
        db.execute('CREATE INDEX ordering ON antigravity_credentials(rotation_order)')
        values=[(f'synthetic-{i:06}.json',i,json.dumps({'refresh_token':'synthetic-only','project_id':f'p{i}'}),0,0,'pro','','[]','{}','{}','{}',f'g{i}','{}','',None,0,0,json.dumps({'claude':{'success':3,'failure':0}}),'{}',0) for i in range(n)]
        db.executemany('INSERT INTO antigravity_credentials VALUES('+','.join('?' for _ in range(20))+')',values);db.commit();db.close();del values
        store=SQLiteManager.__new__(SQLiteManager);store._initialized=True;store._db_path=path;store.model_access_storage_ready=True
        store._invalid_cooldown_warning_emitted=False
        queries=[];scans=[];pages=[];decodes=[]
        original_loads=json.loads
        def loads(*a,**kw):
            decodes.append(1)
            return original_loads(*a,**kw)
        original_connect=aiosqlite.connect
        @contextlib.asynccontextmanager
        async def connect(*a,**kw):
            async with original_connect(*a,**kw) as conn:
                await conn.set_trace_callback(lambda q: queries.append(q.split()[0]) if q.lstrip().upper().startswith('SELECT') else None)
                yield conn
        aiosqlite.connect=connect
        original_scan=store._panel_scan
        async def scan(**kw):
            count=0
            async for row in original_scan(**kw):count+=1;yield row
            scans.append(count)
        store._panel_scan=scan
        original_read=store._panel_read
        async def read(names,**kw):pages.append(len(names));return await original_read(names,**kw)
        store._panel_read=read
        try:
            repetitions=int(os.environ.get('PANEL_BENCH_REPETITIONS','1'))
            if not 1 <= repetitions <= 10:
                raise ValueError('PANEL_BENCH_REPETITIONS must be 1..10')
            timings={label:[] for label in ('legacy','new_cold','new_repeat')}
            for repetition in range(repetitions):
                store._panel_index=None
                for label in timings:
                    queries.clear();scans.clear();pages.clear();decodes.clear();start=time.perf_counter()
                    json.loads=loads
                    if label=='legacy':
                        result=await store.get_credentials_summary(mode='antigravity',offset=0,limit=None,include_error_classifications=True)
                        states=await store.model_access_list_public();families=await store.model_access_list_family_public()
                        result=filter_summaries(result,states,offset=0,limit=25,family_states=families)
                    else:result=await store.get_antigravity_panel_summary(limit=25)
                    elapsed=time.perf_counter()-start
                    timings[label].append(elapsed)
                    cache=getattr(store,'_panel_index',None)
                    print(json.dumps(dict(accounts=n,path=label,repetition=repetition+1,seconds=round(elapsed,4),selects=len(queries),index_scan_rows=sum(scans),page_rows=sum(pages),retained_cache_rows=len(cache['rows']) if cache else 0,estimated_cache_bytes=cache['bytes'] if cache else 0,json_decode_calls=len(decodes),returned=len(result['items']))),flush=True)
            if repetitions > 1:
                for label,samples in timings.items():
                    ordered=sorted(samples)
                    print(json.dumps(dict(accounts=n,path=label+'_summary',samples=len(samples),p50_seconds=round(statistics.median(samples),4),p95_seconds=round(ordered[math.ceil(.95*len(ordered))-1],4),percentile_method='nearest_rank',min_seconds=round(min(samples),4),max_seconds=round(max(samples),4))),flush=True)
            json.loads=original_loads
            if os.environ.get('PANEL_BENCH_TIMING_ONLY') == '1':
                return
            store._panel_index=None
            queries.clear();scans.clear();pages.clear()
            opts=dict(offset=0,limit=25,status_filter='all',error_code_filter=None,cooldown_filter=None,tier_filter=None,remark_filter=None,model_access_filter='all',model_access_family='claude-opus-5-5')
            tracemalloc.start()
            result=await store._panel_attempt(opts)
            current,peak=tracemalloc.get_traced_memory()
            tracemalloc.stop()
            print(json.dumps(dict(accounts=n,path='memory_probe_no_request_deadline',traced_current_bytes=current,traced_peak_bytes=peak,shared_constant_ids_bound=len(panel._SHARED_IDS),index_scan_rows=sum(scans),page_rows=sum(pages))),flush=True)
        finally:
            aiosqlite.connect=original_connect
            json.loads=original_loads

async def main():
    for n in (2000,10000,50000):await run(n)
asyncio.run(main())
