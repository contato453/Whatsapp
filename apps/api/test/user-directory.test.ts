import { describe, expect, it } from "vitest";
import type { Conversation, User } from "@azvchat/database";
import { serializeConversation, serializeUserDirectory } from "../src/lib/serialize.js";

function fakeUser(): User {
  return {
    id: "user-1",
    organizationId: "org-1",
    name: "Fulano",
    email: "fulano@example.com",
    passwordHash: "$2a$10$hash",
    role: "agent",
    status: "active",
    avatarUrl: null,
    signMessages: false,
    lastLoginAt: new Date("2026-01-01T10:00:00Z"),
    createdAt: new Date("2026-01-01T09:00:00Z"),
    updatedAt: new Date("2026-01-01T09:00:00Z"),
  } as unknown as User;
}

function fakeConversation(assignedUser: User | null): Conversation & { assignedUser: User | null } {
  return {
    id: "conv-1",
    organizationId: "org-1",
    whatsappInstanceId: "inst-1",
    externalChatId: "5511999@g.us",
    type: "group",
    title: "Cliente X",
    profilePicture: null,
    status: "open",
    assignedUserId: assignedUser?.id ?? null,
    departmentId: null,
    unreadCount: 0,
    lastMessageAt: null,
    lastMessagePreview: null,
    externalReference: null,
    externalSource: null,
    createdAt: new Date("2026-01-01T09:00:00Z"),
    assignedUser,
  } as unknown as Conversation & { assignedUser: User | null };
}

describe("serializeUserDirectory (usuário visto por terceiros)", () => {
  it("entrega apenas o necessário para exibir e atribuir", () => {
    expect(serializeUserDirectory(fakeUser())).toEqual({
      id: "user-1",
      name: "Fulano",
      role: "agent",
      status: "active",
      avatarUrl: null,
    });
  });

  it("nunca vaza dado de cadastro nem hash de senha", () => {
    const serialized = serializeUserDirectory(fakeUser()) as Record<string, unknown>;
    expect(serialized).not.toHaveProperty("email");
    expect(serialized).not.toHaveProperty("lastLoginAt");
    expect(serialized).not.toHaveProperty("passwordHash");
  });
});

describe("serializeConversation (responsável embutido)", () => {
  it("expõe o responsável na versão reduzida, sem e-mail", () => {
    const serialized = serializeConversation(fakeConversation(fakeUser()));
    expect(serialized.assignedUser).toEqual({
      id: "user-1",
      name: "Fulano",
      role: "agent",
      status: "active",
      avatarUrl: null,
    });
  });

  it("conversa sem responsável continua com null", () => {
    expect(serializeConversation(fakeConversation(null)).assignedUser).toBeNull();
  });
});
