import { redirect } from "next/navigation";

/**
 * `/crm` cai no Kanban, que é onde o trabalho acontece.
 *
 * O menu lateral aponta para cá (e não direto para `/crm/kanban`) para que o
 * dia em que a tela inicial do CRM mudar — um painel de indicadores, por
 * exemplo — só este arquivo precise mudar, sem quebrar favoritos.
 */
export default function CrmIndexPage() {
  redirect("/crm/kanban");
}
