"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Copy } from "lucide-react";
import type { BroadcastCampaignDto } from "@azvchat/shared";
import { ApiError, broadcastApi } from "@/lib/api";
import { Button, Spinner } from "@/components/ui";
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
  const [copiando, setCopiando] = useState(false);
  const router = useRouter();

  async function editarCopia(id: string) {
    setCopiando(true);
    try {
      const copia = await broadcastApi.campaigns.duplicate(id);
      router.push(`/automations/broadcasts/${copia.id}/edit`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível duplicar a campanha");
      setCopiando(false);
    }
  }

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
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
          <p>
            Esta campanha já saiu do rascunho e não pode mais ser editada. Mudar o texto agora
            faria parte da lista receber um recado e o resto, outro. Edite uma cópia nova, com a
            mesma mensagem, audiência e ritmo — o histórico desta continua como está.
          </p>
          <Button
            className="mt-3"
            size="sm"
            disabled={copiando}
            onClick={() => void editarCopia(campaign.id)}
          >
            <Copy className="h-3.5 w-3.5" />
            Editar uma cópia
          </Button>
        </div>
      )}
    </div>
  );
}
