"use client";

import { useAuth } from "@/lib/auth-context";
import { API_URL } from "@/lib/api";
import { Card } from "@/components/ui";

export default function SettingsPage() {
  const { user } = useAuth();

  return (
    <div className="thin-scroll h-full overflow-y-auto p-8">
      <h1 className="mb-6 text-2xl font-bold text-slate-900">Configurações</h1>
      <div className="max-w-xl space-y-4">
        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Minha conta
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">Nome</dt>
              <dd className="font-medium text-slate-900">{user?.name}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">E-mail</dt>
              <dd className="font-medium text-slate-900">{user?.email}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Papel</dt>
              <dd className="font-medium capitalize text-slate-900">{user?.role}</dd>
            </div>
          </dl>
        </Card>
        <Card className="p-6">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Sistema
          </h2>
          <dl className="space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-500">API</dt>
              <dd className="font-mono text-xs text-slate-700">{API_URL}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-500">Versão</dt>
              <dd className="font-medium text-slate-900">0.1.0 (MVP)</dd>
            </div>
          </dl>
        </Card>
      </div>
    </div>
  );
}
