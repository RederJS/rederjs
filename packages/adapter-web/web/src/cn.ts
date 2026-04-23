export type ClassValue = string | number | false | null | undefined | ClassValue[];

export function cn(...values: ClassValue[]): string {
  const out: string[] = [];
  const visit = (v: ClassValue): void => {
    if (!v && v !== 0) return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    out.push(String(v));
  };
  values.forEach(visit);
  return out.join(' ');
}
