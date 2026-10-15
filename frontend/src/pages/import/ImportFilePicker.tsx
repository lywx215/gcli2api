import * as React from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/domain/shared";

export type ImportProgress = Readonly<{
  completed: number;
  total: number;
}>;

export interface ImportFilePickerProps {
  readonly files: readonly File[];
  readonly onFilesChange: (files: readonly File[]) => void;
  readonly disabled?: boolean;
  readonly isCurrent: () => boolean;
  readonly progress?: ImportProgress | null;
}

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  if (i === 0) {
    return `${bytes} B`;
  }
  const val = bytes / Math.pow(1024, i);
  const formatted = (Math.round(val * 10) / 10).toString();
  return `${formatted} ${units[i]}`;
}

export function getFileTupleKey(file: File): string {
  return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
}

export function appendAndDeduplicateFiles(
  existing: readonly File[],
  incoming: readonly File[]
): File[] {
  const seen = new Set<string>();
  const result: File[] = [];

  for (const file of existing) {
    const key = getFileTupleKey(file);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(file);
    }
  }

  for (const file of incoming) {
    const key = getFileTupleKey(file);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(file);
    }
  }

  return result;
}

export function isValidProgress(
  progress: unknown
): progress is ImportProgress {
  if (!progress || typeof progress !== "object") {
    return false;
  }
  const p = progress as { completed?: unknown; total?: unknown };
  if (
    typeof p.completed !== "number" ||
    typeof p.total !== "number" ||
    !Number.isSafeInteger(p.completed) ||
    !Number.isSafeInteger(p.total)
  ) {
    return false;
  }
  return p.total > 0 && p.completed >= 0 && p.completed <= p.total;
}

export function ImportFilePicker(props: ImportFilePickerProps): React.JSX.Element {
  const {
    files = [],
    onFilesChange,
    disabled = false,
    isCurrent,
    progress = null,
  } = props;

  const [isDraggingOver, setIsDraggingOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const renderIdRef = React.useRef(0);
  renderIdRef.current += 1;
  const currentRenderId = renderIdRef.current;

  // Captured lifetime, callback, files, and disabled state for this render frame
  const capturedIsCurrent = isCurrent;
  const capturedOnFilesChange = onFilesChange;
  const capturedFiles = files;
  const capturedDisabled = Boolean(disabled);

  // Actor validity guard: checks mounted status, captured lifetime, current lifetime, and render identity
  const isActorActive = (): boolean => {
    if (!mountedRef.current) return false;
    if (capturedDisabled || disabled) return false;
    if (renderIdRef.current !== currentRenderId) return false;
    if (typeof capturedIsCurrent !== "function" || !capturedIsCurrent()) return false;
    if (typeof isCurrent !== "function" || !isCurrent()) return false;
    if (capturedIsCurrent !== isCurrent) return false;
    if (capturedOnFilesChange !== onFilesChange) return false;
    return true;
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const selectedFiles = input.files ? Array.from(input.files) : [];
    input.value = "";
    if (!isActorActive()) {
      return;
    }
    if (selectedFiles.length === 0) {
      return;
    }
    const nextFiles = appendAndDeduplicateFiles(capturedFiles, selectedFiles);
    capturedOnFilesChange(nextFiles);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (capturedDisabled || disabled || !capturedIsCurrent()) {
      return;
    }
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = "copy";
    }
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (capturedDisabled || disabled || !capturedIsCurrent()) {
      return;
    }
    setIsDraggingOver(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget.contains(event.relatedTarget as Node)) {
      return;
    }
    setIsDraggingOver(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const active = isActorActive();
    setIsDraggingOver(false);
    if (!active) {
      return;
    }
    const droppedFiles = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : [];
    if (droppedFiles.length === 0) {
      return;
    }
    const nextFiles = appendAndDeduplicateFiles(capturedFiles, droppedFiles);
    capturedOnFilesChange(nextFiles);
  };

  const handleRemove = (indexToRemove: number) => {
    if (!isActorActive()) {
      return;
    }
    const nextFiles = capturedFiles.filter((_, idx) => idx !== indexToRemove);
    capturedOnFilesChange(nextFiles);
  };

  const handleClear = () => {
    if (!isActorActive()) {
      return;
    }
    capturedOnFilesChange([]);
  };

  const validProgress = isValidProgress(progress) ? progress : null;

  return (
    <div className="space-y-4">
      <div
        role="region"
        aria-label="文件拖拽与选择区域"
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "flex flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition-colors",
          isDraggingOver ? "border-primary bg-primary/5" : "border-border bg-card",
          disabled && "opacity-60 cursor-not-allowed"
        )}
      >
        <p className="text-sm text-muted-foreground mb-3">
          拖拽文件至此处，或点击下方按钮选择文件
        </p>
        <label htmlFor="import-file-input" className="sr-only">
          选择导入文件
        </label>
        <input
          ref={inputRef}
          id="import-file-input"
          type="file"
          multiple
          disabled={disabled}
          onChange={handleInputChange}
          className="sr-only"
          aria-label="选择导入文件"
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          aria-label="选择文件"
        >
          选择文件
        </Button>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          已选文件 ({files.length})
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || files.length === 0}
          onClick={handleClear}
          aria-label="清空全部"
        >
          清空全部
        </Button>
      </div>

      {files.length > 0 && (
        <ul className="divide-y divide-border rounded-md border border-border px-3" aria-label="已选文件列表">
          {files.map((file, index) => (
            <li
              key={`${file.name}-${file.size}-${file.lastModified}-${index}`}
              className="flex items-center justify-between gap-4 py-2 text-sm text-foreground"
            >
              <div className="flex flex-col min-w-0 pr-2">
                <span className="font-medium truncate break-all">{file.name}</span>
                <span className="text-xs text-muted-foreground">{formatFileSize(file.size)}</span>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                onClick={() => handleRemove(index)}
                aria-label={`移除 ${file.name}`}
              >
                移除
              </Button>
            </li>
          ))}
        </ul>
      )}

      {validProgress && (
        <div
          role="status"
          aria-label="上传进度"
          className="flex items-center justify-between rounded-md border border-border bg-secondary/30 px-3 py-2 text-sm text-foreground"
        >
          <span className="text-muted-foreground">上传进度</span>
          <span className="font-medium">
            已完成 {validProgress.completed} / {validProgress.total}
          </span>
        </div>
      )}
    </div>
  );
}
