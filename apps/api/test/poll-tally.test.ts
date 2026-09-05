import { describe, expect, it } from "vitest";
import { tallyPollVotes, type PollVotes } from "@azvchat/shared";

describe("tallyPollVotes", () => {
  const options = ["Manhã", "Tarde", "Noite"];

  it("conta uma pessoa por opção e o total de votantes", () => {
    const votes: PollVotes = {
      "5511": { names: ["Manhã"], voterName: "Ana", at: "2026-01-01T00:00:00Z" },
      "5522": { names: ["Manhã", "Tarde"], voterName: "Bruno", at: "2026-01-01T00:00:00Z" },
    };
    const tally = tallyPollVotes(options, votes);
    expect(tally.totalVoters).toBe(2);
    expect(tally.options.find((o) => o.option === "Manhã")?.count).toBe(2);
    expect(tally.options.find((o) => o.option === "Tarde")?.count).toBe(1);
    expect(tally.options.find((o) => o.option === "Noite")?.count).toBe(0);
    expect(tally.options.find((o) => o.option === "Manhã")?.voters).toEqual(["Ana", "Bruno"]);
  });

  it("votante que limpou a escolha não conta", () => {
    const votes: PollVotes = {
      "5511": { names: [], voterName: "Ana", at: "2026-01-02T00:00:00Z" },
    };
    expect(tallyPollVotes(options, votes).totalVoters).toBe(0);
  });

  it("sem votos, todas as opções vêm com zero", () => {
    const tally = tallyPollVotes(options, undefined);
    expect(tally.totalVoters).toBe(0);
    expect(tally.options.map((o) => o.count)).toEqual([0, 0, 0]);
  });
});
