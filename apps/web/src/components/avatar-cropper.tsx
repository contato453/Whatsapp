"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Button } from "@/components/ui";

/**
 * Recorte da foto de perfil, com zoom e arraste.
 *
 * O recorte acontece aqui, no navegador: a API recebe a imagem já quadrada
 * e pequena. Isso evita subir foto de 8 MB de celular só para depois cortar,
 * e mantém o servidor sem dependência de processamento de imagem.
 */

/** Lado da imagem final, em pixels. Suficiente para telas retina. */
const OUTPUT_SIZE = 256;
/** Lado da área de recorte na tela. */
const VIEW_SIZE = 260;

export function AvatarCropper({
  file,
  onCancel,
  onConfirm,
}: {
  file: File | null;
  onCancel: () => void;
  onConfirm: (blob: Blob) => Promise<void> | void;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!file) {
      setImage(null);
      return;
    }
    setError(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    const url = URL.createObjectURL(file);
    const element = new Image();
    element.onload = () => setImage(element);
    element.onerror = () => setError("Não consegui abrir esta imagem.");
    element.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  /**
   * Escala que faz a imagem cobrir a área de recorte inteira. Todo o resto
   * é relativo a ela, então o zoom 1 nunca deixa buraco nas bordas.
   */
  const baseScale = image ? Math.max(VIEW_SIZE / image.width, VIEW_SIZE / image.height) : 1;

  /** Impede arrastar para além da imagem, o que deixaria borda vazia. */
  const clamp = useCallback(
    (next: { x: number; y: number }, currentZoom: number) => {
      if (!image) return next;
      const scaled = baseScale * currentZoom;
      const limitX = Math.max(0, (image.width * scaled - VIEW_SIZE) / 2);
      const limitY = Math.max(0, (image.height * scaled - VIEW_SIZE) / 2);
      return {
        x: Math.min(limitX, Math.max(-limitX, next.x)),
        y: Math.min(limitY, Math.max(-limitY, next.y)),
      };
    },
    [image, baseScale],
  );

  useEffect(() => {
    setOffset((current) => clamp(current, zoom));
  }, [zoom, clamp]);

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>) {
    dragRef.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    const start = dragRef.current;
    if (!start) return;
    setOffset(clamp({ x: event.clientX - start.x, y: event.clientY - start.y }, zoom));
  }

  function onPointerUp() {
    dragRef.current = null;
  }

  async function confirm() {
    if (!image) return;
    setBusy(true);
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = OUTPUT_SIZE;
      canvas.height = OUTPUT_SIZE;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas indisponível");

      // Mesma transformação da prévia, na proporção da imagem final.
      const ratio = OUTPUT_SIZE / VIEW_SIZE;
      const scaled = baseScale * zoom * ratio;
      const width = image.width * scaled;
      const height = image.height * scaled;
      context.drawImage(
        image,
        OUTPUT_SIZE / 2 - width / 2 + offset.x * ratio,
        OUTPUT_SIZE / 2 - height / 2 + offset.y * ratio,
        width,
        height,
      );

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", 0.9),
      );
      if (!blob) throw new Error("Falha ao gerar a imagem");
      await onConfirm(blob);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Falha ao recortar a imagem");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={file != null} onClose={onCancel} title="Ajustar foto">
      <div className="space-y-4">
        <p className="text-xs text-slate-500">
          Arraste para posicionar e use o controle para aproximar. A área em destaque é o que
          aparece.
        </p>

        <div className="flex justify-center">
          <div
            className="relative cursor-grab overflow-hidden rounded-full bg-slate-100 active:cursor-grabbing"
            style={{ width: VIEW_SIZE, height: VIEW_SIZE, touchAction: "none" }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            {image && (
              <img
                src={image.src}
                alt="Prévia da foto"
                draggable={false}
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none"
                style={{
                  width: image.width * baseScale * zoom,
                  height: image.height * baseScale * zoom,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                }}
              />
            )}
          </div>
        </div>

        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="mt-1 w-full accent-brand-600"
          />
        </label>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex gap-2">
          <Button className="flex-1 justify-center" disabled={!image || busy} onClick={() => void confirm()}>
            Salvar foto
          </Button>
          <Button variant="outline" className="flex-1 justify-center" disabled={busy} onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  );
}
