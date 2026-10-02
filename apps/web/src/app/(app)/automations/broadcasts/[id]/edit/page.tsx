"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import type { BroadcastCampaignDto } from "@azvchat/shared";
import { ApiError, broadcastApi } from "@/lib/api";
import { Spinner } from "@/components/ui";
import { CampaignForm } from "@/components/broadcasts/campaign-form";
import { BroadcastHeader } from "@/components/broadcasts/broadcast-ui";

/**
 * Editar SÓ vale para o rascunho, e quem decide isso é a API (`campaign_locked`).
 * A tela avisa antes em vez de deixar a pessoa reescrever o texto inteiro para
 * levar 409 no botão salvar — depois de começar, mudar a mensagem faria metade
 * da lista receber um recado e a outra metade, outro.
 */
export default function EditBroadcastPage() {
  const params = useParams<{ id: string }>();
  const [campaign, setCampaign] = useState<BroadcastCampaignDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setCampaign(await broadcastApi.campaigns.get(params.id));
      } catch (err) {
        setError(err instanceof ApiError ? err.message : "Não foi possível carregar a campanha");
      }
    })();
  }, [params.id]);

  if (error) return <p className="p-6 text-sm text-red-600 lg:p-8">{error}</p>;
  if (!campaign) {
    return (
      <div className="flex h-full items-center justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="thin-scroll h-full overflow-y-auto p-6 lg:p-8">
      <Link
        href={`/automations/broadcasts/${campaign.id}`}
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800"
      >
        <ArrowLeft className="h-4 w-4" />
        Voltar para a campanha
      </Link>
      <BroadcastHeader title="Editar campanha" description={campaign.name} />
      {campaign.status === "draft" ? (
        <CampaignForm campaign={campaign} />
      ) : (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          Esta campanha já saiu do rascunho e não pode mais ser editada. Mudar o texto agora
          faria parte da lista receber um recado e o resto, outro. Duplique numa campanha nova
          para mandar a versão corrigida a quem ainda não recebeu.
        </p>
      )}
    </div>
  );
}
