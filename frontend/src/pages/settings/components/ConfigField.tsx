import type { UseFormReturn } from 'react-hook-form';
import { Input } from '@/components/ui/input';
import { editable } from '../types';
import type { Draft, Field, Snapshot } from '../types';

export function ConfigField({
  field,
  form,
  snapshot,
  disabled,
}: {
  field: Field;
  form: UseFormReturn<Draft>;
  snapshot?: Snapshot;
  disabled: boolean;
}) {
  const error = form.formState.errors[field.key];
  const helpId = `${field.key}-help`,
    errorId = `${field.key}-error`;
  const locked = snapshot?.envLocked.includes(field.key);
  const unsupported = !!field.capability && !snapshot?.capabilities.includes(field.capability);

  const helpText = locked
    ? '由环境变量锁定'
    : unsupported
    ? '服务未声明所需能力'
    : field.kind === 'secret'
    ? '仅提交明确输入的新密码；空白不清除密码'
    : '';

  const describedByParts = [
    ...(helpText ? [helpId] : []),
    ...(error ? [errorId] : []),
  ];
  const describedBy = describedByParts.length > 0 ? describedByParts.join(' ') : undefined;

  const attributes = {
    id: field.key,
    disabled: disabled || !snapshot || !editable(field, snapshot),
    'aria-invalid': !!error,
    'aria-describedby': describedBy,
    ...form.register(field.key),
  };

  if (field.kind === 'boolean') {
    return (
      <div className="space-y-0.5">
        <div className="flex items-center justify-between gap-2 py-0.5">
          <label
            htmlFor={field.key}
            className="text-xs md:text-[13px] font-medium text-foreground cursor-pointer select-none"
          >
            {field.label}
          </label>
          <input
            type="checkbox"
            className="size-4 shrink-0 rounded border-input accent-primary disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:outline aria-invalid:outline-2 aria-invalid:outline-offset-2 aria-invalid:outline-destructive"
            {...attributes}
          />
        </div>
        {helpText && (
          <p id={helpId} className="text-[12px] leading-tight text-muted-foreground">
            {helpText}
          </p>
        )}
        {error && (
          <p id={errorId} role="alert" className="text-[12px] leading-tight text-destructive">
            {String(error.message)}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <label
        htmlFor={field.key}
        className="text-xs md:text-[13px] font-medium text-foreground block"
      >
        {field.label}
      </label>
      {field.choices ? (
        <select
          className="h-8 w-full rounded-md border border-input bg-control-background px-2.5 py-1 text-base md:text-[13px] text-foreground shadow-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive"
          {...attributes}
        >
          <option value="">未提供</option>
          {field.choices.map((choice) => (
            <option key={choice}>{choice}</option>
          ))}
        </select>
      ) : field.kind === 'origins' ? (
        <textarea
          className="min-h-16 w-full rounded-md border border-input bg-control-background p-2 text-base md:text-[13px] text-foreground shadow-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-border disabled:bg-secondary disabled:text-muted-foreground disabled:opacity-100 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive"
          {...attributes}
        />
      ) : (
        <Input
          className="h-8 text-base md:text-[13px] px-2.5 py-1 aria-invalid:border-destructive aria-invalid:focus-visible:ring-destructive"
          type={field.kind === 'secret' ? 'password' : field.kind === 'number' ? 'number' : 'text'}
          step={field.integer ? 1 : 'any'}
          min={field.min}
          max={field.max}
          autoComplete={field.kind === 'secret' ? 'new-password' : 'off'}
          placeholder={field.kind === 'secret' ? '不修改请留空' : undefined}
          {...attributes}
        />
      )}
      {helpText && (
        <p id={helpId} className="text-[12px] leading-tight text-muted-foreground">
          {helpText}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-[12px] leading-tight text-destructive">
          {String(error.message)}
        </p>
      )}
    </div>
  );
}
