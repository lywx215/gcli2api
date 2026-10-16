import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { display, equal, object, rowChannel } from '../types';
import type { Snapshot } from '../types';

export function Comparison({ observed, sent, draft, disabled, adopt, retain }: {
  observed: Snapshot; sent: unknown[] | null; draft: unknown[]; disabled: boolean; adopt(): void; retain(): void;
}) {
  return <section aria-label="读回对照" className="space-y-2.5 rounded-md border bg-card p-3 text-card-foreground">
    <h2 className="text-base font-semibold leading-5">读回对照</h2>
    <p className="text-xs leading-5">观察值共 {observed.routes.length} 行；当前草稿{equal(draft, observed.routes) ? '与观察值相同' : '与观察值不同'}。{sent && `本次提交值${equal(sent, observed.routes) ? '与观察值相同' : '与观察值不同'}。`}读回结果不会自动覆盖草稿，也不等于撤销已经发送的操作。</p>
    <div className="max-h-60 overflow-auto rounded-md border bg-popover">
      <Table>
        <TableHeader className="bg-secondary">
          <TableRow className="h-7">
            <TableHead className="py-1 px-2 text-xs">完整表行号</TableHead>
            <TableHead className="py-1 px-2 text-xs">渠道</TableHead>
            <TableHead className="py-1 px-2 text-xs">公开名称</TableHead>
            <TableHead className="py-1 px-2 text-xs">目标名称</TableHead>
            <TableHead className="py-1 px-2 text-xs">启用</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {observed.routes.map((row, index) => (
            <TableRow key={index} className="h-8 hover:bg-hover">
              <TableCell className="py-1 px-2 text-xs tabular-nums text-muted-foreground">{index + 1}</TableCell>
              <TableCell className="py-1 px-2 text-xs">{rowChannel(row) === 'antigravity' ? 'Antigravity' : rowChannel(row) === 'geminicli' ? 'Gemini CLI' : '无效结构'}</TableCell>
              <TableCell className="py-1 px-2 text-xs">{object(row) ? display(row.public_name) : '需删除重建'}</TableCell>
              <TableCell className="py-1 px-2 text-xs">{object(row) ? display(row.upstream_name) : '需删除重建'}</TableCell>
              <TableCell className="py-1 px-2 text-xs">{object(row) && typeof row.enabled === 'boolean' ? row.enabled ? '是' : '否' : '字段无效'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
    {!observed.routes.length && <p className="text-xs text-muted-foreground">观察值为空表。</p>}
    <p className={observed.issues.length > 0 ? 'text-xs text-warning' : 'text-xs text-muted-foreground'}>服务端校验问题：{observed.issues.length} 个。未知字段继续保留，采用观察值不会自动清理历史数据。</p>
    <div className="flex flex-wrap gap-2 pt-1">
      <Button variant="outline" size="sm" className="h-8 text-xs" disabled={disabled} onClick={adopt}>放弃草稿并采用观察值</Button>
      <Button variant="outline" size="sm" className="h-8 text-xs" disabled={disabled} onClick={retain}>已核对，继续编辑草稿</Button>
    </div>
  </section>;
}
