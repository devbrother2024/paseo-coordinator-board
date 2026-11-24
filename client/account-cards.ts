import type { ProviderEntry } from "../shared/dispatch";
import { hasUsageReading, type AccountUsage } from "../shared/usage-routing";

export type AccountCard = {
  id: string; label: string; report?: AccountUsage; issue?: AccountUsage["issue"]; supplemental: boolean;
  // The provider this account's work runs on. The board assigns to providers, so an account is turned
  // on or off through its provider, and accounts under one provider change together.
  provider?: { id: string; label: string; included: boolean; shared: boolean };
};

// One card per account the host reports, then host-supplied display-only readings, then providers with
// no report at all, so every provider can be turned on or off.
export function accountCards(providers: readonly ProviderEntry[], reports: readonly AccountUsage[], supplemental: readonly AccountUsage[] = []) {
  const seen = new Set([...reports, ...supplemental].map(report => report.providerId));
  const added = new Set(supplemental.filter(hasUsageReading).map(report => report.providerId));
  const counts = new Map<string, number>();
  for (const report of reports) counts.set(report.providerId, (counts.get(report.providerId) ?? 0) + 1);
  const listed: Omit<AccountCard, "provider">[] = [
    ...reports.filter(report => !added.has(report.providerId) || hasUsageReading(report) || (counts.get(report.providerId) ?? 0) > 1)
      .map(report => ({ id: report.providerId, label: report.label, report, issue: report.issue, supplemental: false })),
    ...supplemental.map(report => ({ id: report.providerId, label: report.label, report, supplemental: true,
      issue: counts.get(report.providerId) === 1 ? reports.find(own => own.providerId === report.providerId)?.issue : undefined })),
    ...providers.filter(provider => !seen.has(provider.id)).map(provider => ({ id: provider.id, label: provider.label, report: undefined, supplemental: false })),
  ];
  const perProvider = new Map<string, number>();
  for (const card of listed) perProvider.set(card.id, (perProvider.get(card.id) ?? 0) + 1);
  const cards: AccountCard[] = listed.map(card => {
    // A reading for a provider this host does not run has nothing to turn on or off.
    const provider = providers.find(entry => entry.id === card.id);
    return provider ? { ...card, provider: { id: provider.id, label: provider.label, included: provider.included, shared: (perProvider.get(card.id) ?? 0) > 1 } } : card;
  });
  return { cards, allOff: providers.length > 0 && providers.every(provider => !provider.included) };
}
