"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type { PermissionAction } from "@azvchat/shared";
import { api, getToken, setToken } from "./api";
import type { UserDto } from "./types";

interface AuthContextValue {
  user: UserDto | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  /** Aplica a sessão devolvida quando a pessoa edita o próprio perfil. */
  setSession: (token: string, user: UserDto) => void;
  /** Atualiza os dados do usuário sem trocar o token (troca de foto). */
  setUser: (user: UserDto) => void;
  /**
   * A pessoa pode executar esta ação?
   *
   * Vem da lista que a API resolveu (catálogo + configuração da
   * organização), nunca deduzida do papel: deduzir faria a tela de
   * Permissões virar mentira visual. Enquanto a sessão carrega, e para quem
   * não está logado, a resposta é `false` — o lado seguro do erro.
   */
  can: (action: PermissionAction) => boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api
      .get<{ user: UserDto }>("/auth/me")
      .then((data) => setUser(data.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const data = await api.post<{ token: string; user: UserDto }>("/auth/login", {
        email,
        password,
      });
      setToken(data.token);
      setUser(data.user);
      router.push("/dashboard");
    },
    [router],
  );

  const logout = useCallback(() => {
    void api.post("/auth/logout").catch(() => undefined);
    setToken(null);
    setUser(null);
    router.push("/login");
  }, [router]);

  const setSession = useCallback((token: string, next: UserDto) => {
    setToken(token);
    setUser(next);
  }, []);

  const updateUser = useCallback((next: UserDto) => setUser(next), []);

  const can = useCallback(
    (action: PermissionAction) => user?.permissions.includes(action) ?? false,
    [user],
  );

  const value = useMemo(
    () => ({ user, loading, login, logout, setSession, setUser: updateUser, can }),
    [user, loading, login, logout, setSession, updateUser, can],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth deve ser usado dentro de AuthProvider");
  return context;
}
