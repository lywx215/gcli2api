import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { RouteId } from "./routes";
import { routes } from "./routes";
export default function PlaceholderPage({ route }: { route: RouteId }) {
  const current = routes.find(item => item.id === route)!;
  return <Card className="max-w-3xl">
    <CardHeader><CardTitle>{current.title}</CardTitle><CardDescription>{current.description}</CardDescription></CardHeader>
    <CardContent><p className="text-sm text-muted-foreground">此页面正在接入。当前仅提供新版导航与登录，可从侧栏访问现有控制面板。</p></CardContent>
  </Card>;
}
