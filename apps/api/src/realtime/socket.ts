import type { Server as HttpServer } from "node:http";
import { Server, type Socket } from "socket.io";
import type { Logger } from "pino";
import type { AuthTokenPayload, SessionVerifier } from "../lib/auth.js";

export interface VerifyToken {
  (token: string): AuthTokenPayload;
}

/** O que o usuário enxerga — `null` em instanceIds/departmentIds = admin. */
export interface RealtimeAccess {
  instanceIds: string[] | null;
  departmentIds: string[] | null;
}

export interface ResolveRealtimeAccess {
  (user: AuthTokenPayload): Promise<RealtimeAccess>;
}

/**
 * Camada de tempo real. As salas espelham exatamente as regras de acesso da
 * API — o que o usuário não pode buscar por HTTP também não chega no socket.
 *
 * - admin entra só na sala da organização e recebe tudo;
 * - supervisor entra nas salas dos números que tem, cruzadas com os
 *   departamentos dele;
 * - usuário comum entra nas mesmas salas, mas separadas entre "sem
 *   responsável" e "atribuída a mim", para não receber o atendimento que
 *   um colega já assumiu.
 *
 * Cada socket cai em um único grupo por evento, então não há entrega
 * duplicada.
 */
export function createRealtime(
  httpServer: HttpServer,
  options: {
    corsOrigins: string[];
    verifyToken: VerifyToken;
    verifySession: SessionVerifier;
    resolveAccess: ResolveRealtimeAccess;
    logger: Logger;
  },
): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: options.corsOrigins,
      credentials: true,
    },
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error("unauthorized"));
      return;
    }
    let payload: AuthTokenPayload;
    try {
      payload = options.verifyToken(token);
    } catch {
      next(new Error("unauthorized"));
      return;
    }
    // Mesma revalidação da API: token válido de usuário desativado não abre
    // conexão, e quem mudou de papel entra nas salas do papel atual.
    options
      .verifySession(payload)
      .then(async (user) => {
        socket.data.user = user;
        socket.data.access = await options.resolveAccess(user);
        next();
      })
      .catch((err) => {
        options.logger.warn({ event: "socket_access_failed", error: String(err) });
        next(new Error("unauthorized"));
      });
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as AuthTokenPayload;
    const access = socket.data.access as RealtimeAccess;

    // Sala pessoal: leitura de conversa é estado de uma pessoa e vai só para
    // as abas dela. Existe para a segunda aba acompanhar o que a primeira
    // leu — nunca para avisar a audiência da conversa.
    void socket.join(userRoom(user.sub));

    if (!access.instanceIds || !access.departmentIds) {
      // admin: organização inteira
      void socket.join(orgRoom(user.organizationId));
    } else {
      for (const instanceId of access.instanceIds) {
        joinInstanceRooms(socket, instanceId);
      }
      // Oportunidade do CRM sem conversa vinculada (lead que ainda não
      // escreveu) usa a MESMA máquina de salas com a chave de número
      // `"none"`. Reusar em vez de criar um esquema de salas só para o CRM
      // mantém uma régua só: departamento e responsável decidem igual nos
      // dois lados. Conversa sempre tem número de verdade (uuid), então
      // nenhuma mensagem cai nestas salas.
      joinInstanceRooms(socket, NO_INSTANCE);
    }

    options.logger.debug({ event: "socket_connected", userId: user.sub });
    socket.on("disconnect", () => {
      options.logger.debug({ event: "socket_disconnected", userId: user.sub });
    });
  });

  return io;
}

const NO_DEPARTMENT = "none";

/**
 * Chave de número das oportunidades do CRM sem conversa vinculada. Ver
 * `crmAudience` em `lib/crm-events.ts` e o `joinInstanceRooms` da conexão.
 */
export const NO_INSTANCE = "none";

/**
 * Salas de um número para um socket já autenticado. Conversa sem
 * departamento entra no balde "none" — é o caso de número sem departamento
 * padrão configurado.
 */
function joinInstanceRooms(socket: Socket, instanceId: string): void {
  const user = socket.data.user as AuthTokenPayload;
  const access = socket.data.access as RealtimeAccess;
  // Admin recebe tudo pela sala da organização; não usa sala por número.
  if (!access.departmentIds) return;

  // Eventos do próprio número (QR, status da conexão) não dependem de
  // departamento nem de responsável.
  void socket.join(instanceRoom(instanceId));
  for (const departmentKey of [...access.departmentIds, NO_DEPARTMENT]) {
    if (user.role === "supervisor") {
      void socket.join(supervisorRoom(instanceId, departmentKey));
    } else {
      void socket.join(unassignedRoom(instanceId, departmentKey));
      void socket.join(assigneeRoom(instanceId, departmentKey, user.sub));
    }
  }
}

/**
 * Acesso a número concedido no meio da sessão — hoje, o supervisor que
 * acabou de criar o número. As abas abertas dele entram nas salas na hora.
 *
 * Sem isso o QR Code, que se renova a cada poucos segundos, só chegaria
 * depois de recarregar a página: a pessoa ficaria encarando um código
 * vencido que o celular se recusa a ler.
 */
/**
 * Derruba as sessões de tempo real de um usuário. As salas são montadas na
 * conexão, então quem é desativado ou muda de papel continuaria recebendo
 * pelas regras antigas até fechar a aba. Na reconexão o handshake aplica o
 * estado atual — ou recusa, se a pessoa foi desativada.
 */
export function disconnectUser(io: Server, userId: string): void {
  for (const socket of io.sockets.sockets.values()) {
    const user = socket.data.user as AuthTokenPayload | undefined;
    if (user?.sub === userId) socket.disconnect(true);
  }
}

export function grantInstanceAccess(io: Server, userId: string, instanceId: string): void {
  for (const socket of io.sockets.sockets.values()) {
    const user = socket.data.user as AuthTokenPayload | undefined;
    if (user?.sub !== userId) continue;
    const access = socket.data.access as RealtimeAccess | undefined;
    if (access?.instanceIds && !access.instanceIds.includes(instanceId)) {
      access.instanceIds.push(instanceId);
    }
    joinInstanceRooms(socket, instanceId);
  }
}

export function orgRoom(organizationId: string): string {
  return `org:${organizationId}`;
}

/** Todas as abas de uma pessoa. Só leitura de conversa usa esta sala. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

export function instanceRoom(instanceId: string): string {
  return `instance:${instanceId}`;
}

function supervisorRoom(instanceId: string, departmentKey: string): string {
  return `sup:${instanceId}:${departmentKey}`;
}

function unassignedRoom(instanceId: string, departmentKey: string): string {
  return `free:${instanceId}:${departmentKey}`;
}

function assigneeRoom(instanceId: string, departmentKey: string, userId: string): string {
  return `mine:${instanceId}:${departmentKey}:${userId}`;
}

/**
 * Destinatários de um evento do número em si — QR Code e status da conexão.
 * Não carrega conteúdo de conversa, então basta ter o número liberado.
 */
export function instanceAudience(organizationId: string, instanceId: string): string[] {
  return [orgRoom(organizationId), instanceRoom(instanceId)];
}

/** O que o emissor precisa saber da conversa para calcular quem recebe. */
export interface ConversationAudienceRef {
  whatsappInstanceId: string;
  departmentId: string | null;
  assignedUserId: string | null;
}

/**
 * Destinatários de um evento de conversa: admin, os supervisores do
 * departamento que têm o número e, do lado dos usuários comuns, ou o
 * responsável atual ou todos quando ainda não há responsável.
 */
export function conversationAudience(
  organizationId: string,
  conversation: ConversationAudienceRef,
): string[] {
  const instanceId = conversation.whatsappInstanceId;
  const departmentKey = conversation.departmentId ?? NO_DEPARTMENT;
  return [
    orgRoom(organizationId),
    supervisorRoom(instanceId, departmentKey),
    conversation.assignedUserId
      ? assigneeRoom(instanceId, departmentKey, conversation.assignedUserId)
      : unassignedRoom(instanceId, departmentKey),
  ];
}
