import { getMachineId } from "@/shared/utils/machine";
import { getSettings } from "@/lib/db/settings";
import HomePageClient from "../dashboard/HomePageClient";
import BootstrapBanner from "../dashboard/BootstrapBanner";
import KimiSponsorBanner from "../dashboard/KimiSponsorBanner";
import CheaperInferenceSponsorBanner from "../dashboard/CheaperInferenceSponsorBanner";
import VscodeCopilotBanner from "../dashboard/VscodeCopilotBanner";
import NewsBanner from "../dashboard/NewsBanner";
import FirstRunReadinessCard from "../dashboard/FirstRunReadinessCard";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Even if getSettings() rejects, getMachineId() runs concurrently, which is acceptable
  // as both paths fail-fast on error and avoids the waterfall penalty.
  // Defense-in-depth (#14060): getSettings() already degrades to defaults on a corrupted
  // key_value table, but a future unguarded read anywhere in its dependency chain should
  // not be able to crash this Server Component render again.
  const [settings, machineId] = await Promise.all([
    getSettings().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[Home] Failed to load settings; using defaults: ${message}`);
      return { setupComplete: false };
    }),
    getMachineId(),
  ]);
  const isBootstrapped = process.env.OMNIROUTE_BOOTSTRAPPED === "true";
  return (
    <>
      {isBootstrapped && <BootstrapBanner />}
      <FirstRunReadinessCard setupComplete={Boolean(settings.setupComplete)} />
      <KimiSponsorBanner />
      <CheaperInferenceSponsorBanner />
      <VscodeCopilotBanner />
      <NewsBanner />
      <HomePageClient machineId={machineId} />
    </>
  );
}
