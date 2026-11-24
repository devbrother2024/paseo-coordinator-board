import type { RouteChoice } from "../shared/dispatch";
import type { Operations } from "../shared/operations";
import { pickedRoute, routeEfforts, type ModelDirectory } from "./model-choices";

type Directory = ModelDirectory;

// A picked model the catalog stopped offering is dropped, so the confirmation never names a model that cannot be used.
export function offeredPick(data: Directory | null, picked: RouteChoice | null): RouteChoice | null {
  if (!data || !picked || !pickedRoute(data, "M", picked.provider, picked.model)) return null;
  return routeEfforts(data, picked).includes(picked.effort) ? picked : { ...picked, effort: null };
}

export function replacementMode(data: Pick<Operations, "catalog">, provider: string) {
  return data.catalog.find(m => m.provider === provider)?.coordinatorMode ?? null;
}

// A picked model is sent as the person's own choice. Otherwise the board's current route is confirmed as before.
export function replacementSelection(picked: RouteChoice | null, usual: RouteChoice | null, remember: boolean):
  { route: RouteChoice; selection?: "once" | "default" } | null {
  if (picked) return { route: picked, selection: remember ? "default" : "once" };
  return usual ? { route: usual } : null;
}
