import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
export class LoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div role="alert" className="space-y-4 rounded-lg border p-6">
      <h1 className="text-lg font-semibold">页面暂时无法加载</h1>
      <p className="text-sm text-muted-foreground">连接可能中断，或页面已有新版本。请刷新后重试；未保存的内容可能丢失。</p>
      <Button onClick={() => window.location.reload()}>刷新页面</Button>
    </div>;
    return this.props.children;
  }
}
