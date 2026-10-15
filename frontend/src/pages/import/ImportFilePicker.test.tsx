import * as React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ImportFilePicker,
  formatFileSize,
  isValidProgress,
  appendAndDeduplicateFiles,
  getFileTupleKey,
  type ImportFilePickerProps,
} from "./ImportFilePicker";

function getReactHandler(
  element: HTMLElement,
  handlerName: "onClick" | "onChange" | "onDrop"
): ((...args: unknown[]) => void) | undefined {
  const propKey = Object.keys(element).find((key) => key.startsWith("__reactProps$"));
  if (propKey) {
    const props = (element as unknown as Record<string, unknown>)[propKey] as Record<string, unknown> | undefined;
    return props?.[handlerName] as ((...args: unknown[]) => void) | undefined;
  }
  return undefined;
}

describe("ImportFilePicker - Utility functions", () => {
  it("formats file sizes with clear units", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(-10)).toBe("0 B");
    expect(formatFileSize(NaN)).toBe("0 B");
    expect(formatFileSize(500)).toBe("500 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1048576)).toBe("1 MB");
    expect(formatFileSize(2621440)).toBe("2.5 MB");
    expect(formatFileSize(1073741824)).toBe("1 GB");
  });

  it("validates honest progress correctly", () => {
    expect(isValidProgress(null)).toBe(false);
    expect(isValidProgress(undefined)).toBe(false);
    expect(isValidProgress("not an object")).toBe(false);
    expect(isValidProgress({ completed: 0, total: 10 })).toBe(true);
    expect(isValidProgress({ completed: 5, total: 10 })).toBe(true);
    expect(isValidProgress({ completed: 10, total: 10 })).toBe(true);
    expect(isValidProgress({ completed: -1, total: 10 })).toBe(false);
    expect(isValidProgress({ completed: 11, total: 10 })).toBe(false);
    expect(isValidProgress({ completed: 0, total: 0 })).toBe(false);
    expect(isValidProgress({ completed: 1.5, total: 10 })).toBe(false);
    expect(isValidProgress({ completed: 2, total: 10.5 })).toBe(false);
    expect(isValidProgress({ completed: NaN, total: 10 })).toBe(false);
    expect(isValidProgress({ completed: 2, total: Infinity })).toBe(false);
  });

  it("generates deterministic tuple keys for files", () => {
    const f1 = new File(["abc"], "data.json", { lastModified: 12345 });
    const f2 = new File(["abc"], "data.json", { lastModified: 12345 });
    const f3 = new File(["abcd"], "data.json", { lastModified: 12345 });
    expect(getFileTupleKey(f1)).toBe(getFileTupleKey(f2));
    expect(getFileTupleKey(f1)).not.toBe(getFileTupleKey(f3));
  });

  it("appends and deduplicates files by tuple in stable first-seen order without mutating arrays", () => {
    const existing1 = new File(["a"], "a.txt", { lastModified: 100 });
    const existing2 = new File(["bb"], "b.txt", { lastModified: 200 });
    const incoming1 = new File(["a"], "a.txt", { lastModified: 100 }); // duplicate of existing1
    const incoming2 = new File(["ccc"], "c.txt", { lastModified: 300 });
    const incoming3 = new File(["ccc"], "c.txt", { lastModified: 300 }); // duplicate within incoming

    const existingArray = Object.freeze([existing1, existing2]);
    const incomingArray = Object.freeze([incoming1, incoming2, incoming3]);

    const result = appendAndDeduplicateFiles(existingArray, incomingArray);
    expect(result).toEqual([existing1, existing2, incoming2]);
    expect(result).not.toBe(existingArray);
  });
});

describe("ImportFilePicker - Controlled parent-harness group", () => {
  it("handles input selection then drop append/dedup by (name, size, lastModified) in stable first-seen order", () => {
    const filesHistory: (readonly File[])[] = [];

    function ControlledParent() {
      const [files, setFiles] = React.useState<readonly File[]>([]);
      return (
        <ImportFilePicker
          files={files}
          onFilesChange={(next) => {
            filesHistory.push(next);
            setFiles(next);
          }}
          isCurrent={() => true}
        />
      );
    }

    render(<ControlledParent />);

    const f1 = new File(["12345"], "auth.json", { lastModified: 1000 });
    const f2 = new File(["1234567890"], "config.json", { lastModified: 2000 });

    const input = screen.getByLabelText("选择导入文件") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [f1, f2] } });

    expect(screen.getByText("auth.json")).toBeInTheDocument();
    expect(screen.getByText("config.json")).toBeInTheDocument();
    expect(screen.getByText("已选文件 (2)")).toBeInTheDocument();
    expect(input.value).toBe("");

    const f3 = new File(["extra"], "extra.json", { lastModified: 3000 });
    const f1Dup = new File(["12345"], "auth.json", { lastModified: 1000 });
    const f4 = new File(["more"], "more.json", { lastModified: 4000 });
    const f3Dup = new File(["extra"], "extra.json", { lastModified: 3000 });

    const dropZone = screen.getByRole("region", { name: "文件拖拽与选择区域" });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [f3, f1Dup, f4, f3Dup],
      },
    });

    expect(screen.getByText("已选文件 (4)")).toBeInTheDocument();
    expect(screen.getByText("extra.json")).toBeInTheDocument();
    expect(screen.getByText("more.json")).toBeInTheDocument();

    const lastEmitted = filesHistory[filesHistory.length - 1];
    expect(lastEmitted.length).toBe(4);
    expect(lastEmitted[0].name).toBe("auth.json");
    expect(lastEmitted[1].name).toBe("config.json");
    expect(lastEmitted[2].name).toBe("extra.json");
    expect(lastEmitted[3].name).toBe("more.json");
  });

  it("preserves distinct same-name files with different size or timestamp", () => {
    let currentFiles: readonly File[] = [];

    function ControlledParent() {
      const [files, setFiles] = React.useState<readonly File[]>([]);
      return (
        <ImportFilePicker
          files={files}
          onFilesChange={(next) => {
            currentFiles = next;
            setFiles(next);
          }}
          isCurrent={() => true}
        />
      );
    }

    render(<ControlledParent />);

    const fSame1 = new File(["aaa"], "same.json", { lastModified: 1000 }); // size 3, time 1000
    const fSame2 = new File(["aaaaaa"], "same.json", { lastModified: 1000 }); // size 6, time 1000 (different size)
    const fSame3 = new File(["aaa"], "same.json", { lastModified: 2000 }); // size 3, time 2000 (different time)
    const fSame1Dup = new File(["aaa"], "same.json", { lastModified: 1000 }); // exact tuple duplicate

    const input = screen.getByLabelText("选择导入文件");
    fireEvent.change(input, { target: { files: [fSame1] } });

    const dropZone = screen.getByRole("region", { name: "文件拖拽与选择区域" });
    fireEvent.drop(dropZone, {
      dataTransfer: {
        files: [fSame2, fSame3, fSame1Dup],
      },
    });

    expect(screen.getByText("已选文件 (3)")).toBeInTheDocument();
    expect(currentFiles.length).toBe(3);
    expect(currentFiles[0]).toBe(fSame1);
    expect(currentFiles[1]).toBe(fSame2);
    expect(currentFiles[2]).toBe(fSame3);
  });

  it("displays file names, formatted sizes, count, and handles remove and clear callbacks without mutating input", () => {
    const f1 = new File(["hello"], "file1.txt", { lastModified: 1000 });
    const f2 = new File(["world!!"], "file2.txt", { lastModified: 2000 });
    const onFilesChange = vi.fn();

    const { rerender } = render(
      <ImportFilePicker
        files={[f1, f2]}
        onFilesChange={onFilesChange}
        isCurrent={() => true}
      />
    );

    expect(screen.getByText("file1.txt")).toBeInTheDocument();
    expect(screen.getByText("5 B")).toBeInTheDocument();
    expect(screen.getByText("file2.txt")).toBeInTheDocument();
    expect(screen.getByText("7 B")).toBeInTheDocument();
    expect(screen.getByText("已选文件 (2)")).toBeInTheDocument();

    const removeBtn1 = screen.getByRole("button", { name: "移除 file1.txt" });
    fireEvent.click(removeBtn1);
    expect(onFilesChange).toHaveBeenCalledWith([f2]);

    onFilesChange.mockClear();

    rerender(
      <ImportFilePicker
        files={[f2]}
        onFilesChange={onFilesChange}
        isCurrent={() => true}
      />
    );

    const clearBtn = screen.getByRole("button", { name: "清空全部" });
    fireEvent.click(clearBtn);
    expect(onFilesChange).toHaveBeenCalledWith([]);
  });

  it("resets native input value so a removed file can be selected again", () => {
    let currentFiles: readonly File[] = [];

    function ControlledParent() {
      const [files, setFiles] = React.useState<readonly File[]>([]);
      return (
        <ImportFilePicker
          files={files}
          onFilesChange={(next) => {
            currentFiles = next;
            setFiles(next);
          }}
          isCurrent={() => true}
        />
      );
    }

    render(<ControlledParent />);
    const f1 = new File(["test"], "reuse.json", { lastModified: 5000 });

    const input = screen.getByLabelText("选择导入文件") as HTMLInputElement;

    fireEvent.change(input, { target: { files: [f1] } });
    expect(currentFiles.length).toBe(1);
    expect(input.value).toBe("");

    const removeBtn = screen.getByRole("button", { name: "移除 reuse.json" });
    fireEvent.click(removeBtn);
    expect(currentFiles.length).toBe(0);

    fireEvent.change(input, { target: { files: [f1] } });
    expect(currentFiles.length).toBe(1);
    expect(currentFiles[0].name).toBe("reuse.json");
  });

  it("prevents browser navigation on dragover and drop events", () => {
    render(
      <ImportFilePicker
        files={[]}
        onFilesChange={vi.fn()}
        isCurrent={() => true}
      />
    );

    const dropZone = screen.getByRole("region", { name: "文件拖拽与选择区域" });

    const dragOverEvent = new Event("dragover", { bubbles: true, cancelable: true });
    dropZone.dispatchEvent(dragOverEvent);
    expect(dragOverEvent.defaultPrevented).toBe(true);

    const dropEvent = new Event("drop", { bubbles: true, cancelable: true });
    dropZone.dispatchEvent(dropEvent);
    expect(dropEvent.defaultPrevented).toBe(true);
  });
});

describe("ImportFilePicker - Actor guard group", () => {
  it("does not emit onFilesChange when disabled is true", () => {
    const onFilesChange = vi.fn();
    const f1 = new File(["abc"], "doc.json", { lastModified: 1000 });

    render(
      <ImportFilePicker
        files={[f1]}
        onFilesChange={onFilesChange}
        disabled={true}
        isCurrent={() => true}
      />
    );

    const input = screen.getByLabelText("选择导入文件");
    fireEvent.change(input, { target: { files: [f1] } });
    expect(onFilesChange).not.toHaveBeenCalled();

    const dropZone = screen.getByRole("region", { name: "文件拖拽与选择区域" });
    fireEvent.drop(dropZone, { dataTransfer: { files: [f1] } });
    expect(onFilesChange).not.toHaveBeenCalled();

    const removeBtn = screen.getByRole("button", { name: "移除 doc.json" });
    fireEvent.click(removeBtn);
    expect(onFilesChange).not.toHaveBeenCalled();

    const clearBtn = screen.getByRole("button", { name: "清空全部" });
    fireEvent.click(clearBtn);
    expect(onFilesChange).not.toHaveBeenCalled();
  });

  it("does not emit onFilesChange when isCurrent returns false", () => {
    const onFilesChange = vi.fn();
    const f1 = new File(["abc"], "doc.json", { lastModified: 1000 });

    render(
      <ImportFilePicker
        files={[f1]}
        onFilesChange={onFilesChange}
        isCurrent={() => false}
      />
    );

    const input = screen.getByLabelText("选择导入文件");
    fireEvent.change(input, { target: { files: [f1] } });
    expect(onFilesChange).not.toHaveBeenCalled();

    const dropZone = screen.getByRole("region", { name: "文件拖拽与选择区域" });
    fireEvent.drop(dropZone, { dataTransfer: { files: [f1] } });
    expect(onFilesChange).not.toHaveBeenCalled();

    const removeBtn = screen.getByRole("button", { name: "移除 doc.json" });
    fireEvent.click(removeBtn);
    expect(onFilesChange).not.toHaveBeenCalled();

    const clearBtn = screen.getByRole("button", { name: "清空全部" });
    fireEvent.click(clearBtn);
    expect(onFilesChange).not.toHaveBeenCalled();
  });

  it("rejects stale actions when captured lifetime/callback is replaced, while current enabled actor remains usable", () => {
    const f1 = new File(["abc"], "doc.json", { lastModified: 1000 });
    const cb1 = vi.fn();
    let lifetime1Active = true;
    const isCurrent1 = vi.fn(() => lifetime1Active);

    const { rerender } = render(
      <ImportFilePicker
        files={[f1]}
        onFilesChange={cb1}
        isCurrent={isCurrent1}
      />
    );

    const clearButton = screen.getByRole("button", { name: "清空全部" });
    const retainedClearAction = getReactHandler(clearButton, "onClick");
    expect(retainedClearAction).toBeDefined();

    lifetime1Active = false;
    const cb2 = vi.fn();
    const isCurrent2 = vi.fn(() => true);

    rerender(
      <ImportFilePicker
        files={[f1]}
        onFilesChange={cb2}
        isCurrent={isCurrent2}
      />
    );

    retainedClearAction!();

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();

    const newClearButton = screen.getByRole("button", { name: "清空全部" });
    fireEvent.click(newClearButton);

    expect(cb2).toHaveBeenCalledWith([]);
  });

  it("rejects actions after component unmount", () => {
    const f1 = new File(["abc"], "doc.json", { lastModified: 1000 });
    const cb = vi.fn();

    const { unmount } = render(
      <ImportFilePicker
        files={[f1]}
        onFilesChange={cb}
        isCurrent={() => true}
      />
    );

    const clearButton = screen.getByRole("button", { name: "清空全部" });
    const retainedClearAction = getReactHandler(clearButton, "onClick");
    expect(retainedClearAction).toBeDefined();

    unmount();

    retainedClearAction!();

    expect(cb).not.toHaveBeenCalled();
  });
});

describe("ImportFilePicker - Progress and privacy group", () => {
  let fileTextSpy: ReturnType<typeof vi.spyOn> | undefined;
  let fileArrayBufferSpy: ReturnType<typeof vi.spyOn> | undefined;
  let readerTextSpy: ReturnType<typeof vi.spyOn> | undefined;
  let readerArrayBufferSpy: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    if (!File.prototype.text) {
      File.prototype.text = vi.fn().mockRejectedValue(new Error("File.text should never be called"));
    }
    if (!File.prototype.arrayBuffer) {
      File.prototype.arrayBuffer = vi.fn().mockRejectedValue(new Error("File.arrayBuffer should never be called"));
    }
    fileTextSpy = vi.spyOn(File.prototype, "text");
    fileArrayBufferSpy = vi.spyOn(File.prototype, "arrayBuffer");
    if (typeof FileReader !== "undefined") {
      readerTextSpy = vi.spyOn(FileReader.prototype, "readAsText");
      readerArrayBufferSpy = vi.spyOn(FileReader.prototype, "readAsArrayBuffer");
    }
  });

  it("renders only supplied finite safe-integer counts as counts without percentage or fake status", () => {
    render(
      <ImportFilePicker
        files={[]}
        onFilesChange={vi.fn()}
        isCurrent={() => true}
        progress={{ completed: 3, total: 10 }}
      />
    );

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("3 / 10");
    expect(status).toHaveTextContent("已完成 3 / 10");
    expect(status.textContent).not.toMatch(/%/);
    expect(status.textContent).not.toMatch(/30%/);
  });

  it("renders no claimed upload progress for absent or invalid/malformed counts", () => {
    const invalidProgressList = [
      null,
      undefined,
      { completed: -1, total: 10 },
      { completed: 11, total: 10 },
      { completed: 0, total: 0 },
      { completed: 1.5, total: 10 },
      { completed: 1, total: 10.5 },
      { completed: NaN, total: 10 },
      { completed: 1, total: Infinity },
    ];

    for (const invalidProgress of invalidProgressList) {
      const { unmount } = render(
        <ImportFilePicker
          files={[]}
          onFilesChange={vi.fn()}
          isCurrent={() => true}
          progress={invalidProgress as unknown as ImportFilePickerProps["progress"]}
        />
      );

      expect(screen.queryByRole("status")).toBeNull();
      unmount();
    }
  });

  it("never invokes synthetic file-content readers or network fetch", () => {
    const onFilesChange = vi.fn();
    const f1 = new File(["test-secret-payload"], "test.json", { lastModified: 1000 });

    const { rerender } = render(
      <ImportFilePicker
        files={[]}
        onFilesChange={onFilesChange}
        isCurrent={() => true}
      />
    );

    const input = screen.getByLabelText("选择导入文件");
    fireEvent.change(input, { target: { files: [f1] } });

    rerender(
      <ImportFilePicker
        files={[f1]}
        onFilesChange={onFilesChange}
        isCurrent={() => true}
      />
    );

    const dropZone = screen.getByRole("region", { name: "文件拖拽与选择区域" });
    const f2 = new File(["another-secret-payload"], "test2.json", { lastModified: 2000 });
    fireEvent.drop(dropZone, { dataTransfer: { files: [f2] } });

    const removeBtn = screen.getByRole("button", { name: "移除 test.json" });
    fireEvent.click(removeBtn);

    const clearBtn = screen.getByRole("button", { name: "清空全部" });
    fireEvent.click(clearBtn);

    if (fileTextSpy) expect(fileTextSpy).not.toHaveBeenCalled();
    if (fileArrayBufferSpy) expect(fileArrayBufferSpy).not.toHaveBeenCalled();
    if (readerTextSpy) expect(readerTextSpy).not.toHaveBeenCalled();
    if (readerArrayBufferSpy) expect(readerArrayBufferSpy).not.toHaveBeenCalled();
  });
});
