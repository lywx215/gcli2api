import type { UseFormReturn } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { editable } from '../types';
import type { Draft, Field, Snapshot } from '../types';

export function ConfigField({ field, form, snapshot, disabled }: { field: Field; form: UseFormReturn<Draft>; snapshot?: Snapshot; disabled: boolean }) {
  const error = form.formState.errors[field.key];
  const helpId = `${field.key}-help`, errorId = `${field.key}-error`;
  const locked = snapshot?.envLocked.includes(field.key);
  const unsupported = !!field.capability && !snapshot?.capabilities.includes(field.capability);
  const attributes = { id: field.key, disabled: disabled || !snapshot || !editable(field, snapshot), 'aria-invalid': !!error, 'aria-describedby': `${helpId}${error ? ` ${errorId}` : ''}`, ...form.register(field.key) };
  return <div className="space-y-1"><label htmlFor={field.key} className="text-sm font-medium text-foreground">{field.label}</label>
    {field.kind === 'boolean' ? <input type="checkbox" className="ml-3 size-4 rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:outline aria-invalid:outline-2 aria-invalid:outline-offset-2 aria-invalid:outline-destructive" {...attributes} /> :
      field.choices ? <select className="h-10 w-full rounded-md border border-input bg-control-background px-3 text-base text-foreground shadow-control focus-visible:border-ring focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive md:text-sm" {...attributes}><option value="">未提供</option>{field.choices.map(choice => <option key={choice}>{choice}</option>)}</select> :
      field.kind === 'origins' ? <textarea className="min-h-24 w-full rounded-md border border-input bg-control-background p-3 text-base text-foreground shadow-control focus-visible:border-ring focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive md:text-sm" {...attributes} /> :
      <Input className="aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive" type={field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'} step={field.integer ? 1 : 'any'} min={field.min} max={field.max} autoComplete={field.kind === 'secret' ? 'new-password' : 'off'} placeholder={field.kind === 'secret' ? '不修改请留空' : undefined} {...attributes} />}
    <p id={helpId} className="text-[13px] leading-4 text-muted-foreground">{locked ? '由环境变量锁定' : unsupported ? '服务未声明所需能力' : field.kind === 'secret' ? '仅提交明确输入的新密码；空白不清除密码' : ''}</p>
    {error && <p id={errorId} role="alert" className="text-[13px] leading-5 text-destructive">{String(error.message)}</p>}
  </div>;
}
