"use client";

import { CampaignForm } from "@/components/broadcasts/campaign-form";
import { BroadcastHeader, BroadcastWarning } from "@/components/broadcasts/broadcast-ui";

export default function NewBroadcastPage() {
  return (
    <div className="thin-scroll h-full overflow-y-auto p-6 lg:p-8">
      <BroadcastHeader
        title="Nova campanha"
        description="Monte o disparo. Nada sai daqui: a campanha nasce em rascunho."
      />
      <BroadcastWarning />
      <CampaignForm />
    </div>
  );
}
