import { join } from "node:path";

const names = {
  ko: "코디네이터 운영 (삭제 금지)",
  en: "Coordinator operations (do not delete)",
};

export function operatingDirectory(parent: string, language?: keyof typeof names) {
  return join(parent, language === undefined ? "coordinator-board" : names[language]);
}

export function operatingDirectories(parent: string) {
  return [operatingDirectory(parent), operatingDirectory(parent, "ko"), operatingDirectory(parent, "en")];
}
