import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  getPanelChannelSnapshot,
  subscribePanelChannel,
  type PanelMode,
} from "@/domain/panel";
import {
  getAcceptedPanelRouteSnapshot,
  navigatePanel,
  subscribeAcceptedPanelRoute,
} from "./routes";

export interface PanelChannelContextValue {
  mode: PanelMode;
  channelEpoch: number;
  changeMode(mode: PanelMode): void;
}

const PanelChannelContext = createContext<PanelChannelContextValue | null>(null);

export function PanelChannelProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    return subscribeAcceptedPanelRoute(() => {});
  }, []);

  const coreSnapshot = useSyncExternalStore(
    subscribePanelChannel,
    getPanelChannelSnapshot,
    getPanelChannelSnapshot
  );

  const changeMode = useCallback((mode: PanelMode) => {
    const routeSnapshot = getAcceptedPanelRouteSnapshot();
    navigatePanel(routeSnapshot.route, mode);
  }, []);

  const value = useMemo<PanelChannelContextValue>(
    () => ({
      mode: coreSnapshot.mode,
      channelEpoch: coreSnapshot.channelEpoch,
      changeMode,
    }),
    [coreSnapshot.mode, coreSnapshot.channelEpoch, changeMode]
  );

  return (
    <PanelChannelContext.Provider value={value}>
      {children}
    </PanelChannelContext.Provider>
  );
}

export function usePanelChannel(): PanelChannelContextValue {
  const context = useContext(PanelChannelContext);
  if (!context) {
    throw new Error("usePanelChannel must be used within a PanelChannelProvider");
  }
  return context;
}
