"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { io, type Socket } from "socket.io-client";
import { API_URL, getToken } from "./api";
import { useAuth } from "./auth-context";

const SocketContext = createContext<Socket | null>(null);

/** Mantém uma conexão Socket.IO autenticada enquanto o usuário estiver logado. */
export function SocketProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [socket, setSocket] = useState<Socket | null>(null);

  useEffect(() => {
    if (!user) {
      socketRef.current?.disconnect();
      socketRef.current = null;
      setSocket(null);
      return;
    }
    const instance = io(API_URL, {
      auth: { token: getToken() },
      transports: ["websocket", "polling"],
    });
    socketRef.current = instance;
    setSocket(instance);
    return () => {
      instance.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [user]);

  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>;
}

export function useSocket(): Socket | null {
  return useContext(SocketContext);
}
