"use client";

import { createContext, memo, useContext } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, useReactFlow, type EdgeProps } from "@xyflow/react";
import { X } from "lucide-react";

export const FLOW_EDGE_TYPE = "automationEdge";

/**
 * O construtor abre em somente leitura para quem só enxerga o fluxo (geral sem
 * a chave de alcance geral). A linha não pode oferecer o "x" nesse caso: o
 * clique apagaria na tela e o autosave, desligado, nunca gravaria — a pessoa
 * veria a ligação sumir e voltar no próximo carregamento.
 */
export const FlowEditableContext = createContext(true);

/**
 * Ligação entre dois blocos que pode ser apagada SOZINHA. Antes, a única forma
 * de desfazer uma ligação errada era excluir o bloco inteiro (que leva todas as
 * linhas dele junto) e montá-lo de novo. Agora: clicar na linha a seleciona e
 * mostra o "x" no meio dela; Delete/Backspace também apagam a selecionada.
 */
function FlowEdgeComponent({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  selected,
}: EdgeProps) {
  const editable = useContext(FlowEditableContext);
  const { deleteElements } = useReactFlow();
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        // A área de clique é bem mais larga que o traço: acertar uma linha de
        // 1px com o mouse seria o que faria a pessoa desistir de apagá-la.
        interactionWidth={24}
        style={{
          ...style,
          strokeWidth: selected ? 2.5 : 1.5,
          stroke: selected ? "#dc2626" : style?.stroke,
        }}
      />
      {editable && selected && (
        <EdgeLabelRenderer>
          <button
            type="button"
            title="Apagar ligação"
            aria-label="Apagar ligação"
            onClick={(event) => {
              event.stopPropagation();
              // deleteElements passa pelo onEdgesChange da página, o mesmo caminho do
              // Delete no teclado: o autosave enxerga a mudança como qualquer outra.
              void deleteElements({ edges: [{ id }] });
            }}
            className="nodrag nopan flex h-6 w-6 items-center justify-center rounded-full border border-red-300 bg-white text-red-600 shadow-sm hover:bg-red-50"
            // Posição e clique ficam no style, como na documentação do React Flow: a
            // camada de rótulos nasce com pointer-events desligado, e o botão precisa
            // religá-lo por conta própria para o clique não cair na linha embaixo.
            style={{
              position: "absolute",
              pointerEvents: "all",
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const FlowEdge = memo(FlowEdgeComponent);
