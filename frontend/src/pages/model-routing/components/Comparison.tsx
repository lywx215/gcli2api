import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { display, equal, object, rowChannel } from '../types';
import type { Snapshot } from '../types';

export function Comparison({ observed, sent, draft, disabled, adopt, retain }: {
  observed: Snapshot; sent: unknown[] | null; draft: unknown[]; disabled: boolean; adopt(): void; retain(): void;
}) {
  return <section aria-label="读回对照" className="space-y-3 rounded-md border p-4">
    <h2 className="font-semibold">读回对照</h2>
    <p className="text-sm">观察值共 {observed.routes.length} 行；当前草稿{equal(draft, observed.routes) ? '与观察值相同' : '与观察值不同'}。{sent && `本次提交值${equal(sent, observed.routes) ? '与观察值相同' : '与观察值不同'}。`}读回结果不会自动覆盖草稿，也不等于撤销已经发送的操作。</p>
    <div className="max-h-72 overflow-auto"><Table><TableHeader><TableRow><TableHead>完整表行号</TableHead><TableHead>渠道</TableHead><TableHead>公开名称</TableHead><TableHead>目标名称</TableHead><TableHead>启用</TableHead></TableRow></TableHeader><TableBody>
      {observed.routes.map((row, index) => <TableRow key={index}><TableCell>{index + 1}</TableCell><TableCell>{rowChannel(row) === 'antigravity' ? 'Antigravity' : rowChannel(row) === 'geminicli' ? 'Gemini CLI' : '无效结构'}</TableCell><TableCell>{object(row) ? display(row.public_name) : '需删除重建'}</TableCell><TableCell>{object(row) ? display(row.upstream_name) : '需删除重建'}</TableCell><TableCell>{object(row) && typeof row.enabled === 'boolean' ? row.enabled ? '是' : '否' : '字段无效'}</TableCell></TableRow>)}
    </TableBody></Table></div>
    {!observed.routes.length && <p className="text-sm text-muted-foreground">观察值为空表。</p>}
    <p className="text-sm text-muted-foreground">服务端校验问题：{observed.issues.length} 个。未知字段继续保留，采用观察值不会自动清理历史数据。</p>
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={disabled} onClick={adopt}>放弃草稿并采用观察值</Button><Button variant="outline" disabled={disabled} onClick={retain}>已核对，继续编辑草稿</Button></div>
  </section>;
}
