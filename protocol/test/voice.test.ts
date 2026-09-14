import { describe, expect, it } from "vitest";
import { detectLanguage, inQuietHours } from "../src/voice.ts";

describe("detectLanguage", () => {
  it("tells Portuguese from English in the sentences Loom reads", () => {
    for (const pt of [
      "Faye quer rodar git push no ruleshub",
      "Terminei a tarefa e todos os testes passaram.",
      "Precisa de aprovação para editar o arquivo",
      "não",
      "A sessão falhou",
    ]) {
      expect(detectLanguage(pt), pt).toBe("pt");
    }
    for (const en of [
      "Faye wants to run git push on ruleshub",
      "I finished the task and all tests pass.",
      "Needs approval to edit the file",
      "",
      "Cleo is done",
    ]) {
      expect(detectLanguage(en), en).toBe("en");
    }
  });
});

describe("inQuietHours", () => {
  const at = (h: number, m = 0) => new Date(2026, 8, 13, h, m);
  it("handles windows within a day and across midnight", () => {
    expect(inQuietHours({ from: "22:00", to: "07:00" }, at(23))).toBe(true);
    expect(inQuietHours({ from: "22:00", to: "07:00" }, at(6, 59))).toBe(true);
    expect(inQuietHours({ from: "22:00", to: "07:00" }, at(7))).toBe(false);
    expect(inQuietHours({ from: "12:00", to: "13:30" }, at(13, 15))).toBe(true);
    expect(inQuietHours({ from: "12:00", to: "13:30" }, at(14))).toBe(false);
    expect(inQuietHours(undefined, at(3))).toBe(false);
  });
});
